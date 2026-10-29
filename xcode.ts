/**
 * Xcode build / install / launch plumbing for a physical iOS device.
 *
 * The console mode mirrors what Xcode shows in its debug console: devicectl
 * bridges the app's stdout/stderr and, with OS_ACTIVITY_DT_MODE=YES, its
 * os_log output as well. No jailbreak and no debugger attach are involved.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord, asString, lastLines, runCommand, timestamp } from "./exec";
import { BuildProgressTracker, formatProgress } from "./progress";
import type { DeviceInfo } from "./devices";

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
    onChunk: (_stream, chunk) => {
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
  await writeFile(logFile, `$ xcodebuild ${args.join(" ")}\n\n${result.stdout}\n${result.stderr}`);

  const durationMs = Date.now() - started;
  if (result.code !== 0) {
    const final = tracker.finish("failed");
    options.onProgress?.(formatProgress(final));
    const reason = result.timedOut ? "build timed out" : `build failed (exit ${result.code})`;
    return {
      ok: false,
      logFile,
      durationMs,
      summary: `${reason}\n${lastLines(`${result.stderr}\n${result.stdout}`, 25)}`,
    };
  }
  options.onProgress?.(formatProgress(tracker.finish("done")));

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
  let buildDir: string | undefined;
  let wrapper: string | undefined;
  let bundleId: string | undefined;
  if (settings.code === 0) {
    try {
      const parsed = JSON.parse(settings.stdout);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const values = asRecord(asRecord(entry).buildSettings);
        if (asString(values.TARGET_BUILD_DIR) && asString(values.WRAPPER_NAME)) {
          buildDir = asString(values.TARGET_BUILD_DIR);
          wrapper = asString(values.WRAPPER_NAME);
          bundleId = asString(values.PRODUCT_BUNDLE_IDENTIFIER);
          break;
        }
      }
    } catch {
      // Fall through to the log-only success report.
    }
  }

  const appPath = buildDir && wrapper ? join(buildDir, wrapper) : undefined;
  const executable = appPath ? await readPlistValue(appPath, "CFBundleExecutable") : undefined;
  const plistBundleId = appPath ? await readPlistValue(appPath, "CFBundleIdentifier") : undefined;

  return {
    ok: true,
    appPath,
    bundleId: plistBundleId ?? bundleId,
    executable,
    logFile,
    durationMs,
    summary: `build succeeded in ${(durationMs / 1000).toFixed(1)}s${appPath ? `\napp: ${appPath}` : ""}`,
  };
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
  options: { timeoutMs: number },
): Promise<{ ok: boolean; message: string }> {
  const result = await runCommand(
    "xcrun",
    ["devicectl", "device", "process", "terminate", "--device", device.id, "--pid", String(pid)],
    { timeoutMs: options.timeoutMs, maxBytes: 200_000 },
  );
  if (result.code === 0) return { ok: true, message: `terminated pid ${pid}` };
  return {
    ok: false,
    message: `terminate failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
  };
}
