/**
 * Durable log archiving.
 *
 * The live console bridge (`devicectl --console`) carries the app's own
 * stdout/stderr, including NSLog/print output that os_log never records. It can
 * drop mid-run, and whatever it did not emit is gone from the live channel.
 *
 * The device keeps its own unified log for hours. `idevicesyslog archive`
 * pulls that archive, and `log show --archive` reads it back for any time
 * window - so a dropped bridge can still be back-filled from the device.
 *
 * Coverage differs by channel and is reported honestly:
 *   live console  - app stdout/stderr + os_log (MySDK, BLE, print)
 *   device archive - os_log only (framework/system messages, errors)
 * MySDK-style NSLog lines appear only in the live channel.
 */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand, timestamp } from "./exec.ts";

export interface ArchiveResult {
  ok: boolean;
  /** Path to the .logarchive directory ready for `log show --archive`. */
  archivePath?: string;
  /** Raw .tar as pulled from the device. */
  tarPath: string;
  durationMs: number;
  message: string;
}

/**
 * Delete every pulled archive in `workDir`.
 *
 * Each pull covers the device's last hour, so consecutive snapshots overlap
 * almost entirely and only the newest one is worth keeping. Called when a new
 * build starts: a fresh build means the previous run's archives can no longer
 * explain anything about the run that is about to begin.
 */
export async function clearArchives(workDir: string): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  let entries: string[];
  try {
    entries = await readdir(workDir);
  } catch {
    return { removed, freedBytes };
  }
  for (const name of entries) {
    const isArchive = name.endsWith(".tar") || name.endsWith(".logarchive");
    if (!isArchive) continue;
    const path = join(workDir, name);
    try {
      // Measure before removing: the directory size is gone afterwards.
      freedBytes += await sizeOf(path);
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A file already gone, or one we cannot delete, is not worth failing a build.
    }
  }
  return { removed, freedBytes };
}

/** The files this extension writes: build, capture and pod install logs, and pulled crash reports. */
const OWN_LOG = /^(?:build|console|syslog|pod-install|crash)-.+\.(?:log(?:\.\d+)?|ips)$/;

/** Reclaim only expired, marked launch results whose owning process is definitely gone. */
async function pruneLaunchResult(path: string, cutoff: number): Promise<void> {
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const inspect = async (expectedDirectory?: Stats) => {
    const directory = await lstat(path);
    if (!directory.isDirectory() || (expectedDirectory
      ? !same(directory, expectedDirectory) : !(directory.mtimeMs < cutoff))) return;
    const names = (await readdir(path)).sort();
    if (!names.includes("owner.json") || names.some(name => name !== "owner.json" && name !== "launch.json")) return;
    const files: { name: string; info: Stats }[] = [];
    for (const name of names) {
      const info = await lstat(join(path, name));
      if (!info.isFile() || !(info.mtimeMs < cutoff)) return;
      files.push({ name, info });
    }
    const ownerInfo = files.find(file => file.name === "owner.json")!.info;
    // Refuse links and oversized unknown content before reading an ownership marker.
    if (ownerInfo.size > 1_024) return;
    const handle = await open(join(path, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let ownerText: string;
    try {
      if (!same(await handle.stat(), ownerInfo)) return;
      ownerText = await handle.readFile({ encoding: "utf8" });
      if (!same(await handle.stat(), ownerInfo)) return;
    } finally {
      await handle.close();
    }
    const owner = JSON.parse(ownerText);
    if (!owner || typeof owner !== "object" || Array.isArray(owner) || Object.keys(owner).length !== 4
      || owner.kind !== "xcodebug.launch-result" || owner.version !== 1
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isSafeInteger(owner.createdAt) || owner.createdAt < 0 || !(owner.createdAt < cutoff)) return;
    try {
      process.kill(owner.pid, 0);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
    }
    for (const file of files) {
      if (!same(await lstat(join(path, file.name)), file.info)) return;
    }
    if (!same(await lstat(path), directory)) return;
    return { directory, files, ownerText };
  };

  const initial = await inspect();
  if (!initial) return;
  let expectedDirectory = initial.directory;
  let removed = 0;
  // Sorted entries remove launch.json first, retaining proof of ownership if cleanup fails.
  for (const file of initial.files) {
    const current = await inspect(expectedDirectory);
    if (!current || current.ownerText !== initial.ownerText || current.files.length !== initial.files.length - removed
      || current.files.some((entry, index) => entry.name !== initial.files[index + removed].name
        || !same(entry.info, initial.files[index + removed].info))) return;
    await unlink(join(path, file.name));
    removed++;
    // Only our successful unlink may make an otherwise-expired directory fresh.
    expectedDirectory = await lstat(path);
    if (!expectedDirectory.isDirectory() || expectedDirectory.dev !== initial.directory.dev
      || expectedDirectory.ino !== initial.directory.ino) return;
  }
  if ((await readdir(path)).length === 0 && same(await lstat(path), expectedDirectory)) await rmdir(path);
}

/**
 * Delete this extension's logs that nothing has written to for `maxAgeMs`.
 *
 * Nothing else ever removes them, and they add up to hundreds of megabytes in
 * a few weeks. Age since the last write is the whole test: a capture still
 * running keeps its log fresh, and a file xcodebug did not name is left alone.
 * Owned launch-result leftovers additionally require an expired marker and a
 * definitely absent owner; unmarked or uncertain directories are left alone.
 */
export async function pruneLogs(logDir: string, maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const launchResult = name.startsWith(".xcodebug-launch-") && name.length > ".xcodebug-launch-".length;
    if (!OWN_LOG.test(name) && !launchResult) continue;
    const path = join(logDir, name);
    try {
      if (launchResult) await pruneLaunchResult(path, cutoff);
      else if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
    } catch {
      // A log or owned result that cannot be removed is not worth failing a run over.
    }
  }
}

/** Recursive size of a file or directory, in bytes. */
async function sizeOf(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await sizeOf(child) : (await stat(child)).size;
  }
  return total;
}

export interface ArchiveQueryOptions {
  start?: string;
  end?: string;
  processName?: string;
  grep?: string;
  limit?: number;
}

/** Pull the device's unified log for the last `ageSeconds` into a logarchive. */
export async function pullArchive(
  deviceUdid: string,
  options: { ageSeconds: number; workDir: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ArchiveResult> {
  const started = Date.now();
  const stamp = timestamp();
  const tarPath = join(options.workDir, `device-log-${stamp}.tar`);
  const archivePath = join(options.workDir, `device-log-${stamp}.logarchive`);
  await mkdir(dirname(tarPath), { recursive: true });

  const pull = await runCommand(
    "idevicesyslog",
    ["-u", deviceUdid, "archive", tarPath, "--age-limit", String(options.ageSeconds)],
    { timeoutMs: options.timeoutMs ?? 300_000, maxBytes: 2_000_000, signal: options.signal },
  );
  if (pull.code !== 0) {
    return {
      ok: false,
      tarPath,
      durationMs: Date.now() - started,
      message: `archive pull failed (exit ${pull.code}): ${(pull.stderr || pull.stdout).trim().slice(0, 300)}`,
    };
  }

  await mkdir(archivePath, { recursive: true });
  const untar = await runCommand("tar", ["-xf", tarPath, "-C", archivePath], {
    timeoutMs: 180_000,
    maxBytes: 200_000,
  });
  if (untar.code !== 0) {
    return {
      ok: false,
      tarPath,
      durationMs: Date.now() - started,
      message: `archive extract failed (exit ${untar.code}): ${(untar.stderr || untar.stdout).trim().slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    archivePath,
    tarPath,
    durationMs: Date.now() - started,
    message: `archive ready (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  };
}

/** Read a window out of a pulled archive. */
export async function queryArchive(
  archivePath: string,
  options: ArchiveQueryOptions,
): Promise<{ ok: boolean; lines: string[]; message: string }> {
  const args = ["show", "--archive", archivePath, "--style", "compact"];
  if (options.start) args.push("--start", options.start);
  if (options.end) args.push("--end", options.end);
  if (options.processName) args.push("--predicate", `process == "${options.processName}"`);

  const result = await runCommand("log", args, { timeoutMs: 300_000, maxBytes: 20_000_000 });
  if (result.code !== 0) {
    return {
      ok: false,
      lines: [],
      message: `log show failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    };
  }

  let lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  // Drop the "Timestamp Ty Process[PID:TID]" header line.
  if (lines.length > 0 && lines[0]?.startsWith("Timestamp")) lines = lines.slice(1);
  const grep = options.grep;
  if (grep) lines = lines.filter((line) => line.includes(grep));
  const limit = options.limit ?? 500;
  const total = lines.length;
  const kept = lines.slice(-limit);
  return {
    ok: true,
    lines: kept,
    message: `${kept.length} line(s)${total > kept.length ? ` (${total - kept.length} older omitted)` : ""}`,
  };
}
