/**
 * Local-change detection for a CocoaPods iOS project.
 *
 * Two decisions matter before a device run:
 *   1. Did any build-relevant source change since the last run? -> rebuild.
 *   2. Did a *new* file land inside a pod? -> `pod install` first, because the
 *      generated Pods project enumerates pod sources and will not compile a
 *      file it has never seen.
 *
 * Pod membership is derived from the repo's own podspecs (`source_files`
 * globs), so it follows whatever layout the podspec declares.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { runCommand } from "./exec";

const SOURCE_EXTENSIONS = new Set([
  ".swift", ".h", ".m", ".mm", ".c", ".cc", ".cpp", ".metal",
  ".storyboard", ".xib", ".strings", ".stringsdict", ".plist", ".json",
]);

/** Paths that never imply a rebuild of app or pod code. */
const IGNORED_SEGMENTS = ["/Pods/", "/build/", "/.build/", "/DerivedData/", "/Carthage/", "/.git/"];

/**
 * Config directories the engine ships under, i.e. agent state that may live
 * inside a repo and must never look like app code.
 *
 * The engine's own resolver keeps this same set (`KNOWN_BRAND_CONFIG_DIRS`) for
 * the same reason; xcodebug is a generic pi extension, so it cannot assume the
 * one brand it happens to run under.
 */
const AGENT_STATE_DIRS = [".pi", ".omp", ".omo", ".senpi"];

export interface ChangedFile {
  /** Two-letter porcelain status: " M", "M ", "??", "A ", "D ". */
  status: string;
  path: string;
  untracked: boolean;
  deleted: boolean;
}

interface PodEntry {
  pod: string;
  podspec: string;
  globs: RegExp[];
}

export interface ChangeReport {
  repoRoot: string;
  /** True when git could not report (no repo, no git binary). */
  unavailable: boolean;
  reason?: string;
  changed: ChangedFile[];
  /** New (untracked or added) files that belong to a pod. */
  newComponentFiles: Array<ChangedFile & { pods: string[] }>;
  /** Pods whose file list changed and therefore need `pod install`. */
  podsNeedingInstall: string[];
  /** Stable hash of the relevant change set; equal hashes mean "no change since". */
  fingerprint: string;
  needsBuild: boolean;
}

function isRelevant(path: string): boolean {
  const normalized = `/${path.replace(/\\/g, "/")}`;
  if (IGNORED_SEGMENTS.some((segment) => normalized.includes(segment))) return false;
  // Agent state is not app source: a session file or skill under a config dir
  // must not trigger a device build.
  if (AGENT_STATE_DIRS.some((dir) => normalized.includes(`/${dir}/`))) return false;
  const lower = path.toLowerCase();
  if (lower.endsWith("podfile") || lower.endsWith("podfile.lock") || lower.endsWith(".podspec")) return true;
  if (lower.includes(".xcodeproj/") || lower.includes(".xcworkspace/")) return true;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(lower.slice(dot));
}

/** Expand one glob (braces, **, *) into a RegExp over repo-relative paths. */
export function globToRegExp(glob: string): RegExp {
  const alternatives: string[] = [];
  const brace = /\{([^{}]*)\}/.exec(glob);
  if (brace) {
    for (const option of brace[1].split(",")) {
      alternatives.push(glob.slice(0, brace.index) + option.trim() + glob.slice(brace.index + brace[0].length));
    }
  } else {
    alternatives.push(glob);
  }

  const source = alternatives
    .map((pattern) => {
      let out = "";
      for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === "*") {
          if (pattern[i + 1] === "*") {
            i += 1;
            if (pattern[i + 1] === "/") i += 1;
            out += "(?:.*/)?";
          } else {
            out += "[^/]*";
          }
        } else if (char === "?") {
          out += "[^/]";
        } else {
          out += char.replace(/[.+^$`{}()|[\]\\]/g, "\\$&");
        }
      }
      return out;
    })
    .join("|");

  return new RegExp(`^(?:${source})$`);
}

async function readPodspec(podspecPath: string): Promise<{ name?: string; globs: string[] }> {
  let content = "";
  try {
    content = await readFile(podspecPath, "utf8");
  } catch {
    return { globs: [] };
  }
  const nameMatch = /(?:spec|s)\.name\s*=\s*["']([^"']+)["']/.exec(content);
  const globs: string[] = [];
  // source_files may be assigned per subspec; collect every occurrence.
  for (const match of content.matchAll(/source_files\s*=\s*\[?\s*([^\n\]]+)/g)) {
    for (const literal of match[1].matchAll(/["']([^"']+)["']/g)) {
      globs.push(literal[1]);
    }
  }
  return { name: nameMatch?.[1], globs };
}

export async function loadPods(repoRoot: string): Promise<PodEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const pods: PodEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".podspec")) continue;
    const podspecPath = join(repoRoot, entry.name);
    const { name, globs } = await readPodspec(podspecPath);
    if (!name || globs.length === 0) continue;
    pods.push({ pod: name, podspec: relative(repoRoot, podspecPath), globs: globs.map(globToRegExp) });
  }
  return pods;
}

function podsForPath(path: string, pods: PodEntry[]): string[] {
  return pods.filter((pod) => pod.globs.some((pattern) => pattern.test(path))).map((pod) => pod.pod);
}

/**
 * Fingerprint one changed file by content identity, not just by path.
 *
 * `git status` keeps reporting the same path after a second edit, so hashing
 * paths alone would silently skip a rebuild. mtime + size changes on every
 * write and costs one stat per changed file.
 */
async function fileSignature(repoRoot: string, file: ChangedFile): Promise<string> {
  if (file.deleted) return `${file.status}:${file.path}:deleted`;
  try {
    const info = await stat(join(repoRoot, file.path));
    return `${file.status}:${file.path}:${info.mtimeMs}:${info.size}`;
  } catch {
    return `${file.status}:${file.path}:missing`;
  }
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function readGitStatus(repoRoot: string): Promise<{ ok: boolean; lines: string[]; reason?: string }> {
  const result = await runCommand(
    "git",
    [
      "status", "--porcelain", "-uall", "--", ".",
      // Same brand set as isRelevant: keeping one list means the pathspec and the
      // filter cannot disagree about which directories are agent state.
      ...AGENT_STATE_DIRS.flatMap((dir) => [`:!${dir}`, `:!*/${dir}`]),
    ],
    { cwd: repoRoot, timeoutMs: 60_000, maxBytes: 8_000_000 },
  );
  if (result.code !== 0) {
    return { ok: false, lines: [], reason: (result.stderr || result.stdout).trim().slice(0, 300) };
  }
  return { ok: true, lines: result.stdout.split("\n").filter((line) => line.trim().length > 0) };
}

/**
 * Is `Pods/Manifest.lock` out of step with `Podfile.lock`?
 *
 * CocoaPods writes a copy of the resolved lock into the Pods directory during
 * `pod install`. When the two differ, the Pods project was generated from a
 * different dependency set and every target's "[CP] Check Pods Manifest.lock"
 * phase fails the build with "The sandbox is not in sync with the Podfile.lock".
 * The user cannot act on that from a build log, so the gate runs `pod install`
 * before building.
 *
 * The check is anchored to the Xcode container, not to the caller's cwd: the
 * Podfile that governs a workspace lives beside it. Walking up from a nested
 * cwd could land on an unrelated project's Podfile and run `pod install` in the
 * wrong place.
 *
 * Returns undefined when the container's directory has no Podfile - the caller
 * then skips `pod install` instead of guessing.
 */
export async function checkPodLockSync(
  containerPath: string,
): Promise<{ synced: boolean; podfileDir: string; reason: string } | undefined> {
  const dir = dirname(resolve(containerPath));
  try {
    await stat(join(dir, "Podfile"));
  } catch {
    return undefined;
  }

  const lockPath = join(dir, "Podfile.lock");
  const manifestPath = join(dir, "Pods", "Manifest.lock");
  let lock: string;
  try {
    lock = await readFile(lockPath, "utf8");
  } catch {
    // No resolved lock yet: pod install has never run here.
    return { synced: false, podfileDir: dir, reason: "Podfile.lock is missing" };
  }
  let manifest: string;
  try {
    manifest = await readFile(manifestPath, "utf8");
  } catch {
    return { synced: false, podfileDir: dir, reason: "Pods/Manifest.lock is missing (pod install has not run)" };
  }
  if (lock === manifest) return { synced: true, podfileDir: dir, reason: "Podfile.lock matches Pods/Manifest.lock" };
  return { synced: false, podfileDir: dir, reason: "Podfile.lock differs from Pods/Manifest.lock" };
}

export async function detectChanges(cwd: string): Promise<ChangeReport> {
  const root = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 30_000 });
  if (root.code !== 0) {
    return {
      repoRoot: cwd,
      unavailable: true,
      reason: "not a git repository",
      changed: [],
      newComponentFiles: [],
      podsNeedingInstall: [],
      fingerprint: "no-git",
      needsBuild: true,
    };
  }
  const repoRoot = root.stdout.trim();
  const status = await readGitStatus(repoRoot);
  if (!status.ok) {
    return {
      repoRoot,
      unavailable: true,
      reason: status.reason ?? "git status failed",
      changed: [],
      newComponentFiles: [],
      podsNeedingInstall: [],
      fingerprint: "no-git-status",
      needsBuild: true,
    };
  }

  const changed: ChangedFile[] = [];
  for (const line of status.lines) {
    const statusCode = line.slice(0, 2);
    let path = line.slice(3).trim();
    // Renames are reported as "old -> new"; the new path is what matters.
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/g, "");
    if (!isRelevant(path)) continue;
    changed.push({
      status: statusCode,
      path,
      untracked: statusCode === "??",
      deleted: statusCode.includes("D"),
    });
  }

  const pods = await loadPods(repoRoot);
  const newComponentFiles: Array<ChangedFile & { pods: string[] }> = [];
  const podsNeedingInstall = new Set<string>();
  for (const file of changed) {
    if (file.deleted) continue;
    const isNew = file.untracked || file.status.includes("A");
    if (!isNew) continue;
    const matched = podsForPath(file.path, pods);
    if (matched.length === 0) continue;
    newComponentFiles.push({ ...file, pods: matched });
    for (const pod of matched) podsNeedingInstall.add(pod);
  }

  const signatures = await Promise.all(changed.map((file) => fileSignature(repoRoot, file)));
  const fingerprint = hashString(signatures.sort().join("\n"));

  return {
    repoRoot,
    unavailable: false,
    changed,
    newComponentFiles,
    podsNeedingInstall: [...podsNeedingInstall].sort(),
    fingerprint,
    needsBuild: changed.length > 0,
  };
}

export interface PodInstallOutcome {
  ok: boolean;
  message: string;
  logFile: string;
  durationMs: number;
}

export async function runPodInstall(
  podfileDir: string,
  options: { timeoutMs: number; signal?: AbortSignal; logFile: string },
): Promise<PodInstallOutcome> {
  const started = Date.now();
  const result = await runCommand("pod", ["install", "--no-repo-update"], {
    cwd: podfileDir,
    timeoutMs: options.timeoutMs,
    maxBytes: 12_000_000,
    signal: options.signal,
  });
  const durationMs = Date.now() - started;
  const output = `$ pod install --no-repo-update (cwd ${podfileDir})\n\n${result.stdout}\n${result.stderr}`;
  // The log directory is created lazily by whatever wrote a log first; pod
  // install can be the very first thing a run does, so ensure it here.
  await mkdir(dirname(options.logFile), { recursive: true });
  await writeFile(options.logFile, output);
  const ok = result.code === 0;
  return {
    ok,
    durationMs,
    logFile: options.logFile,
    message: ok
      ? `pod install succeeded in ${(durationMs / 1000).toFixed(1)}s`
      : `pod install failed (exit ${result.code})\n${output.trim().split("\n").slice(-25).join("\n")}`,
  };
}

/** A short human summary of a change report for tool output. */
export function describeChanges(report: ChangeReport): string {
  if (report.unavailable) {
    return `change detection unavailable (${report.reason ?? "unknown"}); assuming a rebuild is needed`;
  }
  if (report.changed.length === 0) return "no build-relevant changes";
  const lines = [`${report.changed.length} build-relevant change(s)`];
  for (const file of report.changed.slice(0, 15)) {
    lines.push(`  ${file.status} ${file.path}`);
  }
  if (report.changed.length > 15) lines.push(`  … and ${report.changed.length - 15} more`);
  if (report.podsNeedingInstall.length > 0) {
    lines.push(`new component files -> pod install required: ${report.podsNeedingInstall.join(", ")}`);
  }
  return lines.join("\n");
}
