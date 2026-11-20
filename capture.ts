/**
 * One live log capture: a long-running child process whose stdout/stderr is
 * normalized into an indexed ring buffer, mirrored to a log file, and read
 * back through a cursor so the agent can fetch only what is new.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, createReadStream, createWriteStream, statSync, type WriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { timestamp } from "./exec.ts";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_BUFFER_LINES = 20_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_LOG_FILES = 3;
const MAX_DRAIN_MS = 2_000;

export type CaptureMode = "console" | "syslog";

export interface LogLine {
  index: number;
  at: number;
  stream: "out" | "err";
  text: string;
}

/** A line as a search returns it: one read back from disk has no stream. */
export type FoundLine = Pick<LogLine, "index" | "at" | "text"> & Partial<Pick<LogLine, "stream">>;

export interface CaptureInit {
  mode: CaptureMode;
  deviceId: string;
  deviceLabel: string;
  bundleId: string;
  processName?: string;
  /** App process id when known (launch); never the bridge pid. */
  appPid?: number;
  logDir: string;
  command: string;
  args: string[];
  /** Collect the native console launch's raw command result, outside the log stream. */
  collectLaunchResult?: boolean;
  /** Reuse an existing log file (used when auto-reconnecting a dropped bridge). */
  logFile?: string;
  /** How new lines are mirrored into the session; the reconnect path restarts it. */
  pushMode?: "context" | "wake";
}

export interface CaptureStatus {
  id: string;
  mode: CaptureMode;
  device: string;
  bundleId: string;
  processName?: string;
  /** Bridge process id (devicectl/idevicesyslog). */
  pid?: number;
  /** App process id on the device, when known. */
  appPid?: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
  startedAt: number;
  lineCount: number;
  droppedLines: number;
  cursor: number;
  logFile: string;
  /** Retained segments in chronological order; logFile is their stable base path. */
  logFiles: string[];
  commandLine: string;
  error?: string;
  relaunches: number;
  endReason?: string;
  crashReport?: string;
  terminationReason?: string;
}

function clean(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

function clampLimit(limit: number | undefined): number {
  return Math.trunc(Math.min(Math.max(1, limit ?? 200), 5_000));
}

/** A filter is a substring, or a pattern when the caller asked for one. */
export function matchesFilter(text: string, filter: string | RegExp): boolean {
  return typeof filter === "string" ? text.includes(filter) : filter.test(text);
}

function sizeOnDisk(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function removeLaunchResultDirectory(path: string): Promise<void> {
  const directory = await lstat(path);
  if (!directory.isDirectory()) throw new Error("owned result path is not a real directory");
  const entries = (await readdir(path)).sort();
  if (entries.some(name => name !== "owner.json" && name !== "launch.json")) {
    throw new Error("owned result directory contains an unexpected entry");
  }
  const files = [];
  for (const name of entries) {
    const filePath = join(path, name);
    const file = await lstat(filePath);
    if (!file.isFile()) throw new Error("owned result payload is not a real file");
    files.push({ path: filePath, stat: file });
  }
  for (const file of files) {
    const currentDirectory = await lstat(path);
    const currentFile = await lstat(file.path);
    if (!currentDirectory.isDirectory() || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino ||
        !currentFile.isFile() || currentFile.dev !== file.stat.dev || currentFile.ino !== file.stat.ino) {
      throw new Error("owned result path changed during cleanup");
    }
    await unlink(file.path);
  }
  await rmdir(path);
}

export class Capture {
  readonly id: string;
  readonly mode: CaptureMode;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly bundleId: string;
  readonly processName?: string;
  /** Operational live PID; exit diagnosis replaces it with the owned launch result's PID. */
  appPid?: number;
  readonly startedAt = Date.now();
  readonly logFile: string;

  readonly command: string;
  readonly launchArgs: string[];
  /** One owned native command result per bridge start; absent for generic captures. */
  launchResult?: Promise<string | undefined>;
  private readonly collectLaunchResult: boolean;
  private spawnedArgs: string[];
  private shuttingDown = false;
  private readonly startups = new Set<Promise<void>>();
  private readonly resultJobs = new Set<{ done: Promise<void>; cancel: () => void }>();
  /** Failed result removals survive reattachment and history eviction until session shutdown reports them. */
  launchResultCleanupErrors?: string[];
  /** Set when the user explicitly stops this capture, so auto-reconnect stays off. */
  stoppedByUser = false;
  /**
   * How this capture mirrors new lines into the session. Kept on the capture so
   * a reconnected bridge resumes the same push mode instead of going silent.
   */
  pushMode?: "context" | "wake";
  /** Log filter the push was started with, so a resume keeps it. */
  pushMatch?: string;
  /**
   * When the bridge last produced a line, in epoch ms.
   *
   * Lives on the capture, not on the push loop: a silence watchdog has to work
   * whether or not lines are being mirrored into the session, and `push=off`
   * never starts that loop. Initialised at construction so a bridge that never
   * emits anything still ages from a sane starting point.
   */
  lastLineAt = Date.now();
  /**
   * Times the console bridge was reattached. devicectl attaches a console only
   * by launching, so each one restarted the app and dropped its state.
   */
  relaunches = 0;
  /** Why the capture ended without being asked to. */
  endReason?: string;
  /** The crash report pulled from the device after the app died, if it left one. */
  crashReport?: string;
  terminationReason?: string;
  /** Bridge exit time before any stop, retained through drain and report collection. */
  naturalExitAt?: number;
  /**
   * Aborted when this capture is stopped, so an in-flight device probe returns
   * at once instead of running out its own timeout first.
   */
  readonly abort = new AbortController();
  private child: ChildProcess | undefined;
  private file: WriteStream | undefined;
  private readonly lines: Array<LogLine | undefined> = new Array(MAX_BUFFER_LINES);
  private head = 0;
  private lineCount = 0;
  private bufferBytes = 0;
  private droppedLines = 0;
  private cursor = 0;
  private buffered: { out: string; err: string } = { out: "", err: "" };
  private exitCode: number | undefined;
  private exitSignal: string | undefined;
  private error: string | undefined;
  private fileBytes = 0;
  private fileNumber = 0;
  private fileOrder = 0;
  private readonly logFiles = new Map<string, number>();
  /** Only overwriting an existing segment invalidates an in-flight disk scan. */
  private readonly fileVersions = new Map<string, number>();
  /**
   * Where each run of consecutively indexed lines starts on disk. The files
   * carry no index and have holes - a rotated segment is overwritten, and a
   * write that fails takes its lines with it - so a line's index is only
   * recoverable per run.
   */
  private runs: Array<{ path: string; offset: number; index: number }> = [];
  /** The segment being written, and where its next run starts once a line arrives. */
  private segment = "";
  private opened: { path: string; offset: number } | undefined;
  /** True while lines are appended with the bridge down, which is one run. */
  private appending = false;
  private readonly files = new Set<WriteStream>();
  private readonly blockedFiles = new Set<WriteStream>();
  private readonly exitListeners = new Set<(code: number | undefined, signal: string | undefined) => void>();
  private readonly processExitListeners = new Set<(code: number | undefined, signal: string | undefined) => void>();
  private readonly lineListeners = new Set<(line: LogLine) => void>();

  constructor(init: CaptureInit) {
    this.id = `${init.mode}-${Date.now().toString(36)}`;
    this.mode = init.mode;
    this.deviceId = init.deviceId;
    this.deviceLabel = init.deviceLabel;
    this.bundleId = init.bundleId;
    this.processName = init.processName;
    this.appPid = init.appPid;
    this.pushMode = init.pushMode;
    this.command = init.command;
    this.launchArgs = init.args;
    this.collectLaunchResult = init.mode === "console" && init.collectLaunchResult === true;
    this.spawnedArgs = this.launchArgs;
    this.logFile =
      init.logFile ?? `${init.logDir}/${init.mode}-${init.bundleId}-${timestamp()}.log`;
  }

  /** Remain live until the pipes and file writes drain, or their deadline expires. */
  get running(): boolean {
    return this.child !== undefined;
  }

  get starting(): boolean {
    return this.startups.size > 0;
  }

  get processExited(): boolean {
    return this.child
      ? this.child.exitCode !== null || this.child.signalCode !== null
      : this.exitCode !== undefined || this.exitSignal !== undefined;
  }

  /** Clear the terminal state so start() can attach a fresh bridge. */
  resetForReconnect(): void {
    this.exitCode = undefined;
    this.exitSignal = undefined;
    this.error = undefined;
    this.endReason = undefined;
    this.crashReport = undefined;
    this.terminationReason = undefined;
    this.naturalExitAt = undefined;
    this.buffered = { out: "", err: "" };
    // A fresh bridge starts its silence clock now, or the watchdog would see the
    // gap it just repaired and immediately restart the new bridge too.
    this.lastLineAt = Date.now();
  }

  /** Observe process exit before the pipes and writers finish draining. */
  onProcessExit(listener: (code: number | undefined, signal: string | undefined) => void): () => void {
    this.processExitListeners.add(listener);
    return () => this.processExitListeners.delete(listener);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  onExit(listener: (code: number | undefined, signal: string | undefined) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Subscribe to every new line. Used by the wait primitive instead of polling. */
  onLine(listener: (line: LogLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    let resolveStartup!: () => void;
    const startup = new Promise<void>(resolve => { resolveStartup = resolve; });
    this.startups.add(startup);
    const operation = this.startRun(signal);
    const complete = (): void => {
      this.startups.delete(startup);
      resolveStartup();
    };
    void operation.then(complete, complete);
    return operation;
  }

  private async startRun(signal?: AbortSignal): Promise<void> {
    let resultDir: string | undefined;
    let resolveResult: ((raw: string | undefined) => void) | undefined;
    let resolveCleanup: (() => void) | undefined;
    let resultJob: { done: Promise<void>; cancel: () => void } | undefined;
    let collecting = false;
    const resultAbort = this.collectLaunchResult ? new AbortController() : undefined;
    if (resultAbort) {
      // Node 20's Promise API requires an executor; it has no withResolvers().
      this.launchResult = new Promise((resolve) => { resolveResult = resolve; });
      resultJob = {
        done: new Promise(resolve => { resolveCleanup = resolve; }),
        cancel: () => resultAbort.abort(),
      };
      this.resultJobs.add(resultJob);
    }
    const result = this.launchResult;
    // Exit diagnosis outlives stop/reconnect; only session shutdown cancels its read.
    const collectResult = async (): Promise<void> => {
      if (!resolveResult || !resultAbort || collecting) return;
      collecting = true;
      let raw: string | undefined;
      let onAbort: (() => void) | undefined;
      try {
        if (resultDir && !resultAbort.signal.aborted) {
          raw = await Promise.race([
            readFile(join(resultDir, "launch.json"), { encoding: "utf8", signal: resultAbort.signal }).catch(() => undefined),
            new Promise<undefined>(resolve => {
              onAbort = () => resolve(undefined);
              resultAbort.signal.addEventListener("abort", onAbort, { once: true });
              if (resultAbort.signal.aborted) onAbort();
            }),
          ]);
        }
      } catch {
        // A killed console or failed spawn may never produce a command result.
      } finally {
        if (onAbort) resultAbort.signal.removeEventListener("abort", onAbort);
        if (resultDir) await removeLaunchResultDirectory(resultDir).catch(error => {
          const detail = `launch result cleanup failed: ${resultDir}: ${error instanceof Error ? error.message : String(error)}`;
          (this.launchResultCleanupErrors ??= []).push(detail);
          if (this.launchResult !== result) return;
          this.error = this.error ? `${this.error}; ${detail}` : detail;
        });
        resolveResult(resultAbort.signal.aborted ? undefined : raw);
        if (resultJob) this.resultJobs.delete(resultJob);
        resolveCleanup?.();
      }
    };
    let child: ChildProcess;
    try {
      await mkdir(dirname(this.logFile), { recursive: true });
      signal?.throwIfAborted();
      if (this.stoppedByUser || this.shuttingDown) { await collectResult(); return; }
      let args = this.launchArgs;
      if (this.collectLaunchResult) {
        resultDir = await mkdtemp(join(dirname(this.logFile), ".xcodebug-launch-"));
        signal?.throwIfAborted();
        if (this.stoppedByUser || this.shuttingDown) { await collectResult(); return; }
        await writeFile(join(resultDir, "owner.json"), JSON.stringify({
          kind: "xcodebug.launch-result", version: 1, pid: process.pid, createdAt: Date.now(),
        }), { mode: 0o600, flag: "wx" });
        signal?.throwIfAborted();
        if (this.stoppedByUser || this.shuttingDown) { await collectResult(); return; }
        const consoleIndex = args.indexOf("--console");
        const separatorIndex = args.indexOf("--");
        const index = consoleIndex >= 0 ? consoleIndex : separatorIndex >= 0 ? separatorIndex : args.length;
        args = args.slice();
        args.splice(index, 0, "--json-output", join(resultDir, "launch.json"));
      }
      this.openFile(true);
      this.spawnedArgs = args;
      child = spawn(this.command, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
    } catch (error) {
      await collectResult();
      throw error;
    }
    let finishing = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const drainAbort = new AbortController();
    const complete = (code: number | undefined, signal: string | undefined): void => {
      if (this.child !== child) return;
      clearTimeout(drainTimer);
      this.exitCode = code;
      this.exitSignal = signal;
      this.child = undefined;
      for (const listener of this.exitListeners) {
        try {
          listener(code, signal);
        } catch {
          // A listener must never break capture teardown.
        }
      }
    };
    const beginDrain = (code: number | undefined, signal: string | undefined): void => {
      if (this.child !== child || drainTimer) return;
      drainTimer = setTimeout(() => {
        this.error = `log drain timed out after ${MAX_DRAIN_MS}ms; pending logs may be truncated`;
        finishing = true;
        this.file = undefined;
        for (const file of this.files) file.destroy();
        this.files.clear();
        this.blockedFiles.clear();
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.flush("out");
        this.flush("err");
        drainAbort.abort();
        complete(code, signal);
      }, MAX_DRAIN_MS);
    };
    const finish = (code: number | undefined, signal: string | undefined): void => {
      if (this.child !== child || finishing) return;
      finishing = true;
      beginDrain(code, signal);
      const writes = [...this.files].map((file) => {
        const done = finished(file, { cleanup: true, signal: drainAbort.signal }).catch(() => {});
        if (!file.writableEnded) file.end();
        return done;
      });
      this.file = undefined;
      void Promise.all(writes).then(() => complete(code, signal));
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.child === child) this.consume("out", chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (this.child === child) this.consume("err", chunk);
    });
    child.on("error", (error: Error) => {
      void collectResult();
      if (this.child !== child) return;
      this.error = error.message;
      this.pushLine("err", `[xcodebug] failed to start: ${error.message}`);
      finish(undefined, undefined);
    });
    // `close` can itself wait forever while a backed-up writer pauses the pipes.
    child.on("exit", (code, signal) => {
      void collectResult();
      if (this.child !== child) return;
      if (!this.stoppedByUser) this.naturalExitAt = Date.now();
      beginDrain(code ?? undefined, signal ?? undefined);
      for (const listener of this.processExitListeners) {
        try { listener(code ?? undefined, signal ?? undefined); } catch {
          // A listener must never break capture teardown.
        }
      }
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) return;
      this.flush("out");
      this.flush("err");
      finish(code ?? undefined, signal ?? undefined);
    });
  }

  private openFile(append: boolean): void {
    const path = this.fileNumber === 0 ? this.logFile : `${this.logFile}.${this.fileNumber}`;
    if (!append && this.runs.some((run) => run.path === path)) {
      this.runs = this.runs.filter((run) => run.path !== path);
      this.fileVersions.set(path, (this.fileVersions.get(path) ?? 0) + 1);
    }
    this.segment = path;
    this.opened = { path, offset: append ? sizeOnDisk(path) : 0 };
    this.appending = false;
    const file = createWriteStream(path, { flags: append ? "a" : "w" });
    this.file = file;
    this.files.add(file);
    const order = ++this.fileOrder;
    file.once("open", () => {
      if (!this.files.has(file) || file.destroyed) return;
      if (order > (this.logFiles.get(path) ?? -1)) this.logFiles.set(path, order);
    });
    file.on("error", (error: Error) => {
      if (!this.files.has(file)) return;
      this.error = `log write failed: ${error.message}`;
      if (this.file === file) this.file = undefined;
    });
    file.on("drain", () => {
      this.blockedFiles.delete(file);
      this.resume();
    });
    file.on("close", () => {
      this.files.delete(file);
      this.blockedFiles.delete(file);
      this.resume();
    });
  }

  private resume(): void {
    if (this.blockedFiles.size > 0) return;
    this.child?.stdout?.resume();
    this.child?.stderr?.resume();
  }

  private consume(stream: "out" | "err", chunk: string): void {
    const pending = this.buffered[stream] + chunk;
    const parts = pending.split("\n");
    this.buffered[stream] = parts.pop() ?? "";
    for (const part of parts) this.pushLine(stream, part);
    if (this.buffered[stream].length > 64_000) this.flush(stream);
  }

  private flush(stream: "out" | "err"): void {
    const rest = this.buffered[stream];
    this.buffered[stream] = "";
    if (rest.trim().length > 0) this.pushLine(stream, rest);
  }

  pushLine(stream: "out" | "err", raw: string): void {
    const text = clean(raw);
    if (text.trim().length === 0) return;
    const line: LogLine = { index: ++this.cursor, at: Date.now(), stream, text };
    // Every line proves the bridge is alive, whether or not it is being pushed.
    this.lastLineAt = line.at;
    // UTF-16 size is a conservative text bound even on engines storing Latin-1.
    const bytes = text.length * 2;
    if (bytes <= MAX_BUFFER_BYTES) {
      while (this.lineCount === MAX_BUFFER_LINES || this.bufferBytes + bytes > MAX_BUFFER_BYTES) {
        const oldest = this.lines[this.head]!;
        this.bufferBytes -= oldest.text.length * 2;
        this.lines[this.head] = undefined;
        this.head = (this.head + 1) % MAX_BUFFER_LINES;
        this.lineCount -= 1;
        this.droppedLines += 1;
      }
      this.lines[(this.head + this.lineCount) % MAX_BUFFER_LINES] = line;
      this.lineCount += 1;
      this.bufferBytes += bytes;
    } else {
      // Still deliver and write an oversized line, without retaining it in memory.
      this.droppedLines += 1;
    }
    const encoded = `${new Date(line.at).toISOString()} ${line.text}\n`;
    if (this.file) {
      const size = Buffer.byteLength(encoded);
      if (this.fileBytes > 0 && this.fileBytes + size > MAX_FILE_BYTES) {
        this.file.end();
        this.fileNumber = (this.fileNumber + 1) % MAX_LOG_FILES;
        this.fileBytes = 0;
        this.openFile(false);
      }
      if (this.opened) {
        this.runs.push({ ...this.opened, index: line.index });
        this.opened = undefined;
      }
      this.fileBytes += size;
      const file = this.file;
      if (!file.write(encoded)) {
        this.blockedFiles.add(file);
        this.child?.stdout?.pause();
        this.child?.stderr?.pause();
      }
    } else if (!this.child && this.segment) {
      // The bridge is down and its file is closed. What is said meanwhile - why
      // it ended, each reattach - is what explains the rest of the log, so it
      // goes to disk too. Only a few lines arrive in this state.
      try {
        const offset = this.appending ? undefined : sizeOnDisk(this.segment);
        appendFileSync(this.segment, encoded);
        if (offset !== undefined) this.runs.push({ path: this.segment, offset, index: line.index });
        this.appending = true;
      } catch {
        // The log could not be written before either; the line is still in memory.
        this.appending = false;
      }
    }
    for (const listener of this.lineListeners) {
      try {
        listener(line);
      } catch {
        // A listener must never break capture.
      }
    }
  }

  /** Stop the bridge. SIGKILL keeps the app alive; SIGTERM lets devicectl forward termination. */
  stop(terminateApp: boolean): void {
    this.stoppedByUser = true;
    this.abort.abort();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (terminateApp && this.mode === "console") {
      child.kill("SIGTERM");
    } else {
      child.kill("SIGKILL");
    }
  }

  /** Join every retained per-start result task, including old reconnect results. */
  async waitForLaunchResults(): Promise<void> {
    await Promise.all([...this.resultJobs].map(job => job.done));
  }

  /** Session exit cancels diagnostics as well as the bridge, unlike ordinary stop. */
  shutdown(timeoutMs = 3_000): Promise<boolean> {
    this.shuttingDown = true;
    this.stop(false);
    for (const job of this.resultJobs) job.cancel();
    return new Promise(resolve => {
      let settled = false;
      let unsubscribe = (): void => {};
      const done = (cleaned: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (!cleaned) {
          const detail = `capture shutdown timed out after ${timeoutMs}ms; resource cleanup remains pending`;
          this.error = this.error ? `${this.error}; ${detail}` : detail;
        }
        resolve(cleaned);
      };
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      timer.unref();
      const drained = this.running
        ? new Promise<void>(resolve => { unsubscribe = this.onExit(() => resolve()); })
        : Promise.resolve();
      void Promise.all([Promise.all([...this.startups]), this.waitForLaunchResults(), drained]).then(() => done(true));
    });
  }

  /**
   * Kill the bridge for a restart, without touching `stoppedByUser`.
   *
   * `stop()` records the user's intent, so a silence watchdog must not use it:
   * doing so let an internal restart clear a stop the user had just requested.
   * This only tears the process down; the caller reattaches.
   */
  restartBridge(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGKILL");
  }

  /** A signal that fires when this capture is stopped. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(exited);
      };
      const unsubscribe = this.onExit(() => done(true));
      const timer = setTimeout(() => done(false), Math.max(1_000, timeoutMs));
    });
  }

  read(options: { since?: number; limit?: number; grep?: string | RegExp; streams?: Array<"out" | "err"> }): {
    lines: LogLine[];
    cursor: number;
    total: number;
    /** Lines after `since` that the buffer has already dropped. */
    evicted: number;
  } {
    const since = Math.max(0, options.since ?? 0);
    const limit = clampLimit(options.limit);
    const grep = typeof options.grep === "string" ? options.grep.trim() : options.grep;
    const streams = options.streams;
    // Locate the first eligible index without scanning or copying the buffer.
    let first = 0;
    let end = this.lineCount;
    while (first < end) {
      const middle = Math.floor((first + end) / 2);
      if (this.lines[(this.head + middle) % MAX_BUFFER_LINES]!.index <= since) first = middle + 1;
      else end = middle;
    }
    // Oversized lines can leave holes inside the ring, not just before it.
    const evicted = Math.max(0, this.cursor - since - (this.lineCount - first));
    const lines: LogLine[] = [];
    if (!grep && (!streams || streams.length === 0)) {
      for (let i = Math.max(first, this.lineCount - limit); i < this.lineCount; i++) {
        lines.push(this.lines[(this.head + i) % MAX_BUFFER_LINES]!);
      }
      return { lines, cursor: this.cursor, total: this.lineCount - first, evicted };
    }
    let total = 0;
    for (let i = this.lineCount - 1; i >= first; i--) {
      const line = this.lines[(this.head + i) % MAX_BUFFER_LINES]!;
      if (streams && streams.length > 0 && !streams.includes(line.stream)) continue;
      if (grep && !matchesFilter(line.text, grep)) continue;
      total += 1;
      if (lines.length < limit) lines.push(line);
    }
    lines.reverse();
    return { lines, cursor: this.cursor, total, evicted };
  }

  /**
   * `read` with a filter, extended to disk for every hole in the ring, including
   * oversized lines between retained entries. `missing` counts lines neither
   * memory nor any retained file holds any more.
   */
  async search(options: { since?: number; limit?: number; grep: string | RegExp; signal?: AbortSignal }, retry = true): Promise<{
    lines: FoundLine[];
    cursor: number;
    total: number;
    evicted: number;
    missing: number;
  }> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const read = this.read(options);
    if (read.evicted === 0) return { ...read, missing: 0 };
    const since = Math.max(0, options.since ?? 0);
    const holes: Array<{ first: number; last: number }> = [];
    let first = since + 1;
    for (let i = 0; i < this.lineCount; i++) {
      const index = this.lines[(this.head + i) % MAX_BUFFER_LINES]!.index;
      if (index <= since) continue;
      if (index > first) holes.push({ first, last: index - 1 });
      first = index + 1;
    }
    if (first <= read.cursor) holes.push({ first, last: read.cursor });
    const grep = typeof options.grep === "string" ? options.grep.trim() : options.grep;
    const limit = clampLimit(options.limit);
    let older: FoundLine[] = [];
    let total = read.total;
    let covered = 0;
    const runs = [...this.runs];
    const versions = new Map(runs.map((run) => [run.path, this.fileVersions.get(run.path) ?? 0]));
    // A reader reaching EOF before queued writes finish must not advance the
    // cursor past those matches. Flush a barrier after this snapshot's writes;
    // later producer output does not extend the snapshot or delay the barrier.
    const clearBarriers: Array<() => void> = [];
    const writes = [...this.files].map((file) => {
      if (file.destroyed || file.writableFinished) return Promise.resolve();
      if (file.writableEnded) return finished(file, { cleanup: true, signal }).catch(() => {});
      return new Promise<void>((resolve) => {
        const done = (): void => { file.off("close", done); resolve(); };
        file.once("close", done);
        clearBarriers.push(() => { file.off("close", done); });
        file.write("", done);
      });
    });
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.all(writes),
        new Promise<never>((_, reject) => {
          if (!signal) return;
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      for (const clear of clearBarriers) clear();
    }
    let hole = 0;
    for (const [position, run] of runs.entries()) {
      signal?.throwIfAborted();
      if (run.index > read.cursor) break;
      const next = runs[position + 1];
      let index = run.index;
      let pending = "";
      try {
        const stream = createReadStream(run.path, {
          encoding: "utf8",
          start: run.offset,
          ...(next?.path === run.path ? { end: next.offset - 1 } : {}),
          signal,
        });
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          const parts = (pending + chunk).split("\n");
          pending = parts.pop() ?? "";
          for (const raw of parts) {
            if (index > read.cursor) break;
            while (hole < holes.length && holes[hole].last < index) hole++;
            if (hole < holes.length && index >= holes[hole].first) {
              covered += 1;
              const space = raw.indexOf(" ");
              const text = raw.slice(space + 1);
              if (matchesFilter(text, grep)) {
                total += 1;
                older.push({ index, at: Date.parse(raw.slice(0, space)), text });
                if (older.length >= limit * 2 + 64) older = older.slice(-limit);
              }
            }
            index += 1;
          }
          if (index > read.cursor || hole === holes.length) break;
        }
      } catch {
        signal?.throwIfAborted();
        // A run that cannot be read back stays counted in `missing`.
      }
    }
    signal?.throwIfAborted();
    // Opening a new segment is harmless; only replacement of a file actually
    // included in this snapshot can relabel bytes with the wrong indices.
    if ([...versions].some(([path, version]) => (this.fileVersions.get(path) ?? 0) !== version)) {
      return retry ? this.search(options, false) : { ...read, missing: read.evicted };
    }
    return {
      lines: [...older, ...read.lines].sort((a, b) => a.index - b.index).slice(-limit),
      cursor: read.cursor,
      total,
      evicted: read.evicted,
      missing: read.evicted - covered,
    };
  }

  status(): CaptureStatus {
    return {
      id: this.id,
      mode: this.mode,
      device: this.deviceLabel,
      bundleId: this.bundleId,
      processName: this.processName,
      pid: this.pid,
      appPid: this.appPid,
      running: this.running,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      startedAt: this.startedAt,
      lineCount: this.cursor,
      droppedLines: this.droppedLines,
      cursor: this.cursor,
      logFile: this.logFile,
      logFiles: [...this.logFiles].sort((a, b) => a[1] - b[1]).map(([path]) => path),
      commandLine: [this.command, ...this.spawnedArgs].join(" "),
      error: this.error,
      relaunches: this.relaunches,
      endReason: this.endReason,
      crashReport: this.crashReport,
      terminationReason: this.terminationReason,
    };
  }
}
