import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Capture } from "./capture.ts";

const MAX_ENDED_RUNS = 100;
const RECORD_NAME = /^((?:console|syslog)-[a-z\d]+-[a-f\d]{8})\.json$/;
const TEMP_NAME = /^\.(?:console|syslog)-[a-z\d]+-[a-f\d]{8}\.[a-f\d-]{36}\.tmp$/;
const text = Type.String();
const number = Type.Integer();
const optionalText = Type.Optional(text);
const optionalNumber = Type.Optional(number);
const strict = { additionalProperties: false };
const Command = Type.Object({
  label: text, sha256: text, startedAt: number, endedAt: optionalNumber, exitCode: optionalNumber,
  durationMs: optionalNumber, timedOut: Type.Optional(Type.Boolean()), cancelled: Type.Optional(Type.Boolean()),
}, strict);
const Build = Type.Object({
  source: Type.Enum(["built", "reused", "prebuilt"]), appPath: text, scheme: optionalText,
  workspace: optionalText, project: optionalText, configuration: optionalText, product: optionalText,
  logFile: optionalText, gitHead: optionalText, fingerprint: optionalText,
}, strict);
const RecordSchema = Type.Object({
  version: Type.Literal(1), captureId: text, ownerPid: number, ownerStartTime: optionalNumber, mode: Type.Enum(["console", "syslog"]),
  role: Type.Enum(["primary", "companion"]), primaryCaptureId: text, companionCaptureId: optionalText,
  device: text, deviceId: text, udid: optionalText, bundleId: text, processName: optionalText, appPid: optionalNumber,
  projectRoot: text, gitHead: optionalText, fingerprint: optionalText, build: Type.Optional(Build),
  logFile: text, logFiles: Type.Array(text), startedAt: number, updatedAt: number, endedAt: optionalNumber,
  state: Type.Enum(["starting", "running", "reconnecting", "stopping", "ended", "interrupted"]), running: Type.Boolean(),
  relaunches: number, naturalExitAt: optionalNumber, exitCode: optionalNumber, signal: optionalText, endReason: optionalText,
  crashStatus: Type.Optional(Type.Enum(["pending", "found", "unavailable", "cancelled"])),
  terminationReason: optionalText, crashReport: optionalText, command: Type.Optional(Command),
}, strict);

type RunRecord = Static<typeof RecordSchema>;
type RunCommand = Static<typeof Command>;
export type RunIdentity = Pick<RunRecord, "projectRoot" | "gitHead" | "fingerprint" | "build" | "udid"> & { primaryCaptureId?: string };
type Update = Partial<Pick<RunRecord, "state" | "endReason" | "companionCaptureId" | "command" | "crashStatus">>;
interface HistoryQuery { captureId?: string; device?: string; bundleId?: string; limit?: number }

/** Only a recognized tool and subcommand may become display text. Arguments and shell output stay out of history. */
export function commandIdentity(command: string, startedAt: number): RunCommand {
  const match = /^\s*(?:cd\s+(?:[\w./~-]+|'[\w ./~-]+'|"[\w ./~-]+")\s*&&\s*)?(npm|npx|pnpm|yarn|bun|node|xcodebuild|swift|make|cargo|go|pytest|python3?|sh|bash|exit)(?=\s|$)(?:\s+(run|test|build|check|exec|lint|verify)(?=\s|$))?/.exec(command);
  return { label: match ? [match[1], match[2]].filter(Boolean).join(" ") : "shell command",
    sha256: createHash("sha256").update(command).digest("hex"), startedAt };
}

function privateToUser(info: Stats): boolean {
  return (process.getuid === undefined || info.uid === process.getuid()) && (info.mode & 0o077) === 0;
}

function runDirectory(logDir: string, create = false): string | undefined {
  const path = join(logDir, "runs");
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isDirectory() || !privateToUser(info)) throw new Error(`Run history requires a private directory owned by the current user: ${path}`);
  return path;
}
function processStartTime(pid: number): number | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
  if (result.status !== 0) return undefined;
  const value = Date.parse(result.stdout.trim());
  return Number.isFinite(value) ? value : undefined;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Synchronous lifecycle checkpoints keep revisions in event order, including callbacks during session shutdown. */
function writeRecord(logDir: string, record: RunRecord): void {
  const dir = runDirectory(logDir, true)!;
  const temp = join(dir, `.${record.captureId}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, join(dir, `${record.captureId}.json`));
    syncDirectory(dir);
  } catch (error) {
    removeIfPresent(temp);
    throw error;
  }
}

function readRecord(path: string, id: string): { run: RunRecord; info: Stats } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || !privateToUser(info) || info.size > 128 * 1024) return;
    const run: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (Check(RecordSchema, run) && run.captureId === id && run.ownerPid > 0 && run.ownerPid <= 0x7fffffff &&
        Math.abs(run.startedAt) <= 8.64e15) return { run, info };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function observedState(run: RunRecord): RunRecord {
  if (run.state !== "ended" && run.ownerPid !== process.pid) {
    const currentStart = run.ownerStartTime === undefined ? undefined : processStartTime(run.ownerPid);
    try { process.kill(run.ownerPid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { ...run, state: "interrupted", running: false, endReason: run.endReason ?? "server exited before recording capture end",
          crashStatus: run.crashStatus === "pending" ? "cancelled" : run.crashStatus };
      }
    }
    if (run.ownerStartTime !== undefined && currentStart !== undefined && currentStart !== run.ownerStartTime) {
      return { ...run, state: "interrupted", running: false, endReason: run.endReason ?? "server process was replaced",
        crashStatus: run.crashStatus === "pending" ? "cancelled" : run.crashStatus };
    }
  }
  return run;
}

function newestFirst(a: RunRecord, b: RunRecord): number {
  return b.startedAt - a.startedAt || b.captureId.localeCompare(a.captureId);
}

function availableRuns(dir: string, captureId?: string): Array<{ run: RunRecord; info: Stats; path: string }> {
  const records = [];
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    const id = RECORD_NAME.exec(file.name)?.[1];
    if (!file.isFile() || !id || (captureId !== undefined && id !== captureId)) continue;
    const path = join(dir, file.name);
    const entry = readRecord(path, id);
    if (entry) records.push({ ...entry, path, run: observedState(entry.run) });
  }
  return records.sort((a, b) => newestFirst(a.run, b.run));
}

export function pruneRunHistory(logDir: string, maxAgeMs: number): void {
  const dir = runDirectory(logDir);
  if (!dir) return;
  const cutoff = Date.now() - maxAgeMs;
  const ended = availableRuns(dir).filter(({ run }) => run.state === "ended" || run.state === "interrupted");
  for (const [i, { info, path }] of ended.entries()) {
    if (i < MAX_ENDED_RUNS && info.mtimeMs >= cutoff) continue;
    // A concurrent late crash/command update publishes a different inode.
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.ino === info.ino && current.dev === info.dev) removeIfPresent(path);
  }
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (!file.isFile() || !TEMP_NAME.test(file.name)) continue;
    const path = join(dir, file.name);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isFile() && privateToUser(info) && info.mtimeMs < cutoff) removeIfPresent(path);
  }
}

function removeIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function runHistoryResult(logDir: string, query: HistoryQuery): { text: string; runs: RunRecord[] } {
  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("history limit must be a positive integer");
  const dir = runDirectory(logDir);
  const device = query.device?.trim().toLowerCase();
  const runs = (dir ? availableRuns(dir, query.captureId) : []).map(entry => entry.run).filter(run =>
    (query.bundleId === undefined || run.bundleId === query.bundleId) &&
    (!device || [run.device, run.deviceId, run.udid].some(value => value?.toLowerCase() === device)),
  ).slice(0, Math.min(limit, MAX_ENDED_RUNS));
  const text = runs.map(run => [
    `${run.captureId} [${run.role}, ${run.state}] ${run.bundleId} on ${run.device} · ${new Date(run.startedAt).toISOString()}`,
    run.role === "companion" ? `primary ${run.primaryCaptureId}` : run.companionCaptureId && `companion ${run.companionCaptureId}`,
    run.build && `${run.build.source} ${run.build.scheme ?? run.build.appPath}${run.build.configuration ? ` (${run.build.configuration})` : ""}`,
    run.gitHead && `HEAD ${run.gitHead}`, run.fingerprint && `fingerprint ${run.fingerprint}`,
    run.build?.logFile && `build log ${run.build.logFile}`,
    run.command && `command ${run.command.label} [sha256 ${run.command.sha256}] ${run.command.exitCode === undefined ? "outcome pending" : `exit ${run.command.exitCode}`}${run.command.timedOut ? " (timed out)" : run.command.cancelled ? " (cancelled)" : ""}`,
    run.endReason, run.terminationReason, run.crashReport && `crash report ${run.crashReport}`, `log ${run.logFile}`,
  ].filter(Boolean).join(" · ")).join("\n");
  return { runs, text: text || `No matching run records. Older captures with only a .log file can be read by path in ${logDir}.` };
}

export class RunHistory {
  private readonly records = new WeakMap<Capture, { logDir: string; run: RunRecord }>();
  private readonly maxAgeMs: number;

  constructor(maxAgeMs: number) { this.maxAgeMs = maxAgeMs; }

  begin(capture: Capture, logDir: string, identity: RunIdentity): void {
    const run: RunRecord = {
      ...identity, version: 1, captureId: capture.id, ownerPid: process.pid, ownerStartTime: processStartTime(process.pid), mode: capture.mode,
      role: identity.primaryCaptureId ? "companion" : "primary", primaryCaptureId: identity.primaryCaptureId ?? capture.id,
      deviceId: capture.deviceId, device: capture.deviceLabel, bundleId: capture.bundleId, processName: capture.processName,
      state: "starting", running: false, startedAt: capture.startedAt, updatedAt: capture.startedAt,
      relaunches: 0, logFile: capture.logFile, logFiles: [],
    };
    try {
      writeRecord(logDir, run);
    } catch (error) {
      console.error(`[xcodebug] run history unavailable for ${capture.id}:`, error);
      return;
    }
    this.records.set(capture, { logDir, run });
    capture.onProcessExit(() => { if (!capture.stoppedByUser) this.update(capture, { state: "reconnecting" }); });
    capture.onExit(() => this.update(capture, { state: capture.stoppedByUser ? "ended" : "reconnecting" }));
  }

  update(capture: Capture, patch: Update = {}): void {
    const previous = this.records.get(capture);
    if (!previous) return;
    const { logDir, run } = previous;
    const status = capture.status();
    const state = run.state === "ended" ? "ended" : patch.state ?? run.state;
    // The live endReason can quote an arbitrary last log line. The archive stores only the diagnosis.
    const endReason = capture.endReason?.split("; last line before the bridge ended:", 1)[0] ?? run.endReason ?? patch.endReason;
    const next: RunRecord = { ...run, ...patch, state, running: state === "running", endReason,
      endedAt: run.endedAt ?? (state === "ended" ? Date.now() : undefined), appPid: status.appPid,
      exitCode: status.exitCode, signal: status.signal, logFiles: status.logFiles, relaunches: status.relaunches,
      naturalExitAt: capture.naturalExitAt, crashReport: status.crashReport, terminationReason: status.terminationReason,
    };
    if (JSON.stringify(run) === JSON.stringify(next)) return;
    const updated = { ...next, updatedAt: Date.now() };
    try {
      writeRecord(logDir, updated);
      this.records.set(capture, { logDir, run: updated });
      if (state === "ended" && run.state !== state) pruneRunHistory(logDir, this.maxAgeMs);
    } catch (error) {
      // A full/unavailable history volume must not interrupt bridge teardown or diagnostics.
      console.error(`[xcodebug] run history update failed for ${capture.id}:`, error);
    }
  }

  stop(capture: Capture, endReason: string): void {
    this.update(capture, { endReason, state: capture.running || capture.starting ? "stopping" : "ended",
      ...(endReason === "session shutdown" && this.records.get(capture)?.run.crashStatus === "pending"
        ? { crashStatus: "cancelled" } : {}) });
  }
}
