/**
 * One live log capture: a long-running child process whose stdout/stderr is
 * normalized into an indexed ring buffer, mirrored to a log file, and read
 * back through a cursor so the agent can fetch only what is new.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { timestamp } from "./exec";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_BUFFER_LINES = 20_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export type CaptureMode = "console" | "syslog";

export interface LogLine {
  index: number;
  at: number;
  stream: "out" | "err";
  text: string;
}

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
  commandLine: string;
  error?: string;
}

function clean(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

export class Capture {
  readonly id: string;
  readonly mode: CaptureMode;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly bundleId: string;
  readonly processName?: string;
  /** App pid on the device; filled in once discovery succeeds, never the bridge pid. */
  appPid?: number;
  readonly startedAt = Date.now();
  readonly logFile: string;

  readonly command: string;
  readonly launchArgs: string[];
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
   * Aborted when this capture is stopped, so an in-flight device probe returns
   * at once instead of running out its own timeout first.
   */
  readonly abort = new AbortController();
  private child: ChildProcess | undefined;
  private file: WriteStream | undefined;
  private readonly lines: LogLine[] = [];
  private droppedLines = 0;
  private cursor = 0;
  private buffered: { out: string; err: string } = { out: "", err: "" };
  private exitCode: number | undefined;
  private exitSignal: string | undefined;
  private error: string | undefined;
  private fileBytes = 0;
  private readonly exitListeners = new Set<(code: number | undefined, signal: string | undefined) => void>();
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
    this.logFile =
      init.logFile ?? `${init.logDir}/${init.mode}-${init.bundleId}-${timestamp()}.log`;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.exitSignal === undefined;
  }

  /** Clear the terminal state so start() can attach a fresh bridge. */
  resetForReconnect(): void {
    this.exitCode = undefined;
    this.exitSignal = undefined;
    this.error = undefined;
    this.buffered = { out: "", err: "" };
    // A fresh bridge starts its silence clock now, or the watchdog would see the
    // gap it just repaired and immediately restart the new bridge too.
    this.lastLineAt = Date.now();
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

  async start(): Promise<void> {
    await mkdir(dirname(this.logFile), { recursive: true });
    this.file = createWriteStream(this.logFile, { flags: "a" });
    this.file.on("error", () => {
      this.file = undefined;
    });

    const child = spawn(this.command, this.launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consume("out", chunk));
    child.stderr?.on("data", (chunk: string) => this.consume("err", chunk));
    child.on("error", (error: Error) => {
      this.error = error.message;
      this.pushLine("err", `[xcodebug] failed to start: ${error.message}`);
      this.finish(undefined, undefined);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.flush("out");
      this.flush("err");
      this.finish(code ?? undefined, signal ?? undefined);
    });
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
    this.lines.push(line);
    if (this.lines.length > MAX_BUFFER_LINES) {
      this.lines.shift();
      this.droppedLines += 1;
    }
    for (const listener of this.lineListeners) {
      try {
        listener(line);
      } catch {
        // A listener must never break capture.
      }
    }
    if (this.file && this.fileBytes < MAX_FILE_BYTES) {
      const encoded = `${new Date(line.at).toISOString()} ${line.text}\n`;
      this.fileBytes += Buffer.byteLength(encoded);
      this.file.write(encoded);
    }
  }

  private finish(code: number | undefined, signal: string | undefined): void {
    if (this.exitCode !== undefined || this.exitSignal !== undefined) return;
    this.exitCode = code;
    this.exitSignal = signal;
    this.child = undefined;
    this.file?.end();
    this.file = undefined;
    for (const listener of this.exitListeners) {
      try {
        listener(code, signal);
      } catch {
        // A listener must never break capture teardown.
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

  read(options: { since?: number; limit?: number; grep?: string; streams?: Array<"out" | "err"> }): {
    lines: LogLine[];
    cursor: number;
    total: number;
  } {
    const since = Math.max(0, options.since ?? 0);
    const limit = Math.min(Math.max(1, options.limit ?? 200), 5_000);
    const grep = options.grep?.trim();
    const streams = options.streams;
    let matched = this.lines.filter((line) => line.index > since);
    if (streams && streams.length > 0) matched = matched.filter((line) => streams.includes(line.stream));
    if (grep) matched = matched.filter((line) => line.text.includes(grep));
    const cursor = this.cursor;
    return { lines: matched.slice(-limit), cursor, total: matched.length };
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
      commandLine: [this.command, ...this.launchArgs].join(" "),
      error: this.error,
    };
  }
}
