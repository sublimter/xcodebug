/**
 * Xcode build / install / launch plumbing for a physical iOS device.
 *
 * The console mode mirrors what Xcode shows in its debug console: devicectl
 * bridges the app's stdout/stderr and, with OS_ACTIVITY_DT_MODE=YES, its
 * os_log output as well. No jailbreak and no debugger attach are involved.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { asString, lastLines, runCommand, timestamp } from "./exec.ts";
import { appBuildSettings } from "./project.ts";
import { BuildProgressTracker, formatProgress } from "./progress.ts";
import type { DeviceInfo } from "./devices.ts";

export interface BuildTarget {
  workspace?: string;
  project?: string;
  scheme: string;
  configuration: string;
  derivedDataPath?: string;
  extraArgs?: string[];
}

export interface BuildOutcome {
  ok: boolean;
  appPath?: string;
  bundleId?: string;
  executable?: string;
  logFile: string;
  summary: string;
  durationMs: number;
}

function destination(device: DeviceInfo): string {
  const id = device.udid ?? device.id;
  return `platform=iOS,id=${id}`;
}

const MAX_DIAGNOSTICS = 12;
const MAX_DIAGNOSTIC_CHARS = 320;
/** Indented lines kept under a linker's symbol list: the symbols and what references them. */
const MAX_SYMBOL_LINES = 6;
/**
 * `path:line:column: error: …` from a compiler, `xcodebuild: error: …`, or a
 * bare `error: …`. Never indented: the indented ones are the compiler's own
 * rendering of the source line under a diagnostic already taken.
 */
const ERROR_LINE = /^(?:\S.*: )?(?:fatal )?error: /;
/** The linker's own failures, which carry no `error:`. Its warnings are left out. */
const LINKER_LINE = /^ld: (?!warning: )/;
/** Linker symbol-list headings, followed by indented references or conflicting objects. */
const SYMBOLS_LINE = /^(?:(?:Undefined|duplicate) symbols? for architecture|duplicate symbol .+ in:)/;

/**
 * Collects the lines of a build's output that say what failed, as they pass.
 *
 * xcodebuild prints an error in the middle of its output, under the
 * multi-kilobyte command that produced it and above everything the build still
 * goes on to do, so the end of a failed build is build commands. Collecting
 * while the output streams also keeps an error the size cap later drops.
 */
export class BuildDiagnostics {
  private readonly seen = new Set<string>();
  private readonly kept: string[] = [];
  private total = 0;
  private remainder = "";
  /** Indented lines still to keep under the symbol list just opened. */
  private symbolLines = 0;

  update(chunk: string): void {
    const parts = (this.remainder + chunk).split("\n");
    this.remainder = parts.pop() ?? "";
    for (const part of parts) this.take(part.trimEnd());
  }

  private take(line: string): void {
    if (this.symbolLines > 0 && /^\s+\S/.test(line)) {
      this.symbolLines -= 1;
      this.kept.push(line.slice(0, MAX_DIAGNOSTIC_CHARS));
      return;
    }
    this.symbolLines = 0;
    const symbols = SYMBOLS_LINE.test(line);
    if (!symbols && !LINKER_LINE.test(line) && !ERROR_LINE.test(line)) return;
    // The compiler reports a diagnostic once per pass over the file. A symbol
    // list opens with the same words every time and is told apart by what follows.
    if (!symbols) {
      if (this.seen.has(line)) return;
      this.seen.add(line);
    }
    this.total += 1;
    if (this.total > MAX_DIAGNOSTICS) return;
    this.kept.push(line.slice(0, MAX_DIAGNOSTIC_CHARS));
    if (symbols) this.symbolLines = MAX_SYMBOL_LINES;
  }

  /** The diagnostics kept, and how many more there were. */
  result(): { lines: string[]; omitted: number } {
    this.update("\n");
    return { lines: this.kept, omitted: Math.max(0, this.total - MAX_DIAGNOSTICS) };
  }
}

function targetFlags(target: BuildTarget): string[] {
  const flags: string[] = [];
  if (target.workspace) flags.push("-workspace", target.workspace);
  else if (target.project) flags.push("-project", target.project);

  flags.push("-scheme", target.scheme, "-configuration", target.configuration);
  if (target.derivedDataPath) flags.push("-derivedDataPath", target.derivedDataPath);
  if (target.extraArgs?.length) flags.push(...target.extraArgs);
  return flags;
}

async function readPlistValue(appPath: string, key: string): Promise<string | undefined> {
  const result = await runCommand(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, join(appPath, "Info.plist")],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) return undefined;
  return asString(result.stdout.trim());
}

export async function buildForDevice(
  target: BuildTarget,
  device: DeviceInfo,
  options: {
    logDir: string;
    timeoutMs: number;
    cwd: string;
    signal?: AbortSignal;
    /** Called at most a few times a second while the build runs. */
    onProgress?: (text: string) => void;
  },
): Promise<BuildOutcome> {
  const started = Date.now();
  const logFile = join(options.logDir, `build-${target.scheme}-${timestamp()}.log`);
  await mkdir(dirname(logFile), { recursive: true });

  const args = [...targetFlags(target), "-destination", destination(device), "build"];
  const tracker = new BuildProgressTracker();
  // One per stream: each is split into lines on its own.
  const diagnostics = { stdout: new BuildDiagnostics(), stderr: new BuildDiagnostics() };
  let lastEmit = 0;
  let lastStage = "";
  // xcodebuild can go quiet for minutes (signing, copying a large bundle). A
  // heartbeat keeps the bar and its clock moving so a slow stage never looks
  // like a wedged one; the stage logic itself still comes from the output.
  const heartbeat = setInterval(() => {
    if (!options.onProgress) return;
    lastEmit = Date.now();
    options.onProgress(formatProgress(tracker.snapshot()));
  }, 5_000);
  heartbeat.unref?.();
  const result = await runCommand("xcodebuild", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxBytes: 12_000_000,
    signal: options.signal,
    onChunk: (stream, chunk) => {
      diagnostics[stream].update(chunk);
      const progress = tracker.update(chunk);
      // Throttle: a build emits tens of thousands of lines.
      const now = Date.now();
      // A stage change is always worth a frame; otherwise throttle, because a
      // build emits tens of thousands of lines and every frame is a tool update.
      const stageChanged = progress.stage !== lastStage;
      if (options.onProgress && (stageChanged || now - lastEmit >= 2_000)) {
        lastEmit = now;
        lastStage = progress.stage;
        options.onProgress(formatProgress(progress));
      }
    },
  });
  clearInterval(heartbeat);
  // Say so when the cap cut the head: a log that silently starts mid-build reads
  // like a truncated file the user has to explain away.
  const dropped = result.truncated
    ? "[xcodebug] output exceeded the size cap; the beginning was dropped and this log keeps the tail.\n\n"
    : "";
  await writeFile(logFile, `$ xcodebuild ${args.join(" ")}\n[xcodebug] build timeout budget: ${options.timeoutMs / 1000}s\n\n${dropped}${result.stdout}\n${result.stderr}`);

  const durationMs = Date.now() - started;
  if (result.code !== 0) {
    const final = tracker.finish("failed");
    options.onProgress?.(formatProgress(final));
    const reason = result.timedOut
      ? `build timed out (budget ${options.timeoutMs / 1000}s; elapsed ${(durationMs / 1000).toFixed(1)}s)`
      : `build failed (exit ${result.code})`;
    const found = [diagnostics.stdout.result(), diagnostics.stderr.result()];
    const errors = found.flatMap((each) => each.lines);
    const omitted = found.reduce((sum, each) => sum + each.omitted, 0);
    // xcodebuild closes stderr with its own account: the verdict and the
    // commands that failed.
    const verdictAt = result.stderr.lastIndexOf("** BUILD ");
    const verdict = verdictAt < 0 ? [] : result.stderr.slice(verdictAt).split("\n").filter((line) => line.trim()).slice(0, 12);
    const detail =
      errors.length > 0
        ? [...errors, omitted > 0 ? `(+${omitted} more error(s) in the log)` : "", ...verdict].filter(Boolean).join("\n")
        : // Nothing called itself an error, so the end of the output is all there is.
          lastLines(`${result.stderr}\n${result.stdout}`, 25);
    return {
      ok: false,
      logFile,
      durationMs,
      summary: `${reason}\n${detail}`,
    };
  }
  // Resolve the product path from the SAME destination the build used. Without
  // -destination, xcodebuild reports the default platform (maccatalyst for a
  // framework scheme), and appPath would point at the wrong product.
  const settings = await runCommand(
    "xcodebuild",
    [...targetFlags(target), "-destination", destination(device), "-showBuildSettings", "-json"],
    {
      cwd: options.cwd,
      timeoutMs: 120_000,
      maxBytes: 4_000_000,
      signal: options.signal,
    },
  );
  try {
    if (settings.code !== 0 || settings.truncated) {
      throw new Error(settings.truncated ? "xcodebuild -showBuildSettings output was truncated." :
        `xcodebuild -showBuildSettings failed (exit ${settings.code}): ${lastLines(settings.stderr || settings.stdout, 5)}`);
    }
    const values = appBuildSettings(JSON.parse(settings.stdout), target.scheme);
    if (!values) throw new Error(`No installable iOS app target in scheme ${target.scheme}.`);
    const buildDir = asString(values.TARGET_BUILD_DIR);
    const wrapper = asString(values.WRAPPER_NAME ?? values.FULL_PRODUCT_NAME);
    if (!buildDir || !wrapper?.endsWith(".app") || basename(wrapper) !== wrapper) {
      throw new Error(`Missing app product path in build settings for scheme ${target.scheme}.`);
    }
    const appPath = resolve(options.cwd, buildDir, wrapper);
    const [executable, bundleId] = await Promise.all([
      readPlistValue(appPath, "CFBundleExecutable"), readPlistValue(appPath, "CFBundleIdentifier"),
    ]);
    options.onProgress?.(formatProgress(tracker.finish("done")));
    return {
      ok: true, appPath, executable: executable ?? asString(values.EXECUTABLE_NAME),
      bundleId: bundleId ?? asString(values.PRODUCT_BUNDLE_IDENTIFIER), logFile, durationMs,
      summary: `build succeeded in ${(durationMs / 1000).toFixed(1)}s\napp: ${appPath}`,
    };
  } catch (error) {
    options.onProgress?.(formatProgress(tracker.finish("failed")));
    return { ok: false, logFile, durationMs, summary: `Cannot resolve the built iOS app: ${(error as Error).message}` };
  }
}

export async function installApp(
  device: DeviceInfo,
  appPath: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; message: string }> {
  const result = await runCommand(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", device.id, appPath],
    { timeoutMs: options.timeoutMs, maxBytes: 2_000_000, signal: options.signal },
  );
  if (result.code === 0) return { ok: true, message: "installed" };
  return {
    ok: false,
    message: `install failed (exit ${result.code}):\n${lastLines(`${result.stderr}\n${result.stdout}`, 15)}`,
  };
}

export function consoleLaunchArgs(
  device: DeviceInfo,
  bundleId: string,
  options: { args?: string[]; jsonOutput?: string; terminateExisting: boolean; environment?: Record<string, string> },
): string[] {
  const args = ["devicectl", "device", "process", "launch", "--device", device.id, "--console"];
  if (options.terminateExisting) args.push("--terminate-existing");
  if (options.jsonOutput) args.push("--json-output", options.jsonOutput);
  const environment = { OS_ACTIVITY_DT_MODE: "YES", ...options.environment };
  args.push("-e", JSON.stringify(environment));
  args.push(bundleId);
  if (options.args?.length) args.push("--", ...options.args);
  return args;
}

export async function terminateApp(
  device: DeviceInfo,
  pid: number,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; message: string }> {
  const result = await runCommand(
    "xcrun",
    ["devicectl", "device", "process", "terminate", "--device", device.id, "--pid", String(pid)],
    { timeoutMs: options.timeoutMs, maxBytes: 200_000, signal: options.signal },
  );
  if (result.code === 0) return { ok: true, message: `terminated pid ${pid}` };
  return {
    ok: false,
    message: `terminate failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
  };
}
