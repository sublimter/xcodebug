/**
 * xcodebug — drive a physical iOS device build/launch and stream its Xcode
 * console output into the current agent session.
 *
 * Console capture uses `xcrun devicectl device process launch --console` with
 * OS_ACTIVITY_DT_MODE=YES, which bridges the app's stdout/stderr plus os_log —
 * the same surface Xcode's debug console shows. No jailbreak, no debugger.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// `import type` is erased at compile time, so this specifier never reaches the
// runtime: it only has to name a module the loader can resolve for typechecking.
// `@earendil-works/pi-coding-agent` is the official one the engine documents for
// extensions; `@code-yeongyu/senpi` and the `@mariozechner/*` names are aliases
// the loader maps to the same module, so a fork-only name would tie this file to
// one distribution of the engine.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Capture, matchesFilter, type FoundLine } from "./capture.ts";
import { describeDevices, findProcessPid, listDevices, lookupProcess, pullCrashReport, resolveDevice, type DeviceInfo } from "./devices.ts";
import { asRecord, lastLines, runCommand, timestamp } from "./exec.ts";
import { buildForDevice, consoleLaunchArgs, installApp, terminateApp, type BuildOutcome, type BuildTarget } from "./xcode.ts";
import { checkPodLockSync, describeChanges, detectChanges, directorySignature, runPodInstall, type ChangeReport } from "./changes.ts";
import { clearArchives, pruneLogs } from "./archive.ts";

const CAPTURE_PREFIX = "xcodebug";
const PUSH_INTERVAL_MS = 4_000;
const PUSH_MAX_LINES = 80;
const MAX_ENDED_CAPTURES = 10;
/** How long a verification run may go quiet before we ask the user about it. */
const SILENCE_NOTICE_MS = 60_000;
/**
 * How long the syslog channel may emit nothing before its bridge is presumed
 * hung and restarted. The idevicesyslog process has been observed to stop
 * mid-run while still alive; the app was healthy and the console channel kept
 * producing lines, so only the syslog side needs this.
 */
const SYSLOG_SILENCE_MS = 30_000;
/**
 * When to look for a crash report after a console bridge goes down, each
 * counted from the attempt before. The device needs a few seconds to write one:
 * 8s after a watchdog kill, measured.
 */
const CRASH_REPORT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
/**
 * A report is dated by the phone's clock and a bridge's end by this machine's.
 * Without some slack, a phone running slightly behind would date the report of
 * the crash that took the bridge down to before it went.
 */
const DEVICE_CLOCK_SKEW_MS = 5_000;
/**
 * How long a log outlives its last write. Every run leaves a build log of
 * several megabytes and a capture log beside it, and nothing else removes them.
 */
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Actions that work whatever state `.xcodebug.json` is in: `doctor` reports it,
 * and reading or stopping a capture never uses it. Every other action refuses a
 * config that does not parse, because running as if there were none uses the
 * defaults the file was written to override. Listed as exemptions so that an
 * action added later refuses too.
 */
const CONFIG_FREE_ACTIONS = new Set(["doctor", "devices", "logs", "wait", "status", "stop", "await"]);

interface ProjectConfig {
  workspace?: string;
  project?: string;
  scheme?: string;
  configuration?: string;
  bundleId?: string;
  device?: string;
  derivedDataPath?: string;
  args?: string[];
  environment?: Record<string, string>;
}


interface SessionState {
  captures: Map<string, Capture>;
  /** Permanently ended captures, ordered by completion time for bounded history. */
  endedCaptures: Set<string>;
  activeCaptureId?: string;
  pushTimers: Map<string, ReturnType<typeof setInterval>>;
  pushCursors: Map<string, number>;
  /**
   * What this session built, per target and device: the tree each build was made
   * from, and its product as the build left it. A map, because one session
   * debugs several apps and the build of one says nothing about another. The
   * last entry is the most recent build.
   */
  builds: Map<string, { fingerprint: string; appPath: string; product: string; bundleId?: string; executable?: string }>;
  /** Old logs are cleared once per session, by its first run. */
  logsPruned?: boolean;
  /** Key of the new-component-file set pod install has already handled. */
  installedPodsFingerprint?: string;
  /** console capture id -> parallel syslog capture id. */
  companions: Map<string, string>;
  /** capture id -> timestamp of the last line seen by the push loop. */
  lastLineAt: Map<string, number>;
  /** Captures already reminded about silence, so the notice fires once. */
  silenceNotified: Set<string>;
  /** Capture id -> last few log lines, for the status widget. */
  recentLines: Map<string, string[]>;
  /** The ctx of the latest tool/command call, used to refresh UI status. */
  uiCtx?: ExtensionContext;
  /** Drives the status repaint so counters move even when pushing is off. */
  statusTimer?: ReturnType<typeof setInterval>;
  /** capture id -> syslog silence watchdog. */
  watchdogs: Map<string, ReturnType<typeof setInterval>>;
  /**
   * What a `restart` needs in order to relaunch the same app.
   *
   * `/xcodebug restart` is the mid-run answer to "I just changed the code": it
   * rebuilds, relaunches and reattaches without the user retyping the phrase or
   * the device. Holds one launch - the most recent in this session - which is
   * what the edit/restart loop needs; launching a second app replaces it, so
   * `restart` always targets the app launched last.
   */
  lastLaunch?: {
    bundleId: string;
    processName?: string;
    goal?: string;
    args?: string[];
    environment?: Record<string, string>;
    device?: string;
    scheme?: string;
    workspace?: string;
    project?: string;
    configuration?: string;
    derivedDataPath?: string;
    push?: "off" | "context" | "wake";
    match?: string;
    dualChannel?: boolean;
    /**
     * The shell line this run was started with, if any.
     *
     * A `restart` after a code edit is usually the first half of an
     * edit→restart→test loop; dropping the command would force the user to
     * retype it every cycle.
     */
    command?: string;
  };
  /**
   * What the run is doing before any capture exists (pod install, building,
   * installing). Rendered in the same footer/widget the captures later use, so
   * the status line is continuous from build through verification instead of a
   * stream of one-off messages.
   */
  runPhase?: { label: string; startedAt: number };
}

/**
 * Where this extension writes its logs.
 *
 * `ctx.agentDir` is declared on ExtensionContext but not every runtime populates
 * it: omp 18.12.6 builds the tool context from `cwd`, `sessionManager`, `ui` and
 * friends and leaves `agentDir` undefined. `join(undefined, ...)` then throws
 * Bun's `The "paths[0]" property must be of type string, got undefined` out of
 * every action that touches a log path - including `doctor`, which never
 * resolves a scheme - and the raw message names no field the user could fix.
 *
 * The fallback must not hardcode a brand (`.pi`, `.omp`, `.omo`, `.senpi` are all
 * this same engine): xcodebug is a generic pi extension. So derive it from what
 * the host does tell us, in order:
 *   1. `ctx.agentDir`, when the runtime supplies it;
 *   2. the session directory's parent - every brand stores sessions at
 *      `<agentDir>/sessions/<encoded-cwd>`, so the layout is the invariant;
 *   3. the `<PREFIX>_CODING_AGENT_DIR` override the host itself honours
 *      (senpi names it `${ENV_PREFIX}_CODING_AGENT_DIR`, prefix per brand).
 * Failing all three, throw with the missing input named: logging to a guessed
 * path would drop build and console logs somewhere nobody looks.
 */
function resolveAgentDir(ctx: ExtensionContext): string {
  // `agentDir` is not part of the published ExtensionContext (pi 1.4.0 has only
  // `cwd` and `sessionManager`); some hosts add it. `in` keeps this compiling
  // against the published types while still honouring a host that supplies it.
  if ("agentDir" in ctx) {
    const direct = ctx.agentDir;
    if (typeof direct === "string" && direct.length > 0) return direct;
  }

  try {
    const sessionDir = ctx.sessionManager?.getSessionDir?.();
    if (typeof sessionDir === "string" && sessionDir.length > 0) {
      const parent = dirname(sessionDir);
      // Default layout is `<agentDir>/sessions/<encoded-cwd>`, so the agent dir is
      // the grandparent. A host run with an explicit session store (`--session-dir`
      // or PI_CODING_AGENT_SESSION_DIR) points getSessionDir straight at that store
      // with no per-cwd level, and the analogue of the agent dir is its parent.
      // Without this branch such a host made every action that writes a log throw.
      return basename(parent) === "sessions" ? dirname(parent) : parent;
    }
  } catch {
    // No session manager in this context; try the environment override.
  }

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.endsWith("_CODING_AGENT_DIR")) continue;
    if (typeof value === "string" && value.length > 0) return value;
  }

  throw new Error(
    "xcodebug cannot locate the agent directory to write logs into: the runtime supplied no " +
      "ctx.agentDir, no session directory and no *_CODING_AGENT_DIR override.",
  );
}

/**
 * The project directory every file lookup is anchored to.
 *
 * The anchor is the tool context's `cwd`, which the published types declare and
 * every host populates. `pi.cwd` is not in the published `ExtensionAPI` (pi 1.4.0
 * omits it), so it is only consulted when a host happens to add it; the process
 * cwd is the last resort. Reading the wrong one here is not cosmetic:
 * `detectContainer(undefined)` walks nowhere, and build/launch then fail with
 * "No scheme found. Container: (none)" even from inside the workspace.
 */
function resolveProjectRoot(pi: ExtensionAPI, ctx?: ExtensionContext): string {
  // `ctx.cwd` is the published field; `pi.cwd` is an addition some hosts carry.
  const fromCtx = ctx?.cwd;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  if ("cwd" in pi) {
    const fromPi = pi.cwd;
    if (typeof fromPi === "string" && fromPi.length > 0) return fromPi;
  }
  return process.cwd();
}

function logDir(ctx: ExtensionContext): string {
  return join(resolveAgentDir(ctx), "logs", "xcodebug");
}

/** Where pulled device archives live. Shared by the puller and the cleaner. */
function archiveWorkDir(ctx: ExtensionContext): string {
  return join(logDir(ctx), "archive");
}

/**
 * Drop the previous run's archives now that a new build has landed.
 *
 * Every snapshot covers the device's last hour and they overlap almost fully,
 * so old ones explain nothing about the run that is starting and only cost
 * disk. A new build is the natural boundary: whatever happened before it
 * belongs to a different binary.
 */
async function clearArchiveBeforeNewRun(ctx: ExtensionContext): Promise<string | undefined> {
  const { removed, freedBytes } = await clearArchives(archiveWorkDir(ctx));
  // Archiving is off, so there is normally nothing here; only say so when a
  // snapshot from an older version was actually removed.
  if (removed === 0) return undefined;
  const mb = (freedBytes / 1024 / 1024).toFixed(0);
  return `archive: cleared ${removed} snapshot(s), freed ${mb} MB`;
}

/** A build is another run's only when target, configuration and device all match. */
function buildKeyOf(target: BuildTarget, device: DeviceInfo): string {
  return JSON.stringify([
    target.workspace, target.project, target.scheme, target.configuration, target.derivedDataPath,
    device.udid ?? device.id,
  ]);
}

async function readBundleExecutable(appPath: string): Promise<string | undefined> {
  const result = await runCommand(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", join(appPath, "Info.plist")],
    { timeoutMs: 15_000 },
  );
  const value = result.code === 0 ? result.stdout.trim() : "";
  return value.length > 0 ? value : undefined;
}

/** Read CFBundleIdentifier from a built .app, so launch works with only appPath. */
async function readBundleIdentifier(appPath: string): Promise<string | undefined> {
  const result = await runCommand(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", join(appPath, "Info.plist")],
    { timeoutMs: 15_000 },
  );
  const value = result.code === 0 ? result.stdout.trim() : "";
  return value.length > 0 ? value : undefined;
}

async function readConfig(cwd: string): Promise<ProjectConfig> {
  const path = join(cwd, ".xcodebug.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as ProjectConfig;
  } catch (error) {
    // Reading a config that does not parse as "no config" runs with the very
    // defaults it was written to override - another scheme, another device.
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Find the Xcode container that owns this directory.
 *
 * Walks up from cwd. Which container to use is decided by CocoaPods, not by
 * what happens to be on disk:
 *   - a directory holding `Podfile` or `Podfile.lock` is a CocoaPods project,
 *     and its `.xcworkspace` is the container that links the Pods targets;
 *   - otherwise a plain `.xcodeproj` is used as-is.
 *
 * Scanning only cwd fails as soon as the user runs the command from a
 * subdirectory, so the walk covers up to 8 levels.
 */
async function detectContainer(cwd: string): Promise<{
  workspace?: string;
  project?: string;
  cocoaPods: boolean;
  /** App containers found below cwd when more than one matched. */
  ambiguous?: string[];
}> {
  let dir = cwd;
  for (let depth = 0; depth < 8; depth += 1) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      break;
    }
    const names = new Set(entries.map((e) => e.name));
    const isCocoaPods = names.has("Podfile") || names.has("Podfile.lock");
    const workspace = entries.find((e) => e.isDirectory() && e.name.endsWith(".xcworkspace"));
    const project = entries.find((e) => e.isDirectory() && e.name.endsWith(".xcodeproj"));

    if (isCocoaPods) {
      // CocoaPods project: the workspace is required. If it is missing, the
      // user still needs `pod install`, but the project is the only container.
      if (workspace) return { workspace: join(dir, workspace.name), cocoaPods: true };
      if (project) return { project: join(dir, project.name), cocoaPods: true };
    } else if (project) {
      return { project: join(dir, project.name), cocoaPods: false };
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nothing above qualified. A monorepo can keep its app one level down (this
  // repo has Example/ here and no container at the root at all).
  const below = await findAppContainerBelow(cwd);
  if (below.container) return below.container;
  return { cocoaPods: false, ambiguous: below.ambiguous };
}

/**
 * Look for the app container *below* cwd, used only when the upward walk found
 * nothing.
 *
 * The signature is deliberately narrow: a directory counts only if it holds a
 * `Podfile` and an `.xcworkspace` side by side. That is what an app project
 * looks like, and it excludes the pod-only projects a monorepo is full of
 * (`Projects/*` here - about a hundred of them - none of which has a Podfile),
 * so they cannot be picked by accident.
 *
 * Ambiguity is reported rather than resolved: choosing which app to build is
 * not a decision this function is entitled to make.
 */
async function findAppContainerBelow(cwd: string): Promise<{
  container?: { workspace?: string; project?: string; cocoaPods: boolean };
  ambiguous: string[];
}> {
  const matches: Array<{ workspace: string; dir: string }> = [];
  const SKIP = new Set(["Pods", "Carthage", "node_modules", ".git", "build", "DerivedData"]);

  const scan = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (names.has("Podfile")) {
      const workspace = entries.find((e) => e.isDirectory() && e.name.endsWith(".xcworkspace"));
      if (workspace) {
        matches.push({ workspace: join(dir, workspace.name), dir });
        // A matched app is the answer for its subtree; do not look inside it.
        return;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")) continue;
      await scan(join(dir, entry.name), depth + 1);
    }
  };

  await scan(cwd, 0);
  if (matches.length === 1) return { container: { workspace: matches[0].workspace, cocoaPods: true }, ambiguous: [] };
  return { ambiguous: matches.map((m) => m.dir) };
}

/**
/**
 * How a new capture mirrors lines into the session.
 *
 * A verification run is useless if its logs never arrive, so pushing is the
 * default for both launch and syslog; only an explicit `push=off` opts out.
 * Kept in one place so the tool path and the /xcodebug path cannot disagree.
 */
function defaultPushMode(params: { push?: "off" | "context" | "wake" }): "off" | "context" | "wake" {
  return params.push ?? "context";
}

/**
 * Pick the scheme to build.
 *
 * This repo's convention is that the workspace and its app scheme share a name
 * (`MyApp.xcworkspace` -> scheme `MyApp`), so the container's own
 * name is the first guess. It is only a guess: a component demo's workspace
 * name need not match a scheme, so `withContainer` verifies it against
 * `xcodebuild -list` and falls back to reading the scheme files.
 */
function schemeFromContainer(container: string): string | undefined {
  const name = container.split("/").pop()?.replace(/\.(xcworkspace|xcodeproj)$/, "");
  return name && name.length > 0 ? name : undefined;
}

/**
 * The scheme that builds an installable `.app`, read from the scheme files.
 *
 * A workspace can list hundreds of pod schemes, and probing each with
 * `-showBuildSettings` takes seconds apiece, so this reads the XML instead:
 * an app scheme declares its product as `BuildableName = "X.app"`.
 *
 * A workspace usually holds no schemes of its own: the schemes live in the
 * sibling `.xcodeproj` that the workspace wraps (in this repo,
 * `MyApp.xcworkspace` has none while `MyApp.xcodeproj` has them), so
 * both are scanned.
 */
async function appSchemeFromFiles(containerPath: string): Promise<{
  scheme?: string;
  /** Directories that were searched, so a failure can say where it looked. */
  searched: string[];
}> {
  const candidates: string[] = [];
  const searched: string[] = [];
  // A workspace wraps its .xcodeproj and usually keeps no schemes itself, so the
  // sibling project (same directory, same base name) is scanned too.
  const roots = [containerPath];
  if (containerPath.endsWith(".xcworkspace")) {
    const sibling = containerPath.replace(/\.xcworkspace$/, ".xcodeproj");
    try {
      await readdir(sibling);
      roots.push(sibling);
    } catch {
      // No sibling project; the workspace's own schemes are all there is.
    }
  }
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(join(root, "xcshareddata", "xcschemes"));
    const users = join(root, "xcuserdata");
    try {
      for (const entry of await readdir(users, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.endsWith(".xcuserdatad")) {
          dirs.push(join(users, entry.name, "xcschemes"));
        }
      }
    } catch {
      // No per-user schemes; the shared directory is still worth trying.
    }
  }
  for (const dir of dirs) {
    searched.push(dir);
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".xcscheme")) continue;
        const file = join(dir, entry.name);
        try {
          const xml = await readFile(file, "utf8");
          if (/BuildableName\s*=\s*"[^"]*\.app"/.test(xml)) {
            candidates.push(entry.name.replace(/\.xcscheme$/, ""));
          }
        } catch {
          // An unreadable scheme is simply not a candidate; the error surfaces
          // through the "searched" list when nothing is found at all.
        }
      }
    } catch {
      // Directory absent or unreadable - recorded in `searched` either way.
    }
  }
  return { scheme: candidates[0], searched };
}

/**
 * Ask xcodebuild for the schemes it knows.
 *
 * The three outcomes must stay distinct: "listed, and the guess is there",
 * "listed, and it is not", and "could not list". Collapsing the last into an
 * empty list made a failed `xcodebuild -list` silently accept a guessed scheme,
 * which then failed later with an unrelated-looking build error.
 */
async function listSchemes(
  container: { workspace?: string; project?: string },
  cwd: string,
): Promise<{ ok: boolean; schemes: string[]; reason?: string }> {
  const flag = container.workspace ? "-workspace" : "-project";
  const path = container.workspace ?? container.project;
  if (!path) return { ok: false, schemes: [], reason: "no container" };
  const result = await runCommand("xcodebuild", [flag, path, "-list", "-json"], { cwd, timeoutMs: 120_000 });
  if (result.code !== 0) {
    return {
      ok: false,
      schemes: [],
      reason: `xcodebuild -list exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      workspace?: { schemes?: string[] };
      project?: { schemes?: string[] };
    };
    return { ok: true, schemes: parsed.workspace?.schemes ?? parsed.project?.schemes ?? [] };
  } catch {
    return { ok: false, schemes: [], reason: "xcodebuild -list returned unparseable JSON" };
  }
}

function resolveBuildTarget(config: ProjectConfig, params: {
  scheme?: string;
  workspace?: string;
  project?: string;
  configuration?: string;
  derivedDataPath?: string;
  extraArgs?: string[];
}): BuildTarget {
  const scheme = params.scheme ?? config.scheme;
  if (!scheme) {
    throw new Error(
      'No scheme: pass scheme, or add "scheme" to .xcodebug.json in the project root. ' +
        "List schemes with: xcodebuild -workspace <path>.xcworkspace -list",
    );
  }
  return {
    scheme,
    workspace: params.workspace ?? config.workspace,
    project: params.project ?? config.project,
    configuration: params.configuration ?? config.configuration ?? "Debug",
    derivedDataPath: params.derivedDataPath ?? config.derivedDataPath,
    extraArgs: params.extraArgs,
  };
}

/**
 * `match`/`grep` as the reads take them: a substring, or a pattern when the
 * caller set `regex`. A pattern is what lets one wait cover both outcomes
 * ("sync (done|failed)"), where a substring can only ever name one.
 */
function toFilter(text: string | undefined, regex: boolean | undefined): string | RegExp | undefined {
  if (!text || !regex) return text;
  try {
    return new RegExp(text);
  } catch (error) {
    throw new Error(`"${text}" is not a valid regular expression: ${(error as Error).message}`);
  }
}

/**
 * What a reply owes its reader when the lines asked for start before the buffer
 * does: without it "no match" reads as "never logged" when the line was only
 * evicted. `missing` is absent for a read that did not look on disk.
 */
function evictedNote(read: { evicted: number; missing?: number }, logFile: string): string {
  if (read.evicted === 0) return "";
  if (read.missing === undefined) {
    return `\nnote: ${read.evicted} older line(s) are no longer in memory; read them from ${logFile}`;
  }
  const found = read.evicted - read.missing;
  const parts = [
    found > 0 ? `${found} line(s) no longer in memory were searched in ${logFile}` : "",
    // Overwritten by rotation, or never written: either way this read cannot speak for them.
    read.missing > 0 ? `${read.missing} line(s) are in neither memory nor the log files and were not searched` : "",
  ];
  return `\nnote: ${parts.filter(Boolean).join("; ")}`;
}

/**
 * The last thing a capture logged that xcodebug did not write itself.
 *
 * devicectl reports a death in its own words ("App terminated due to signal 9.")
 * as it exits; when it said nothing, the app's last line is the next best lead.
 */
function lastWords(capture: Capture): string | undefined {
  const lines = capture.read({ limit: 20 }).lines.filter((line) => !line.text.startsWith("[xcodebug]"));
  return lines.at(-1)?.text.slice(0, 200);
}

/**
 * What is settled about a capture that ended on its own: why, and the crash
 * report its app left on the device. Empty while neither is known.
 */
function endedNote(capture: Capture): string {
  const reason = capture.endReason ? ` · ${capture.endReason}` : "";
  const termination = capture.terminationReason ? ` · system termination: ${capture.terminationReason}` : "";
  return `${reason}${termination}${capture.crashReport ? ` · crash report: ${capture.crashReport}` : ""}`;
}

/**
 * The same for a reply that finds a console bridge already down. Whether the app
 * died or only the bridge dropped is settled a moment after the bridge goes;
 * until then the capture's last line is what there is to go on.
 */
function whyEnded(capture: Capture): string {
  const last = capture.endReason ? undefined : lastWords(capture);
  return `${last ? ` · last line: "${last}"` : ""}${endedNote(capture)}`;
}

/** Host time of a line, for lining a log up with a test runner's own output. */
function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} `;
}

async function formatLogLines(
  capture: Capture,
  options: { since: number; limit: number; grep?: string | RegExp; times?: boolean; signal?: AbortSignal },
): Promise<{ text: string; cursor: number; total: number }> {
  const { since, limit, grep } = options;
  // A filtered read looks on disk for what the buffer dropped. An unfiltered one
  // returns the newest lines anyway, so the dropped ones only add to "omitted".
  const read = grep ? await capture.search({ since, limit, grep, signal: options.signal }) : capture.read({ since, limit });
  const total = grep ? read.total : read.total + read.evicted;
  const note = evictedNote(read, capture.logFile);
  if (read.lines.length === 0) {
    const what = grep ? `no line matching ${typeof grep === "string" ? `"${grep}"` : grep}` : "no new lines";
    return { text: `(${what} since ${since}; capture cursor is ${read.cursor})${note}`, cursor: read.cursor, total: 0 };
  }
  const lines: FoundLine[] = read.lines;
  const body = lines
    .map((line) => {
      // In console mode devicectl's own status lines arrive on stdout while the
      // app's output arrives on stderr, so only stdout needs a label.
      const tag = capture.mode === "console" && line.stream === "out" ? "[devicectl] " : "";
      return `${String(line.index).padStart(6, " ")} ${options.times ? clock(line.at) : ""}${tag}${line.text}`;
    })
    .join("\n");
  const omitted = total - lines.length;
  const header = `${lines.length} line(s)${omitted > 0 ? ` (${omitted} older omitted)` : ""} · cursor ${read.cursor}`;
  return { text: `${header}\n${body}${note}`, cursor: read.cursor, total };
}

/** Fill in the container when the caller and the config both omit it. */
async function withContainer(
  cwd: string,
  config: ProjectConfig,
  params: { scheme?: string; workspace?: string; project?: string; configuration?: string; derivedDataPath?: string; extraArgs?: string[] },
): Promise<BuildTarget> {
  const detected = await detectContainer(cwd);
  const workspace = params.workspace ?? config.workspace ?? detected.workspace;
  const project = params.project ?? config.project ?? detected.project;
  const configuration = params.configuration ?? config.configuration ?? "Debug";
  const container = workspace ?? project;
  // An explicit scheme wins. Otherwise the container's own name is the first
  // guess, checked against the container's real scheme list: a component demo's
  // workspace name need not be a scheme, and an unknown scheme makes xcodebuild
  // fail with a message that hides the real problem.
  let scheme = params.scheme ?? config.scheme;
  if (!scheme && container) {
    const guess = schemeFromContainer(container);
    if (guess) {
      const listed = await listSchemes({ workspace, project }, cwd);
      if (listed.ok && listed.schemes.includes(guess)) {
        scheme = guess;
      } else {
        // Either the guess is absent from a list we could read, or the list
        // could not be read at all - both need the file scan.
        const scanned = await appSchemeFromFiles(container);
        if (scanned.scheme) {
          scheme = scanned.scheme;
        } else if (!listed.ok) {
          // The list could not be read, so the guess is unverified rather than
          // wrong. Use it and let xcodebuild report; there is no better evidence
          // to act on, and refusing here would block a build that may well work.
          scheme = guess;
        } else {
          // The list was read and the guess is not in it, and no scheme file
          // declares an .app product: the guess is known to be wrong. Carrying
          // on would fail later with a message that hides this.
          throw new Error(
            `Scheme "${guess}" is not in xcodebuild -list and no scheme file declares a .app product. ` +
              `Pass scheme=..., or add "scheme" to .xcodebug.json. ` +
              `Container: ${container}. Searched: ${scanned.searched.join(", ") || "(no scheme directories)"}.`,
          );
        }
      }
    }
  }
  if (!scheme) {
    throw new Error(
      "No scheme found. Pass scheme=..., or add \"scheme\" to .xcodebug.json. " +
        `Container: ${container ?? "(none)"}.` +
        // More than one app project sits below cwd, so naming them beats
        // leaving the user to guess why nothing was picked.
        (detected.ambiguous && detected.ambiguous.length > 0
          ? ` Found several app projects below ${cwd}: ${detected.ambiguous.join(", ")}. ` +
            `Run from one of them, or pass workspace=... .`
          : ""),
    );
  }
  return resolveBuildTarget(config, { ...params, scheme, workspace, project, configuration });
}

/**
 * Split a command line into tokens, honouring quotes.
 *
 * `command="npm run test:weather"` has to survive as ONE value: splitting
 * on whitespace would turn the rest of the shell line into goal words and run
 * `npm` with no arguments. Both quote styles are accepted, and a quote may sit
 * anywhere in a token so `command="cd a b && npm test"` works too.
 */
function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}
/**
 * Turn a command line into tool params.
 *
 * `/xcodebug 验证天气添加城市`  -> launch, with the phrase as the log filter goal
 * `/xcodebug logs grep=MySDK` -> logs
 * `/xcodebug stop`              -> stop
 *
 * Bare key=value tokens override anything derived from the free-text goal.
 */
function parseCommandArgs(raw: string): ToolParams {
  // `command=` is a whole shell line, but the tokenizer splits on whitespace
  // before the value is ever read: unquoted, `command=cd /repo && npm test`
  // arrives as command="cd" and the rest of the line is silently demoted to
  // goal words. `cd` with no arguments exits 0, so the run reports success
  // having run no test at all - the one failure that looks exactly like a pass.
  // Quoting is always available, so refuse the shape instead of guessing.
  if (/(?:^|\s)(?:--)?command=/.test(raw) && !/(?:^|\s)(?:--)?command=["']/.test(raw)) {
    throw new Error(
      'command= must be quoted: command="cd /repo && npm run test". ' +
        "Unquoted, only the first word reaches the shell line.",
    );
  }
  const tokens = tokenizeArgs(raw);
  const known = new Set([
    "devices", "changes", "build", "install", "launch", "syslog",
    "logs", "wait", "status", "stop", "terminate", "doctor", "restart", "await",
  ]);

  const params: Record<string, unknown> = {};
  const free: string[] = [];
  const numberKeys = ["limit", "since", "timeoutSeconds"];
  const boolKeys = ["force", "installPods", "dualChannel", "keepApp", "terminateExisting", "build", "regex", "times"];

  const assign = (key: string, value: string): void => {
    if (numberKeys.includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) params[key] = n;
    } else if (boolKeys.includes(key)) {
      params[key] = value !== "false";
    } else {
      params[key] = value;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // `--key=value` and `--key value` are both ordinary ways to spell a param.
    // A bare `--flag` is a switch: turning it into a goal word would silently
    // describe the run as verifying "--force".
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eqFlag = body.indexOf("=");
      if (eqFlag > 0) {
        assign(body.slice(0, eqFlag), body.slice(eqFlag + 1));
        continue;
      }
      const next = tokens[index + 1];
      if (!boolKeys.includes(body) && next !== undefined && !next.startsWith("-")) {
        assign(body, next);
        index += 1;
      } else if (numberKeys.includes(body)) {
        throw new Error(`--${body} needs a numeric value`);
      } else {
        params[body] = true;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      assign(token.slice(0, eq), token.slice(eq + 1));
    } else {
      free.push(token);
    }
  }

  const head = free[0];
  if (head && known.has(head)) {
    params.action = head;
    free.shift();
  } else {
    // Bare `/xcodebug` and `/xcodebug 分析xxx` both mean "start the run": launch
    // the app and keep listening with no deadline, so the user stays in control.
    // `command=` is NOT an action - it is an extra phase appended to whatever
    // the main action is (see `runCaseThenStop`), because a command run is only
    // useful when the app is already being captured.
    params.action = "launch";
  }

  const goal = free.join(" ").trim();
  if (goal) {
    // The goal is a human phrase ("验证天气添加城市"); it is not a log filter.
    params.goal = goal;
  }
  return params as unknown as ToolParams;
}

type ToolParams = {
  action: string;
  /** Free-text description of what the user wants verified (command path only). */
  goal?: string;
  device?: string;
  scheme?: string;
  workspace?: string;
  project?: string;
  configuration?: string;
  derivedDataPath?: string;
  bundleId?: string;
  appPath?: string;
  processName?: string;
  captureId?: string;
  since?: number;
  limit?: number;
  grep?: string;
  match?: string;
  /** `match`/`grep` are regular expressions rather than substrings. */
  regex?: boolean;
  /** Prefix returned lines with the host time they arrived. */
  times?: boolean;
  timeoutSeconds?: number;
  push?: "off" | "context" | "wake";
  force?: boolean;
  installPods?: boolean;
  changes?: boolean;
  dualChannel?: boolean;
  terminateExisting?: boolean;
  keepApp?: boolean;
  build?: boolean;
  /** `await`/`command=`: a shell line run to completion after the app is up. */
  command?: string;
  args?: string[];
  environment?: Record<string, string>;
};

export default function xcodebug(pi: ExtensionAPI): void {
  const state: SessionState = {
    captures: new Map(),
    endedCaptures: new Set(),
    pushTimers: new Map(),
    pushCursors: new Map(),
    builds: new Map(),
    companions: new Map(),
    lastLineAt: new Map(),
    silenceNotified: new Set(),
    recentLines: new Map(),
    watchdogs: new Map(),
  };

  // History can evict an ended capture before its launch-result cleanup finishes.
  const ownedCaptures = new Set<Capture>();
  const retiredCleanupWarnings: string[] = [];
  let shuttingDown = false;
  const startCapture = async (capture: Capture, signal?: AbortSignal): Promise<void> => {
    if (shuttingDown) throw new Error("xcodebug session is shutting down");
    ownedCaptures.add(capture);
    const release = (): void => {
      const result = capture.launchResult;
      void capture.waitForLaunchResults().then(() => {
        if (!shuttingDown && !capture.running && !capture.starting && capture.launchResult === result &&
            ownedCaptures.delete(capture)) {
          for (const error of capture.launchResultCleanupErrors ?? []) retiredCleanupWarnings.push(`${capture.id}: ${error}`);
          capture.launchResultCleanupErrors = undefined;
        }
      });
    };
    const unsubscribe = capture.onExit(() => { unsubscribe(); release(); });
    try {
      await capture.start(signal);
      if (shuttingDown) throw new Error("xcodebug session is shutting down");
    } finally {
      if (!capture.running) {
        unsubscribe();
        release();
      }
    }
  };

  /**
   * Paint the live verification state: a footer line that is always visible and
   * a widget above the editor with the most recent log lines. Both are cleared
   * when no operation or capture is running, so a finished task leaves no stale chrome.
   */
  const refreshStatus = (): void => {
    const ctx = state.uiCtx;
    if (!ctx?.hasUI) return;
    const phase = state.runPhase;
    if (phase) {
      const secs = Math.round((Date.now() - phase.startedAt) / 1000);
      ctx.ui.setStatus("xcodebug", `🔨 xcodebug · ${phase.label} · ${secs}s`);
      ctx.ui.setWidget("xcodebug", ["Xcodebug · running", `  ${phase.label}`, `  ${secs}s`], {
        placement: "aboveEditor",
      });
      return;
    }
    const running = [...state.captures.values()].filter((c) => c.running);
    if (running.length === 0) {
      ctx.ui.setStatus("xcodebug", undefined);
      ctx.ui.setWidget("xcodebug", undefined);
      return;
    }

    // Prefer a channel that is actually pushing: a push=off capture shows no
    // lines in the widget, so featuring it would misreport the run as silent.
    const primary =
      running.find((c) => state.companions.has(c.id)) ??
      running.find((c) => c.pushMode !== undefined) ??
      running[0];
    const status = primary.status();
    const lastAt = primary.lastLineAt;
    const silentSec = Math.round((Date.now() - lastAt) / 1000);
    const elapsed = Math.round((Date.now() - status.startedAt) / 1000);
    const silence = silentSec >= 60 ? ` · quiet ${silentSec}s` : "";
    ctx.ui.setStatus(
      "xcodebug",
      `📖 xcodebug · capturing · ${status.lineCount} lines · ${elapsed}s${silence} · /xcodebug stop to end`,
    );

    // Read the tail from the capture itself, not from `recentLines`: that map is
    // only fed by the push loop, so a push=off run left the widget claiming
    // "(waiting for the first line…)" while tens of thousands of lines had
    // already been captured.
    const recent =
      state.recentLines.get(primary.id) ??
      primary.read({ limit: 5 }).lines.map((line) => line.text);
    // Report the pushed channels only: a syslog companion is a safety net, not a
    // second stream into the session, and counting it would overstate coverage.
    // A push=off run has no pushed channel at all - saying "0 streaming" next to
    // a five-figure line count reads as "nothing is being captured", which is
    // the opposite of what is happening, so name the mode instead.
    const pushed = running.filter((c) => c.pushMode !== undefined).length;
    const modeText = pushed > 0 ? `(${pushed} streaming)` : "(push off · pull with logs)";
    const header = `Xcodebug · capturing ${modeText} · ${status.bundleId}`;
    const summary = `${status.lineCount} lines · ${elapsed}s${silence}`;
    const rows =
      recent.length > 0
        ? recent.slice(-4).map((line) => `  ${line.slice(0, 110)}`)
        : ["  (waiting for the first line…)"];
    ctx.ui.setWidget("xcodebug", [header, `  ${summary}`, ...rows], { placement: "aboveEditor" });
  };

  /**
   * Repaint on a slow timer so the elapsed/quiet counters keep moving even when
   * pushing is off. Without it the widget freezes on the last pushed line and
   * reads as a stalled run.
   */
  const startStatusTicker = (): void => {
    // Paint now, not on the first tick: the run must be visible the moment it
    // starts, and a sub-second capture would otherwise never show at all.
    refreshStatus();
    if (state.statusTimer) return;
    const timer = setInterval(() => {
      const active =
        state.runPhase !== undefined || [...state.captures.values()].some((c) => c.running);
      if (!active) {
        stopStatusTicker();
        refreshStatus();
        return;
      }
      refreshStatus();
    }, 1_000);
    timer.unref?.();
    state.statusTimer = timer;
  };

  const stopStatusTicker = (): void => {
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.statusTimer = undefined;
  };

  /**
   * Show what the run is doing before it has a capture, in place.
   *
   * Build progress arrives several times a second; reporting each frame as its
   * own message buried the conversation. One repainted line keeps it readable
   * and matches where the capture status appears a moment later.
   */
  const setRunPhase = (label: string): void => {
    const startedAt = state.runPhase?.startedAt ?? Date.now();
    state.runPhase = { label, startedAt };
    startStatusTicker();
  };

  const clearRunPhase = (): void => {
    state.runPhase = undefined;
    refreshStatus();
  };

  /** Release live bookkeeping and retain only the most recent ended captures. */
  const releaseCapture = (capture: Capture): void => {
    stopPush(capture.id);
    stopWatchdog(capture.id);
    unlinkCompanion(capture);
    state.recentLines.delete(capture.id);
    state.lastLineAt.delete(capture.id);
    state.silenceNotified.delete(capture.id);
    state.pushCursors.delete(capture.id);
    state.endedCaptures.add(capture.id);
    while (state.endedCaptures.size > MAX_ENDED_CAPTURES) {
      const oldest = state.endedCaptures.values().next().value!;
      state.endedCaptures.delete(oldest);
      state.captures.delete(oldest);
    }
    if (state.activeCaptureId === capture.id) state.activeCaptureId = undefined;
    if (![...state.captures.values()].some((c) => c.running)) stopStatusTicker();
    refreshStatus();
  };

  const stopPush = (captureId: string): void => {
    const timer = state.pushTimers.get(captureId);
    if (timer) clearInterval(timer);
    state.pushTimers.delete(captureId);
  };

  /** Stop the syslog silence watchdog for a capture that is ending. */
  const stopWatchdog = (captureId: string): void => {
    const timer = state.watchdogs.get(captureId);
    if (timer) clearInterval(timer);
    state.watchdogs.delete(captureId);
  };

  /** Is this the syslog channel that shadows a console capture rather than a primary? */
  const isCompanion = (capture: Capture): boolean =>
    [...state.companions.values()].includes(capture.id);

  /**
   * Drop the companion link in both directions.
   *
   * Stopping the console capture must stop its syslog companion, and stopping
   * the companion must clear the console's pointer to it; doing only one side
   * leaves a mapping that resolves to a capture nobody is running.
   */
  const unlinkCompanion = (capture: Capture): void => {
    const companionId = state.companions.get(capture.id);
    if (companionId) {
      state.companions.delete(capture.id);
      const companion = state.captures.get(companionId);
      if (companion) {
        stopPush(companion.id);
        stopWatchdog(companion.id);
        companion.stop(false);
      }
    }
    for (const [primaryId, id] of state.companions) {
      if (id === capture.id) state.companions.delete(primaryId);
    }
  };

  const stopCapture = (capture: Capture, terminateApp: boolean): void => {
    stopPush(capture.id);
    stopWatchdog(capture.id);
    // The syslog channel is a companion of the console capture; stop it too so
    // one "stop" does not leave a second bridge running.
    unlinkCompanion(capture);
    // Recent ended captures remain readable, but their live bookkeeping must stop.
    state.recentLines.delete(capture.id);
    state.lastLineAt.delete(capture.id);
    state.silenceNotified.delete(capture.id);
    state.pushCursors.delete(capture.id);
    if (![...state.captures.values()].some((c) => c !== capture && c.running)) stopStatusTicker();
    refreshStatus();
    capture.stop(terminateApp);
    if (!capture.running) releaseCapture(capture);
    if (state.activeCaptureId === capture.id) state.activeCaptureId = undefined;
  };


  /**
   * Mirror new lines into the session. Both modes are bounded: a physical-device
   * console is a firehose, so a push carries at most PUSH_MAX_LINES lines and
   * reports how many were dropped instead of flooding the context.
   */
  const startPush = (
    capture: Capture,
    mode: "context" | "wake",
    match?: string,
    options: { resume?: boolean } = {},
  ): void => {
    // Remember how this capture is mirrored so a reconnected bridge can resume
    // the same push instead of looking alive while the session goes deaf.
    capture.pushMode = mode;
    capture.pushMatch = match;
    // A resume keeps the cursor: restarting from 0 would re-push the whole log.
    if (!options.resume) state.pushCursors.set(capture.id, 0);
    else state.pushCursors.set(capture.id, capture.status().cursor);
    state.lastLineAt.set(capture.id, Date.now());
    state.silenceNotified.delete(capture.id);
    const timer = setInterval(() => {
      const since = state.pushCursors.get(capture.id) ?? 0;
      const read = capture.read({ since, limit: PUSH_MAX_LINES, grep: match });
      if (read.lines.length === 0) {
        // A verification run is driven by the user tapping the phone; silence
        // means either the task is done or they walked away. Ask once, never
        // stop the capture on our own.
        const lastAt = state.lastLineAt.get(capture.id) ?? Date.now();
        const silentMs = Date.now() - lastAt;
        if (
          silentMs >= SILENCE_NOTICE_MS &&
          !state.silenceNotified.has(capture.id) &&
          capture.running
        ) {
          state.silenceNotified.add(capture.id);
          try {
            pi.sendMessage(
              {
                customType: CAPTURE_PREFIX,
                content:
                  `[xcodebug] ${capture.bundleId} · no new log lines for ${Math.round(silentMs / 1000)}s. ` +
                  `Still capturing (cursor ${capture.status().cursor}). If nothing was tried on the phone yet, say what to do next - the run keeps listening.`,
                display: true,
                details: { captureId: capture.id, silence: true },
              },
              { deliverAs: "nextTurn" },
            );
          } catch {
            // Session teardown.
          }
        }
        refreshStatus();
        return;
      }
      state.lastLineAt.set(capture.id, Date.now());
      state.silenceNotified.delete(capture.id);
      const recent = state.recentLines.get(capture.id) ?? [];
      recent.push(...read.lines.map((line) => line.text));
      state.recentLines.set(capture.id, recent.slice(-5));
      refreshStatus();
      state.pushCursors.set(capture.id, read.cursor);
      const omitted = read.total - read.lines.length;
      const body = read.lines.map((line) => line.text).join("\n");
      const header = [
        `[xcodebug ${capture.mode}] ${capture.deviceLabel} · ${capture.bundleId} · ${read.lines.length} new line(s)${omitted > 0 ? ` (+${omitted} older dropped)` : ""}`,
        `cursor ${read.cursor}`,
      ].join(" · ");
      try {
        pi.sendMessage(
          {
            customType: CAPTURE_PREFIX,
            content: `${header}\n${body}`,
            // The model needs every line to analyse the run; the reader does not
            // need the firehose on screen. display:false keeps the content in
            // context and out of the transcript.
            display: false,
            details: { captureId: capture.id, cursor: read.cursor },
          },
          mode === "wake"
            ? { deliverAs: "steer", triggerTurn: true }
            : { deliverAs: "nextTurn" },
        );
      } catch {
        // The session may be shutting down; the file log still has everything.
      }
    }, PUSH_INTERVAL_MS);
    timer.unref?.();
    state.pushTimers.set(capture.id, timer);
  };

  /**
   * Sleep in short slices so `stop` interrupts a pending reconnect instead of
   * leaving the loop to wake up and probe the device once more after the user
   * has already ended the run.
   */
  const sleepUnlessStopped = async (capture: Capture, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!capture.stoppedByUser && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  };
  const isCurrentBridge = (capture: Capture, launch: number, result: Capture["launchResult"]): boolean =>
    state.captures.get(capture.id) === capture && capture.relaunches === launch && capture.launchResult === result;

  /**
   * Record the pid of the instance a console bridge has just launched.
   *
   * `replaced` can linger in the table after launch. A table snapshot is only
   * useful while this bridge is live; after exit, only that launch's command
   * result can identify the instance that ended.
   */
  const discoverAppPid = async (capture: Capture, device: DeviceInfo, replaced: number | undefined, signal = capture.signal): Promise<void> => {
    if (!capture.processName || capture.processExited) return;
    const launch = capture.relaunches;
    const result = capture.launchResult;
    const deadline = Date.now() + 20_000;
    const onAbort = (): void => capture.abort.abort(signal.reason);
    if (signal.aborted) onAbort();
    else if (signal !== capture.signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!capture.signal.aborted && Date.now() < deadline && capture.running &&
        !capture.processExited && isCurrentBridge(capture, launch, result)) {
        const { pid } = await lookupProcess(device, capture.processName, { attempts: 1, signal: capture.signal });
        if (capture.processExited || capture.naturalExitAt !== undefined || !isCurrentBridge(capture, launch, result)) return;
        if (pid !== undefined && pid !== replaced) {
          capture.appPid = pid;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      if (signal !== capture.signal) signal.removeEventListener("abort", onAbort);
    }
  };

  /** One identity/report completion job per owned console-launch result. */
  const crashSearches = new Map<string, {
    launch: number;
    result: Capture["launchResult"];
    identity: Promise<number | undefined>;
    promise: Promise<void>;
  }>();
  const crashSearchAbort = new AbortController();

  /**
   * Look for the crash report of an app whose console bridge went down.
   *
   * The device writes one a few seconds after the process died, so this tries a
   * few times. A missing report is not proof of a crash. The search runs apart
   * from the capture:
   * `stop` a moment later must not call it off, since that is exactly how a run
   * that ends in a crash is wrapped up.
   */
  const fetchCrashReport = async (capture: Capture, device: DeviceInfo, pid: number): Promise<void> => {
    const executable = capture.processName;
    if (!executable || capture.naturalExitAt === undefined) return;
    const launch = capture.relaunches;
    const result = capture.launchResult;
    const since = capture.naturalExitAt - DEVICE_CLOCK_SKEW_MS;
    for (const delay of CRASH_REPORT_DELAYS_MS) {
      await sleep(delay, undefined, { signal: crashSearchAbort.signal });
      if (!isCurrentBridge(capture, launch, result)) return;
      const report = await pullCrashReport(device, executable, { since, pid, directory: dirname(capture.logFile),
        signal: crashSearchAbort.signal });
      if (crashSearchAbort.signal.aborted || !isCurrentBridge(capture, launch, result)) return;
      if (report) {
        capture.crashReport = report.path;
        if (!capture.endReason && report.terminationReason) endCapture(capture, "the app exited");
        capture.terminationReason = report.terminationReason ?? "not recorded in the crash report";
        capture.pushLine("err", `[xcodebug] system termination: ${capture.terminationReason}`);
        capture.pushLine("err", `[xcodebug] crash report: ${report.path}`);
        return;
      }
    }
    if (capture.endReason || capture.stoppedByUser) {
      capture.terminationReason = "unavailable: the device returned no matching crash report";
      capture.pushLine("err", `[xcodebug] system termination: ${capture.terminationReason}`);
    }
  };

  const startCrashReportSearch = (capture: Capture, device: DeviceInfo): void => {
    if (capture.mode !== "console" || capture.naturalExitAt === undefined || capture.crashReport ||
      state.captures.get(capture.id) !== capture) return;
    const launch = capture.relaunches;
    const result = capture.launchResult;
    const existing = crashSearches.get(capture.id);
    if (existing?.launch === launch && existing.result === result) return;
    // A live-table PID is not evidence of which instance this ended console owned.
    capture.appPid = undefined;
    const identity = (async (): Promise<number | undefined> => {
      const raw = await result;
      if (crashSearchAbort.signal.aborted || !isCurrentBridge(capture, launch, result)) return;
      let pid: unknown;
      try {
        const data = asRecord(JSON.parse(raw ?? ""));
        const info = asRecord(data.info);
        if (info.commandType === "devicectl.device.process.launch" && info.outcome === "success") {
          pid = asRecord(asRecord(data.result).process).processIdentifier;
        }
      } catch {
        // Missing or malformed launch output cannot establish instance ownership.
      }
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        capture.terminationReason = "unavailable: the app identity was not verified by the console launch";
        capture.pushLine("err", `[xcodebug] system termination: ${capture.terminationReason}`);
        return;
      }
      capture.appPid = pid;
      capture.terminationReason = undefined;
      return pid;
    })();
    const promise = (async (): Promise<void> => {
      try {
        const pid = await identity;
        if (pid !== undefined && !crashSearchAbort.signal.aborted && isCurrentBridge(capture, launch, result)) {
          await fetchCrashReport(capture, device, pid);
        }
      } catch (error) {
        if (!crashSearchAbort.signal.aborted && isCurrentBridge(capture, launch, result)) {
          capture.terminationReason = "unavailable: exit diagnostics failed";
          capture.pushLine("err", `[xcodebug] ${capture.terminationReason}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        const current = crashSearches.get(capture.id);
        if (current?.launch === launch && current.result === result) crashSearches.delete(capture.id);
      }
    })();
    crashSearches.set(capture.id, { launch, result, identity, promise });
  };

  const waitForCrashReport = async (capture: Capture, signal?: AbortSignal): Promise<void> => {
    const job = crashSearches.get(capture.id);
    if (!job || !isCurrentBridge(capture, job.launch, job.result) || signal?.aborted) return;
    const pending = job.promise;
    if (!signal) {
      await pending;
      return;
    }
    let onAbort: () => void = () => {};
    const cancelled = new Promise<void>(resolve => {
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  /**
   * End a console capture whose app is no longer the process it launched, and
   * say why where a later read will find it: a capture that just stops looks
   * the same as an app that went quiet.
   */
  const endCapture = (capture: Capture, reason: string): void => {
    const last = lastWords(capture);
    capture.endReason = last ? `${reason}; last line before the bridge ended: "${last}"` : reason;
    capture.pushLine("err", `[xcodebug] ${capture.endReason}; stopping capture`);
    stopCapture(capture, false);
  };

  /**
   * Keep a capture alive for as long as the run lasts.
   *
   * `devicectl --console` is the only channel that carries the app's own
   * stdout/stderr (idevicesyslog sees system logs only). Its process can drop
   * while the app keeps running - a transient CoreDevice error, or the bridge
   * being torn down. Losing it silently would end log capture mid-verification,
   * so reconnect with backoff until the user stops the capture or the app dies.
   *
   * This function also installs the syslog silence watchdog, which only kills a
   * stalled bridge: reattachment is owned solely by the exit hook below.
   */
  const watchExit = (capture: Capture, device: DeviceInfo, onReconnect?: (n: number) => void): void => {
    let attempts = 0;
    let reconnecting = false;

    /**
     * Reattach a dropped bridge, retrying until the user stops or (console only)
     * the app exits.
     *
     * Both channels use this. `idevicesyslog` can also stop emitting while its
     * process stays alive, so `exit` is not the only entry point - the silence
     * watchdog calls this too. `reconnecting` keeps the two from racing.
     */
    const reconnect = async (): Promise<void> => {
      if (reconnecting) return;
      reconnecting = true;
      try {
        const label = capture.mode === "console" ? "console" : "syslog";
        while (!capture.stoppedByUser) {
          attempts += 1;
          const delay = Math.min(1000 * 2 ** (Math.min(attempts, 5) - 1), 15_000);
          await sleepUnlessStopped(capture, delay);
          if (capture.stoppedByUser) return;
          const diagnosis = crashSearches.get(capture.id);
          if (diagnosis && isCurrentBridge(capture, diagnosis.launch, diagnosis.result)) {
            try {
              await diagnosis.identity;
            } catch {
              // The diagnostic job records the failure; ownership remains unverified.
            }
            if (capture.stoppedByUser) return;
          }

          // Only the console channel is bound to the app's lifetime, so only it
          // consults the process table. A syslog bridge outlives the app and its
          // drops say nothing about whether the app is still running.
          // `listed` is the app's pid as the table has it now, when it could be read.
          let listed: number | undefined;
          if (capture.mode === "console" && capture.processName) {
            const lookup = await lookupProcess(device, capture.processName, {
              attempts: 1,
              signal: capture.signal,
            });
            // A stop that lands during the probe aborts it, which reads as a
            // failed query; carrying on would relaunch an app the user has let go.
            if (capture.stoppedByUser) return;
            if (lookup.queryFailed) {
              capture.pushLine("err", "[xcodebug] could not read the process table; still retrying");
              continue;
            } else if (lookup.pid === undefined) {
              endCapture(capture, "the app exited");
              return;
            } else if (capture.appPid !== undefined && lookup.pid !== capture.appPid) {
              // The console attaches only by launching, so reattaching here would
              // kill whatever started this instance - another session's capture,
              // which would then do the same to this one, or a test runner's app.
              endCapture(
                capture,
                `the app was restarted outside this capture (pid ${capture.appPid} -> ${lookup.pid}) and is left running`,
              );
              return;
            } else if (capture.appPid === undefined && capture.launchArgs.includes("--terminate-existing")) {
              endCapture(capture, "cannot verify ownership of the running app; it is left running");
              return;
            } else {
              listed = lookup.pid;
            }
          }

          capture.pushLine("err", `[xcodebug] reconnecting ${label} bridge (attempt ${attempts})`);
          capture.resetForReconnect();
          try {
            await startCapture(capture);
            if (capture.stoppedByUser) return;
            attempts = 0;
            onReconnect?.(1);
            // Resume pushing for whichever channel this is. The active-id check
            // cannot gate this: a syslog companion is never the active capture.
            if (capture.pushMode && state.pushTimers.get(capture.id) === undefined) {
              startPush(capture, capture.pushMode, capture.pushMatch, { resume: true });
            }
            // devicectl attaches a console only by launching, and this launch
            // terminates the instance that was running.
            if (capture.mode === "console" && capture.launchArgs.includes("--terminate-existing")) {
              capture.relaunches += 1;
              // Without a reading of the table the new pid cannot be told from
              // the old one, and none is better than one that may be wrong.
              capture.appPid = undefined;
              if (listed !== undefined) void discoverAppPid(capture, device, listed);
              capture.pushLine(
                "err",
                `[xcodebug] console bridge reattached - this relaunched the app (relaunch ${capture.relaunches}), so the state it had is gone`,
              );
            } else {
              capture.pushLine("err", `[xcodebug] ${label} bridge reattached`);
            }
            return;
          } catch (error) {
            capture.pushLine("err", `[xcodebug] reconnect failed: ${(error as Error).message}`);
          }
        }
      } finally {
        reconnecting = false;
      }
    };

    capture.onProcessExit(() => startCrashReportSearch(capture, device));

    capture.onExit((code, signal) => {
      stopPush(capture.id);
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
      capture.pushLine("err", `[xcodebug] bridge ended (${reason})`);

      // A user stop is the only reason not to reconnect. Both channels are
      // reconnected: the syslog bridge can drop while the app is perfectly
      // healthy, and losing it silently would leave the console channel with no
      // backup - exactly the gap dual-channel exists to cover.
      if (capture.stoppedByUser) {
        releaseCapture(capture);
        return;
      }
      // Always hand off. If a reconnect loop is already running it returns at
      // once and keeps retrying on its own; if none is running, this starts it.
      // An earlier version skipped this while the watchdog was restarting, which
      // could leave the bridge dead with no loop alive to revive it.
      void reconnect();
    });

    // `idevicesyslog` can go silent while its process stays alive - no exit, no
    // error, just nothing more. The exit hook above never fires in that case, so
    // a stalled bridge is only detectable by watching the line flow.
    //
    // Silence by itself is ambiguous: an app that is simply idle looks exactly
    // like a hung bridge, and restarting on that signal alone churned a healthy
    // bridge every 30s. The console channel is the tie-breaker - it carries the
    // app's stdout/stderr *and* os_log, so while it is still receiving lines the
    // app is emitting and syslog's silence is real. When both are quiet, nothing
    // is happening and there is nothing to repair.
    //
    // A standalone `action=syslog` has no console channel to compare against, so
    // it gets no watchdog: guessing there caused false restarts, and a user who
    // asked for that channel can restart it themselves.
    const primaryId = [...state.companions].find(([, id]) => id === capture.id)?.[0];
    if (primaryId) {
      const timer = setInterval(() => {
        if (capture.stoppedByUser || reconnecting) return;
        const primary = state.captures.get(primaryId);
        const appEmitting =
          primary?.running === true && Date.now() - primary.lastLineAt < SYSLOG_SILENCE_MS;
        if (!appEmitting) return;
        if (Date.now() - capture.lastLineAt < SYSLOG_SILENCE_MS) return;
        capture.pushLine("err", `[xcodebug] syslog silent for ${Math.round(SYSLOG_SILENCE_MS / 1000)}s while the app is still logging; restarting the bridge`);
        // Kill without `stop()`: that would record a user intent this watchdog
        // does not have, and clearing it afterwards could undo a real stop.
        // Reattaching is left to the exit hook, which is the single path that
        // owns reconnection - calling it here too is what used to race.
        capture.lastLineAt = Date.now();
        capture.restartBridge();
      }, 5_000);
      timer.unref?.();
      state.watchdogs.set(capture.id, timer);
    }
  };


  /**
   * Retire the previous cycle's capture for one app.
   *
   * A verification loop is conclude -> edit -> relaunch, so a new capture must
   * end the old one for that app: otherwise the stale bridge keeps pushing
   * lines into the session (interleaved with the new run) and shows up as a
   * second live capture in `status`.
   *
   * Scoped by app rather than global: several apps are debugged in one session,
   * and relaunching one must not silence the others. `processName` is the app's
   * executable, which is what both channels record; a capture with no
   * processName cannot be matched and is left alone rather than guessed at.
   */
  const stopRunningCaptures = async (processName: string | undefined, exceptId?: string): Promise<void> => {
    if (!processName) return;
    const running = [...state.captures.values()].filter(
      (c) => c.running && c.processName === processName && c.id !== exceptId,
    );
    for (const capture of running) {
      stopCapture(capture, false);
    }
    for (const capture of running) {
      await capture.waitForExit(3_000);
    }
  };

  const requireCapture = (captureId?: string): Capture => {
    // A capture that exited (app quit or crashed) clears activeCaptureId but stays
    // in the map so its log file is still reachable. With one candidate left, an
    // explicit id is unnecessary — without this, `stop`/`logs` report a puzzling
    // `Unknown capture ""` even though the capture is right there.
    //
    // A launch also records two captures (console + its syslog companion) and the
    // command phase clears activeCaptureId when it stops the pair, so the plain
    // `stop` a user types next hits the same empty-id case with four entries in
    // the map. Falling back to the one running primary keeps that working: the
    // companion is excluded because stopping it alone would leave the console
    // bridge streaming, which is the opposite of what `stop` means.
    const running = [...state.captures.values()].filter((c) => c.running);
    const runningPrimaries = running.filter((c) => !isCompanion(c));
    const fallback =
      !captureId && !state.activeCaptureId
        ? (state.captures.size === 1
            ? state.captures.values().next().value
            : runningPrimaries.length === 1
              ? runningPrimaries[0]
              : undefined)
        : undefined;
    const id = captureId ?? state.activeCaptureId ?? fallback?.id;
    const capture = id ? state.captures.get(id) : undefined;
    if (!capture) {
      const known = [...state.captures.values()].map(
        (item) => `${item.id} (${item.mode}${item.running ? ", running" : ", ended"})`,
      );
      // Naming the ids matters here: several captures means the caller must pick
      // one, and an empty selector in the message reads like a bug in the tool.
      throw new Error(
        known.length > 0
          ? `${captureId ? `Unknown capture "${captureId}"` : "Several captures exist and none is active"} ` +
            `- pass captureId. Known: ${known.join(", ")}`
          : "No active capture. Run xcodebug with action=launch (or action=syslog) first.",
      );
    }
    return capture;
  };

  const resolveDeviceParam = async (selector: string | undefined, root: string): Promise<DeviceInfo> => {
    const config = await readConfig(root);
    const { device } = await resolveDevice(selector ?? config.device);
    return device;
  };

  /**
   * Decide what must happen before a device run.
   *
   * - New file inside a pod: `pod install` first (once per change set), because
   *   the generated Pods project will not compile a file it never saw.
   * - Any build-relevant change: rebuild and relaunch.
   * - `force`: rebuild regardless of the fingerprint.
   */
  const prepareRun = async (ctx: ExtensionContext, options: {
    /** Project root the change detection is anchored to. */
    root: string;
    force?: boolean;
    installPods?: boolean;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onUpdate?: (text: string) => void;
    /** The .xcworkspace/.xcodeproj this run targets; anchors the Podfile lookup. */
    containerPath?: string;
    /** Which of this session's builds would be reused; without one, a build is always needed. */
    buildKey?: string;
    preview?: boolean;
  }): Promise<{ report: ChangeReport; needsBuild: boolean; podInstall?: string; podInstallNeeded?: boolean; podInstallFailed: boolean; notes: string[] }> => {
    let report = await detectChanges(options.root, options.containerPath);
    const notes: string[] = [];
    let podInstallNote: string | undefined;
    let podInstallFailed = false;

    // Key on the set of new component files, not the whole-tree fingerprint:
    // an untracked pod file keeps showing up in git status, so a whole-tree key
    // would re-run pod install after every unrelated edit.
    const podKeyOf = (r: ChangeReport): string =>
      r.newComponentFiles
        .map((file) => `${file.path}:${file.pods.join(",")}`)
        .sort()
        .join("|");
    const podKey = podKeyOf(report);
    const newFilesNeedInstall =
      options.installPods !== false &&
      report.podsNeedingInstall.length > 0 &&
      state.installedPodsFingerprint !== podKey;

    // A lock/manifest mismatch breaks every target's "Check Pods Manifest.lock"
    // phase with an error the user cannot act on from a build log, so it forces
    // pod install regardless of which files changed.
    const lockCheck =
      options.installPods === false || !options.containerPath
        ? undefined
        : await checkPodLockSync(resolve(options.root, options.containerPath));
    const lockNeedsInstall = lockCheck !== undefined && !lockCheck.synced;

    if (newFilesNeedInstall || lockNeedsInstall) {
      // pod install only runs in the directory that owns this container's
      // Podfile. Searching elsewhere risks reinstalling another project's pods.
      const podfileDir = lockCheck?.podfileDir;
      if (options.preview && podfileDir) {
        return { report, needsBuild: true, podInstallNeeded: true, podInstallFailed: false, notes };
      }
      if (!podfileDir) {
        notes.push(
          `pod install skipped: no Podfile beside ${options.containerPath ?? "the container"} ` +
            `(${newFilesNeedInstall ? `new files in ${report.podsNeedingInstall.join(", ")}` : "Podfile.lock out of sync"})`,
        );
      } else {
        const why = lockNeedsInstall
          ? (lockCheck?.reason ?? "Podfile.lock out of sync")
          : `${report.podsNeedingInstall.join(", ")} changed`;
        options.onUpdate?.(`pod install (${why})…`);
        const outcome = await runPodInstall(podfileDir, {
          timeoutMs: (options.timeoutSeconds ?? 900) * 1000,
          signal: options.signal,
          logFile: join(logDir(ctx), `pod-install-${timestamp()}.log`),
        });
        podInstallNote = `${outcome.message}\nlog: ${outcome.logFile}`;
        if (!outcome.ok) {
          return { report, needsBuild: false, podInstall: podInstallNote, podInstallFailed: true, notes };
        }
        // pod install rewrites Podfile.lock and the Pods project, so re-read the
        // tree: storing the pre-install fingerprint would make the next launch
        // think the pods are still stale and install them again.
        report = await detectChanges(options.root, options.containerPath);
        // Record the key derived from the post-install tree, not the one that
        // triggered this install: pod install can change the new-file set, and a
        // stale key would make the next run skip an install it still needs.
        state.installedPodsFingerprint = podKeyOf(report);

        // The install is only meaningful if the lock actually converged. Re-check
        // rather than trusting the pre-install verdict.
        if (options.containerPath) {
          const after = await checkPodLockSync(resolve(options.root, options.containerPath));
          if (after && !after.synced) {
            podInstallNote += `\nwarning: Podfile.lock is still out of sync after pod install (${after.reason})`;
          }
        }
      }
    }

    // A build is reused only when it was made of this target, from this tree,
    // and its product is still what the build left behind: Xcode, or a raw
    // xcodebuild in another terminal, writes the same DerivedData path.
    const built = options.buildKey === undefined ? undefined : state.builds.get(options.buildKey);
    const needsBuild =
      options.force === true ||
      report.unavailable ||
      built?.fingerprint !== report.fingerprint ||
      (await directorySignature(built.appPath)) !== built.product;

    return { report, needsBuild, podInstall: podInstallNote, podInstallFailed, notes };
  };

  /**
   * Remember a successful build so the next run of the same target can reuse it.
   *
   * `before` is the tree the build started from. If the tree is different once
   * the build is over, something changed while it ran, and whether that change
   * made it into the product is unknowable - so the build is not remembered, the
   * next run builds again, and the returned note says why.
   */
  const rememberBuild = async (
    key: string,
    before: string,
    root: string,
    containerPath: string | undefined,
    outcome: BuildOutcome,
  ): Promise<string | undefined> => {
    if (!outcome.appPath) return undefined;
    const after = (await detectChanges(root, containerPath)).fingerprint;
    if (after !== before) {
      return "the working tree changed while this was building, so the next run builds again instead of reusing it";
    }
    const product = await directorySignature(outcome.appPath);
    if (product === undefined) return undefined;
    state.builds.set(key, {
      fingerprint: after,
      appPath: outcome.appPath,
      product,
      bundleId: outcome.bundleId,
      executable: outcome.executable,
    });
    return undefined;
  };

  /**
   * Run a shell command to completion, then stop the capture it was watching
   * and report what the run produced.
   *
   * This is the whole `await` action, and also the second phase of
   * `/xcodebug 分析xxx command="<shell line>"`: the phrase describes the goal,
   * the command is the automated driver for it, and the capture is stopped only
   * when the driver exits - never on a timer or a silence heuristic, both of
   * which used to end runs the user had not finished.
   */
  const runCaseThenStop = async (
    params: ToolParams,
    signal: AbortSignal | undefined,
    root: string,
  ): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> => {
    const timeoutMs = Math.min(Math.max(1, params.timeoutSeconds ?? 1_800), 7_200) * 1000;
    const startedAt = Date.now();
    // The capture is optional on purpose: a case run with nothing being
    // captured still reports its exit code instead of failing.
    const target = params.captureId
      ? state.captures.get(params.captureId)
      : state.activeCaptureId
        ? state.captures.get(state.activeCaptureId)
        : undefined;

    let bin: string;
    let argv: string[];
    let cwd: string | undefined;
    let label: string;
    if (!params.command) {
      throw new Error('await needs command="<shell line>".');
    }
    // A shell line, not an argv: the user pastes what they would type, which
    // includes the `cd` into whatever repo owns the test runner.
    bin = "/bin/sh";
    argv = ["-lc", params.command];
    cwd = root;
    label = params.command;

    const since = target?.status().cursor ?? 0;
    const linesAtStart = target?.status().lineCount ?? 0;
    const relaunchesAtStart = target?.relaunches ?? 0;
    const result = await runCommand(bin, argv, {
      cwd,
      timeoutMs,
      signal,
      // Keep the tail only: a full test log can run to megabytes, and the
      // console capture already holds the app side of the story.
      maxBytes: 400_000,
    });
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);

    // Stopping is scoped to the targeted capture: a second app under debug
    // keeps streaming. The app itself is left running (keepApp semantics), so
    // the screen stays where the case left it.
    let captureNote = "no capture was running; nothing to stop";
    if (target) {
      // A bridge that is already down went down by itself, and the reply has to
      // say so: "the case ran" and "the app died under the case" must not read
      // alike. Stopping still matters then - it calls off a pending reattach,
      // which would relaunch the app now that the case is over.
      const wasRunning = target.running && !target.processExited;
      const wasUserStopped = target.stoppedByUser && !target.endReason;
      stopCapture(target, false);
      // Report collection is independent; stop a queued reattach before awaiting it.
      if (!wasRunning && !wasUserStopped) await waitForCrashReport(target, signal);
      await target.waitForExit(5_000);
      const how = wasRunning
        ? `stopped ${target.id}`
        : wasUserStopped
          ? `${target.id} was already stopped`
          : `warning: ${target.id} was no longer capturing when the command finished${whyEnded(target)}`;
      const status = target.status();
      const added = Math.max(0, status.lineCount - linesAtStart);
      captureNote = `${how} · ${added} new line(s) · ${status.logFile}`;
      const relaunched = target.relaunches - relaunchesAtStart;
      if (relaunched > 0) {
        captureNote += `\nwarning: a console reattach relaunched the app ${relaunched} time(s) during this run; lines after a relaunch come from a fresh instance`;
      }
    }

    const verdict = result.timedOut
      ? `timed out after ${timeoutMs / 1000}s (process killed)`
      : `exit ${result.code}`;
    const tail = lastLines(`${result.stdout}\n${result.stderr}`, 40);
    const text = [
      `awaited ${label} · ${verdict} · ${elapsedS}s`,
      captureNote,
      target ? `next: xcodebug action=logs captureId=${target.id} since=${since} - analyse the app side of this run` : "",
      tail ? `--- last output ---\n${tail}` : "",
    ].filter(Boolean).join("\n");

    return {
      text,
      details: {
        command: params.command,
        exitCode: result.code,
        timedOut: result.timedOut,
        elapsedSeconds: elapsedS,
        captureId: target?.id,
        cursor: since,
        terminationReason: target?.terminationReason,
        crashReport: target?.crashReport,
      },
      // A non-zero exit is a failed case, and the caller must see it as such
      // rather than as a successful "run finished".
      isError: result.timedOut || result.code !== 0,
    };
  };

  /**
   * The single implementation behind both the tool and the /xcodebug command.
   *
   * Everything (build, install, launch, capture) lives here so the two surfaces
   * cannot drift apart.
   */
  const runAction = async (
    params: ToolParams,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> => {
    state.uiCtx = ctx;
    // Resolved once per action: `pi.cwd` is undefined under pi 1.4.0, and every
    // lookup below (config, change detection, container discovery, the command's
    // working directory) must agree on one root or they disagree about the project.
    const projectRoot = resolveProjectRoot(pi, ctx);
    const configRead = await readConfig(projectRoot).then(
      (value) => ({ value, error: undefined }),
      (error: Error) => ({ value: {} as ProjectConfig, error }),
    );
    const config = configRead.value;
    const action = params.action;
    if (configRead.error && !CONFIG_FREE_ACTIONS.has(action)) throw configRead.error;

    // The first run of a session clears out the logs nothing has written to in
    // a while, before it adds its own.
    if (!state.logsPruned && (action === "build" || action === "launch" || action === "syslog")) {
      state.logsPruned = true;
      await pruneLogs(logDir(ctx), LOG_RETENTION_MS);
    }

    if (action === "doctor") {
      const checks = await Promise.all([
        runCommand("xcodebuild", ["-version"], { timeoutMs: 30_000 }),
        runCommand("xcrun", ["devicectl", "--version"], { timeoutMs: 30_000 }),
        runCommand("idevicesyslog", ["--version"], { timeoutMs: 20_000 }),
      ]);
      const configLine = configRead.error
        ? configRead.error.message
        : Object.keys(config).length > 0 ? join(projectRoot, ".xcodebug.json") : "(none)";
      const lines = [
        `xcodebuild: ${checks[0].code === 0 ? checks[0].stdout.split("\n")[0] : "missing"}`,
        `devicectl: ${checks[1].code === 0 ? (checks[1].stdout || checks[1].stderr).trim().split("\n")[0] : "missing"}`,
        `idevicesyslog: ${checks[2].code === 0 ? (checks[2].stdout || checks[2].stderr).trim().split("\n")[0] : "missing (optional, syslog action only)"}`,
        `config: ${configLine}`,
        `log dir: ${logDir(ctx)}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    }

    if (action === "changes") {
      let buildKey: string | undefined;
      let containerPath: string | undefined;
      let unresolved: string | undefined;
      try {
        const target = await withContainer(projectRoot, config, params);
        containerPath = target.workspace ?? target.project;
        buildKey = buildKeyOf(target, await resolveDeviceParam(params.device, projectRoot));
      } catch (error) {
        unresolved = (error as Error).message;
        const detected = await detectContainer(projectRoot);
        containerPath ??= params.workspace ?? params.project ?? config.workspace ?? config.project ?? detected.workspace ?? detected.project;
      }
      const gate = await prepareRun(ctx, {
        root: projectRoot, containerPath: containerPath && resolve(projectRoot, containerPath),
        buildKey, force: params.force, installPods: params.installPods, preview: true,
      });
      const { report } = gate;
      const lastBuilt = buildKey === undefined ? undefined : state.builds.get(buildKey)?.fingerprint;
      const lines = [
        describeChanges(report),
        `fingerprint: ${report.fingerprint}`,
        `last build for this target: ${lastBuilt ?? "(none)"}`,
        `rebuild needed: ${gate.needsBuild ? "yes" : "no"}`,
        `pod install needed: ${gate.podInstallNeeded ? "yes" : "no"}`,
        ...gate.notes,
      ];
      if (unresolved) lines.push(`no reusable target resolved: ${unresolved}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { report, lastBuiltFingerprint: lastBuilt },
      };
    }

    if (action === "devices") {
      const devices = await listDevices();
      return { content: [{ type: "text", text: describeDevices(devices) }], details: { devices } };
    }

    if (action === "build") {
      // Painting from the first line means the run is visible while the scheme
      // is still being resolved, which itself takes a few seconds.
      setRunPhase("resolving the project…");
      const device = await resolveDeviceParam(params.device, projectRoot);
      const target = await withContainer(projectRoot, config, params);
      const buildKey = buildKeyOf(target, device);
      const containerPath = target.workspace ?? target.project;
      const gate = await prepareRun(ctx, {
        root: projectRoot,
        force: params.force,
        installPods: params.installPods,
        timeoutSeconds: params.timeoutSeconds,
        signal,
        containerPath,
        buildKey,
        onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
      });
      if (gate.podInstallFailed) {
        return {
          content: [{ type: "text", text: `${gate.podInstall}\n\n${describeChanges(gate.report)}` }],
          details: { report: gate.report },
          isError: true,
        };
      }
      if (!gate.needsBuild) {
        const summary =
          gate.report.changed.length === 0
            ? "nothing changed"
            : `${gate.report.changed.length} changed file(s), but they are unchanged`;
        return {
          content: [{ type: "text", text: `build skipped: ${summary} since this session's last successful build (fingerprint ${gate.report.fingerprint}; pass force=true to rebuild)` }],
          details: { report: gate.report, skipped: true },
        };
      }
      setRunPhase(`building ${target.scheme} for ${device.name}`);
      // Forgotten before the build, not after: one that fails can leave the
      // product half rewritten, which is no longer the build that was remembered.
      state.builds.delete(buildKey);
      const outcome = await buildForDevice(target, device, {
        logDir: logDir(ctx),
        cwd: projectRoot,
        // Several frames a second: repaint one line instead of emitting messages.
        onProgress: (text) => setRunPhase(text),
        timeoutMs: (params.timeoutSeconds ?? 900) * 1000,
        signal,
      });
      clearRunPhase();
      let notRemembered: string | undefined;
      if (outcome.ok) {
        notRemembered = await rememberBuild(buildKey, gate.report.fingerprint, projectRoot, containerPath, outcome);
        await clearArchiveBeforeNewRun(ctx);
      }
      const prefix = gate.podInstall ? `${gate.podInstall}\n` : "";
      return {
        content: [{ type: "text", text: `${prefix}${outcome.summary}${notRemembered ? `\nnote: ${notRemembered}` : ""}\nlog: ${outcome.logFile}` }],
        details: { ...outcome, report: gate.report },
        isError: !outcome.ok,
      };
    }

    if (action === "install") {
      const device = await resolveDeviceParam(params.device, projectRoot);
      const appPath = params.appPath;
      if (!appPath) throw new Error("install requires appPath (or use action=build first).");
      setRunPhase(`installing on ${device.name}`);
      const outcome = await installApp(device, appPath, { timeoutMs: (params.timeoutSeconds ?? 180) * 1000, signal });
      return {
        content: [{ type: "text", text: `${outcome.message}\napp: ${appPath}\ndevice: ${device.name}` }],
        details: outcome,
        isError: !outcome.ok,
      };
    }

    if (action === "restart") {
      // `/xcodebug restart` answers the mid-run question "I just changed the
      // code, now what?": rebuild, relaunch and reattach without retyping the
      // phrase, the device or the scheme. It replays the last launch's params,
      // so a restart after an edit is one word instead of the original command.
      const last = state.lastLaunch;
      if (!last) {
        throw new Error(
          "restart needs a previous launch in this session. Start one with `/xcodebug <goal>`, then `restart` after editing.",
        );
      }
      // The rebuild must happen even though nothing else changed about the
      // invocation: the point of restart is the edited code, and the pod/build
      // gate would otherwise reuse the stale build.
      const replay: ToolParams = {
        action: "launch",
        // Explicit args win over the remembered ones: `restart device=X` has to
        // target X, not silently relaunch on the previous device.
        goal: params.goal ?? last.goal,
        bundleId: params.bundleId ?? last.bundleId,
        processName: params.processName ?? last.processName,
        args: params.args ?? last.args,
        environment: params.environment ?? last.environment,
        device: params.device ?? last.device,
        scheme: params.scheme ?? last.scheme,
        workspace: params.workspace ?? last.workspace,
        project: params.project ?? last.project,
        configuration: params.configuration ?? last.configuration,
        derivedDataPath: params.derivedDataPath ?? last.derivedDataPath,
        push: params.push ?? last.push,
        match: params.match ?? last.match,
        dualChannel: params.dualChannel ?? last.dualChannel,
        terminateExisting: params.terminateExisting ?? true,
        // These two are per-invocation, not properties of the app, so they pass
        // straight through instead of being remembered. `appPath` deliberately
        // is not forwarded: `force` above always rebuilds, which overwrites it.
        installPods: params.installPods,
        timeoutSeconds: params.timeoutSeconds,
        // The command rides along so restart keeps an edit→restart→test loop intact.
        command: params.command ?? last.command,
        build: true,
        force: true,
      };
      const result = await runAction(replay, ctx, signal, onUpdate);
      return {
        content: [{
          type: "text",
          // Report the merged values, not `last`: an explicit override means the
          // app being relaunched is not the one remembered.
          text: `restarting ${replay.bundleId}${replay.processName ? ` (${replay.processName})` : ""}\n${result.content[0]?.text ?? ""}`,
        }],
        details: { restart: true, previous: last, launch: result.details },
        isError: result.isError,
      };
    }

    if (action === "launch") {
      setRunPhase("resolving the project…");
      const device = await resolveDeviceParam(params.device, projectRoot);
      let appPath = params.appPath;
      let bundleId = params.bundleId ?? config.bundleId;
      let executable: string | undefined;

      // Every run re-checks the working tree: new files in a pod need
      // `pod install`, and any build-relevant change needs a fresh build.
      // An explicit appPath means "use this app as-is". Only build when the
      // caller also asked for it; otherwise a missing scheme must not block.
      const explicitApp = params.appPath !== undefined;
      const wantsBuild = params.build === true || params.force === true;
      // Resolve the container up front: the Podfile that governs this run lives
      // beside it, so the pod gate must not search from an arbitrary cwd.
      const launchTarget = explicitApp && !wantsBuild ? undefined : await withContainer(projectRoot, config, params);
      const buildKey = launchTarget ? buildKeyOf(launchTarget, device) : undefined;
      const containerPath = launchTarget ? (launchTarget.workspace ?? launchTarget.project) : undefined;
      const gate = await prepareRun(ctx, {
        root: projectRoot,
        force: params.force,
        installPods: explicitApp && !wantsBuild ? false : params.installPods,
        timeoutSeconds: params.timeoutSeconds,
        signal,
        containerPath,
        buildKey,
        onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
      });
      const notes = [...gate.notes];
      if (gate.podInstall) notes.push(gate.podInstall);

      if (gate.podInstallFailed) {
        return {
          content: [{ type: "text", text: `${gate.podInstall}\n\n${describeChanges(gate.report)}` }],
          details: { report: gate.report },
          isError: true,
        };
      }

      // Rebuild when the tree changed, when this session has not built this
      // target yet, when the caller asked for a build, or when force is set.
      // `needsBuild` false means the gate found this target's build still good.
      const reused = buildKey === undefined || gate.needsBuild || wantsBuild ? undefined : state.builds.get(buildKey);
      const mustBuild = launchTarget !== undefined && buildKey !== undefined && reused === undefined;
      if (mustBuild) {
        setRunPhase(`building ${launchTarget.scheme} for ${device.name}`);
        // Forgotten before the build, for the reason `build` gives.
        state.builds.delete(buildKey);
        const build = await buildForDevice(launchTarget, device, {
          logDir: logDir(ctx),
          cwd: projectRoot,
          onProgress: (text) => setRunPhase(text),
          timeoutMs: (params.timeoutSeconds ?? 900) * 1000,
          signal,
        });
        clearRunPhase();
        if (!build.ok) {
          return {
            content: [{ type: "text", text: `${notes.join("\n")}\n${build.summary}\nlog: ${build.logFile}` }],
            details: build,
            isError: true,
          };
        }
        const notRemembered = await rememberBuild(buildKey, gate.report.fingerprint, projectRoot, containerPath, build);
        const cleared = await clearArchiveBeforeNewRun(ctx);
        if (cleared) notes.push(cleared);
        appPath = build.appPath;
        bundleId = build.bundleId ?? bundleId;
        executable = build.executable;
        notes.push(build.summary);
        if (notRemembered) notes.push(`note: ${notRemembered}`);
        if (!appPath) throw new Error(`Build succeeded but the product path is unknown.\nlog: ${build.logFile}`);
      } else if (reused) {
        appPath = reused.appPath;
        bundleId = reused.bundleId ?? bundleId;
        executable = reused.executable;
        notes.push(`reusing this session's build (nothing changed since fingerprint ${gate.report.fingerprint}; force=true rebuilds)\napp: ${appPath}`);
      }

      if (!appPath) throw new Error("launch requires appPath, or a scheme to build.");
      executable ??= params.processName ?? (await readBundleExecutable(appPath));

      // The instance this launch is about to replace, read before the install
      // because installing over a running app can end it already. The pid
      // recorded further down must not be this one, so when the table cannot be
      // read none is recorded.
      const before =
        executable && params.terminateExisting !== false
          ? await lookupProcess(device, executable, { attempts: 1, signal })
          : { queryFailed: false, pid: undefined };
      // Another session's capture, or the user's own running app: its state is
      // gone once this launch goes through, which is worth a line.
      if (before.pid !== undefined && ![...state.captures.values()].some((c) => c.appPid === before.pid)) {
        notes.push(`note: ${executable} was already running (pid ${before.pid}), not started by this session; this launch terminated it`);
      }

      setRunPhase(`installing on ${device.name}`);
      const install = await installApp(device, appPath, { timeoutMs: 180_000, signal });
      if (!install.ok) {
        return { content: [{ type: "text", text: install.message }], details: install, isError: true };
      }

      const resolvedBundleId = bundleId ?? params.bundleId ?? (await readBundleIdentifier(appPath));
      if (!resolvedBundleId) throw new Error("launch requires bundleId (or an appPath whose Info.plist carries one).");

      // Retire the previous run for this app BEFORE the new bridge starts.
      //
      // This used to run after `capture.start()`, to keep the session from being
      // left with no capture at all if starting the new one threw. That trade is
      // wrong in the common case: `devicectl --console` takes a second or two to
      // attach, and during that window the old capture is still pushing its
      // app's lines into the conversation - so a relaunch interleaves two runs
      // and the reader cannot tell which one a line belongs to. A failed start
      // reports its own error, which is a clearer outcome than mixed logs.
      await stopRunningCaptures(executable, undefined);

      // One launch only: devicectl --console starts the app, attaches its
      // stdout/stderr (plus os_log via OS_ACTIVITY_DT_MODE) and keeps running
      // until the app exits. A second plain launch would create a second,
      // short-lived instance and leave a stale pid behind.
      setRunPhase(`launching ${resolvedBundleId}`);
      const capture = new Capture({
        mode: "console",
        deviceId: device.id,
        deviceLabel: device.name,
        bundleId: resolvedBundleId,
        processName: executable,
        logDir: logDir(ctx),
        collectLaunchResult: true,
        command: "xcrun",
        args: consoleLaunchArgs(device, resolvedBundleId, {
          args: params.args ?? config.args,
          terminateExisting: params.terminateExisting !== false,
          environment: { ...(config.environment ?? {}), ...(params.environment ?? {}) },
        }),
      });
      await startCapture(capture, signal);
      state.captures.set(capture.id, capture);
      state.activeCaptureId = capture.id;
      watchExit(capture, device);
      const pushMode = defaultPushMode(params);
      if (pushMode !== "off") startPush(capture, pushMode, params.match);
      // Start the ticker after pushing is configured: the header counts pushed
      // channels, so painting before pushMode is set would show "0 streaming".
      startStatusTicker();
      // Remember enough to relaunch this same app when `/xcodebug restart` asks
      // for it after a code change. The device and the phrase are the parts a
      // user should not have to repeat.
      state.lastLaunch = {
        bundleId: resolvedBundleId,
        processName: executable,
        goal: params.goal,
        args: params.args ?? config.args,
        environment: { ...(config.environment ?? {}), ...(params.environment ?? {}) },
        device: params.device ?? config.device,
        scheme: params.scheme ?? config.scheme,
        workspace: params.workspace ?? config.workspace,
        project: params.project ?? config.project,
        configuration: params.configuration ?? config.configuration,
        derivedDataPath: params.derivedDataPath ?? config.derivedDataPath,
        push: params.push,
        match: params.match,
        dualChannel: params.dualChannel,
        command: params.command,
      };
      // The previous run for this app was already retired before this capture
      // started (see above), so nothing is left to stop here. Other apps'
      // captures are untouched either way.

      // Discover an operational PID while the console is live. Exit diagnosis
      // instead uses the identity from this launch's own command result.
      if (!before.queryFailed) await discoverAppPid(capture, device, before.pid, signal);
      if (signal?.aborted) {
        stopCapture(capture, false);
        await capture.waitForExit(3_000);
        signal.throwIfAborted();
      }
      // Finish console process discovery before opening another device log service.
      // Second channel: idevicesyslog reads the device's unified log directly
      // and survives a dropped --console bridge. It carries os_log only, so
      // NSLog/print lines (MySDK) stay exclusive to the console channel -
      // this is a safety net for the gap, not a replacement.
      if (executable && params.dualChannel !== false && !capture.stoppedByUser) {
        const syslogCapture = new Capture({
          mode: "syslog",
          deviceId: device.id,
          deviceLabel: device.name,
          bundleId: resolvedBundleId,
          processName: executable,
          logDir: logDir(ctx),
          command: "idevicesyslog",
          args: ["-u", device.udid ?? device.id, "-p", executable, "--no-colors"],
        });
        try {
          await startCapture(syslogCapture, signal);
          if (capture.stoppedByUser) {
            syslogCapture.stop(false);
            await syslogCapture.waitForExit(3_000);
          } else {
            state.captures.set(syslogCapture.id, syslogCapture);
            state.companions.set(capture.id, syslogCapture.id);
            watchExit(syslogCapture, device);
            notes.push(`syslog channel: ${syslogCapture.id}`);
          }
        } catch (error) {
          notes.push(`syslog channel unavailable: ${(error as Error).message}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: [
            ...notes,
            `launched ${resolvedBundleId} on ${device.name}${capture.appPid ? ` (pid ${capture.appPid})` : ""}`,
            `capture: ${capture.id} · push=${pushMode}`,
            `log: ${capture.logFile}`,
            "next: xcodebug action=logs (cursor is tracked per capture), or action=wait match=\"...\"",
          ].join("\n"),
        }],
        details: { capture: capture.status(), report: gate.report, built: mustBuild },
      };
    }

    if (action === "syslog") {
      const device = await resolveDeviceParam(params.device, projectRoot);
      const processName = params.processName ?? config.scheme;
      if (!processName) throw new Error("syslog requires processName (the app's executable/process name).");
      // Same ordering as `launch`: retire the previous bridge for this app before
      // the new one attaches, so the two never push the same app's lines at once.
      await stopRunningCaptures(processName, undefined);
      const args = ["-u", device.udid ?? device.id, "-p", processName, "--no-colors"];
      if (params.match) args.push("-m", params.match);
      const capture = new Capture({
        mode: "syslog",
        deviceId: device.id,
        deviceLabel: device.name,
        bundleId: params.bundleId ?? config.bundleId ?? processName,
        processName,
        logDir: logDir(ctx),
        command: "idevicesyslog",
        args,
      });
      await startCapture(capture, signal);
      state.captures.set(capture.id, capture);
      state.activeCaptureId = capture.id;
      watchExit(capture, device);
      const pushMode = defaultPushMode(params);
      if (pushMode !== "off") startPush(capture, pushMode, params.match);
      startStatusTicker();
      return {
        content: [{
          type: "text",
          text: [
            `syslog capture started for ${processName} on ${device.name} (app keeps running)`,
            `capture: ${capture.id} · push=${pushMode}`,
            `log: ${capture.logFile}`,
          ].join("\n"),
        }],
        details: { capture: capture.status() },
      };
    }

    if (action === "logs") {
      const capture = requireCapture(params.captureId);
      const since = params.since ?? 0;
      const formatted = await formatLogLines(capture, {
        since,
        limit: params.limit ?? 200,
        grep: toFilter(params.grep, params.regex),
        times: params.times,
        signal,
      });
      const companionId = state.companions.get(capture.id);
      if (!capture.running && companionId) {
        formatted.text += `\n\n[this channel has ended; system-level logs continue in ${companionId} - pass captureId=${companionId}]`;
      }
      // The lines that say so are in the log, but a filtered read leaves them out.
      if (capture.endReason) formatted.text += `\n\n[this capture ended on its own · ${capture.endReason}]`;
      if (capture.terminationReason) formatted.text += `\n[system termination: ${capture.terminationReason}]`;
      if (capture.crashReport) formatted.text += `\n[crash report: ${capture.crashReport}]`;
      return {
        content: [{ type: "text", text: formatted.text }],
        details: { captureId: capture.id, cursor: formatted.cursor, total: formatted.total, running: capture.running },
      };
    }

    if (action === "wait") {
      const capture = requireCapture(params.captureId);
      const needle = toFilter(params.match, params.regex);
      if (!needle) throw new Error("wait requires match (a substring to wait for, or a pattern with regex=true).");
      const shown = typeof needle === "string" ? `"${needle}"` : String(needle);
      const timeoutMs = Math.min(Math.max(1, params.timeoutSeconds ?? 30), 600) * 1000;
      const since = params.since ?? 0;

      const matches: FoundLine[] = [];
      const seen = new Set<number>();
      let finished = false;
      let cancelled = false;
      let deadlineExpired = false;
      // The backlog is read from disk too, which takes a moment. A line that
      // arrives meanwhile must not settle the wait ahead of the earlier ones.
      let backlogRead = false;
      let note = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribeLine: () => void = () => {};
      let unsubscribeExit: () => void = () => {};
      let onAbort: (() => void) | undefined;
      let resolveWait: (text: string) => void = () => {};

      const settle = (timedOut: boolean): string => {
        const cursor = capture.status().cursor;
        if (matches.length === 0) {
          // Abort also settles through `finish`, so say what happened instead of
          // reporting a timeout that never elapsed.
          if (cancelled) return `cancelled while waiting for ${shown} (cursor ${cursor})${note}`;
          if (timedOut) return `timed out after ${timeoutMs / 1000}s waiting for ${shown} (cursor ${cursor})${note}`;
          return `capture ended before ${shown} appeared (cursor ${cursor})${whyEnded(capture)}${note}`;
        }
        const body = matches
          .sort((a, b) => a.index - b.index)
          .slice(0, 200)
          .map((line) => `${String(line.index).padStart(6, " ")} ${params.times ? clock(line.at) : ""}${line.text}`)
          .join("\n");
        return `matched ${matches.length} line(s) · cursor ${cursor}\n${body}${note}`;
      };

      const finish = (timedOut: boolean): void => {
        if (finished) return;
        finished = true;
        deadlineExpired = timedOut;
        if (timer) clearTimeout(timer);
        unsubscribeLine();
        unsubscribeExit();
        // `once` only detaches when abort actually fires; a normal match or a
        // timeout would leave the listener on the caller's signal for good.
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolveWait(settle(timedOut));
      };

      const collect = (line: FoundLine): void => {
        if (finished || line.index <= since || seen.has(line.index)) return;
        if (!matchesFilter(line.text, needle)) return;
        seen.add(line.index);
        matches.push(line);
      };

      const waiting = new Promise<string>((resolve) => {
        resolveWait = resolve;
        // Subscribe first, then scan the backlog: the scan covers
        // [since, cursor] and the listener covers everything after it, so no
        // line can fall through the gap.
        unsubscribeLine = capture.onLine((line) => {
          collect(line);
          // Let the rest of the same chunk land before settling.
          if (backlogRead && matches.length > 0) setTimeout(() => finish(false), 50);
        });
        unsubscribeExit = capture.onExit(() => setTimeout(() => backlogRead && finish(false), 0));
        onAbort = (): void => {
          cancelled = true;
          finish(true);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const backlog = await capture.search({ since, limit: 500, grep: needle, signal });
        for (const line of backlog.lines) collect(line);
        note = evictedNote(backlog, capture.logFile);
        backlogRead = true;
      } catch (error) {
        if (signal?.aborted) onAbort?.();
        else {
          finish(false);
          throw error;
        }
      }
      // The deadline bounds the wait for a line still to come, so it starts
      // here: expiring while the lines already logged are being read back would
      // report a timeout for a line that is sitting on disk.
      if (!finished) timer = setTimeout(() => finish(true), timeoutMs);
      // A pattern already present in the backlog must return immediately,
      // not wait out the timeout.
      if (matches.length > 0 || !capture.running) finish(false);
      let text = await waiting;
      if (!cancelled && !deadlineExpired && matches.length === 0 && !capture.running) {
        await waitForCrashReport(capture, signal);
        if (signal?.aborted) cancelled = true;
        text = settle(cancelled);
      }

      return {
        content: [{ type: "text", text }],
        details: { captureId: capture.id, cursor: capture.status().cursor, matched: matches.length,
          terminationReason: capture.terminationReason, crashReport: capture.crashReport },
        isError: matches.length === 0,
      };
    }

    if (action === "status") {
      if (state.captures.size === 0) {
        return { content: [{ type: "text", text: "no captures in this session" }], details: {} };
      }
      const lines = [...state.captures.values()].map((capture) => {
        const status = capture.status();
        const stateText = status.running ? "running" : `exited${status.exitCode !== undefined ? ` code=${status.exitCode}` : ""}`;
        const role = state.companions.get(status.id)
          ? " · primary"
          : [...state.companions.values()].includes(status.id)
            ? " · companion"
            : "";
        const relaunched = status.relaunches > 0 ? ` · app relaunched ${status.relaunches}×` : "";
        return `- ${status.id} [${status.mode}] ${stateText}${role}${relaunched}${endedNote(capture)} · ${status.lineCount} lines · ${status.bundleId} · ${status.logFile}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: { captures: [...state.captures.values()].map((capture) => capture.status()) } };
    }

    if (action === "stop") {
      const keepApp = params.keepApp !== false;
      // A bare `stop` means "stop what is running", not "guess one capture":
      // a launch records a console capture plus its syslog companion, and an
      // earlier run may still be live for another app. Stopping a single
      // arbitrary one would leave bridges streaming after the user asked for
      // silence, so the no-selector form closes every running capture.
      // `stop` is the last step of a run, often after the app was terminated or
      // exited on its own - in which case the captures already ended and there is
      // nothing left to close. That is the state the caller asked for, so it
      // reports success; only an explicitly named capture that never existed is
      // an error (requireCapture throws for that).
      const targets = params.captureId
        ? [requireCapture(params.captureId)]
        : [...state.captures.values()].filter((c) => !state.endedCaptures.has(c.id));
      if (targets.length === 0) {
        const known = [...state.captures.values()].map((c) => `${c.id} (${c.mode}, ended)`);
        return {
          content: [{
            type: "text",
            text: known.length > 0
              ? `nothing to stop - every capture has already ended: ${known.join(", ")}`
              : "nothing to stop - no capture has been started in this session",
          }],
          details: { captures: [...state.captures.values()].map((capture) => capture.status()) },
        };
      }
      for (const capture of targets) stopCapture(capture, !keepApp);
      for (const capture of targets) await capture.waitForExit(5_000);
      const lines = targets.map((capture) => {
        const status = capture.status();
        return `${status.id} (${status.mode}) ${status.running ? "still shutting down" : "exited"} · ${status.lineCount} lines · ${status.logFile}`;
      });
      return {
        content: [{
          type: "text",
          text: `stopped ${targets.length} capture(s)\n${lines.join("\n")}`,
        }],
        details: { captures: targets.map((capture) => capture.status()) },
      };
    }

    if (action === "terminate") {
      const device = await resolveDeviceParam(params.device, projectRoot);
      const capture = state.activeCaptureId ? state.captures.get(state.activeCaptureId) : undefined;
      const bundleId = params.bundleId ?? capture?.bundleId ?? config.bundleId;
      if (!bundleId) throw new Error("terminate requires bundleId or an active capture.");
      const sameTarget = capture?.deviceId === device.id && capture.bundleId === bundleId &&
        (params.processName === undefined || params.processName === capture.processName);
      const executable = params.processName ?? (sameTarget ? capture.processName : undefined) ??
        (bundleId === config.bundleId ? config.scheme : undefined);
      const pid = (sameTarget ? capture.appPid : undefined) ??
        (executable ? (await lookupProcess(device, executable, { signal })).pid : undefined);
      signal?.throwIfAborted();
      if (!pid) {
        return { content: [{ type: "text", text: `no running process for ${bundleId} on ${device.name}` }], details: {} };
      }
      const outcome = await terminateApp(device, pid, { timeoutMs: 30_000, signal });
      return {
        content: [{ type: "text", text: outcome.message }],
        details: { ...outcome, pid },
        isError: !outcome.ok,
      };
    }

    if (action === "await") {
      const outcome = await runCaseThenStop(params, signal, projectRoot);
      return {
        content: [{ type: "text", text: outcome.text }],
        details: outcome.details,
        isError: outcome.isError,
      };
    }
    throw new Error(`Unknown action: ${String(params.action)}`);
  };

  /**
   * Run the main action, then the command it names.
   *
   * `command=` is a second phase, not an action: the app must be built,
   * installed, launched and capturing before the command runs, or the log would
   * have nothing about this run in it. Shared by the tool and the slash command
   * so the two surfaces cannot drift.
   *
   * Returns `ranCommand` so the caller can decide how the result reaches the
   * session: a finished command run is worth steering on, a bare launch is not.
   */
  const runActionThenCommand = async (
    params: ToolParams,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
    ranCommand: boolean;
  }> => {
    // `restart` names no command of its own: it replays the remembered launch,
    // and that launch may have carried the shell line. Resolving it here is what
    // makes the edit → restart → test loop work; reading only `params.command`
    // would rebuild and relaunch while silently skipping the test.
    const command =
      params.command ?? (params.action === "restart" ? state.lastLaunch?.command : undefined);
    const primary = await runAction(params, ctx, signal, onUpdate);
    if (primary.isError === true || !command || params.action === "await") {
      return { ...primary, ranCommand: false };
    }
    setRunPhase(`command: ${command}`);
    const outcome = await runCaseThenStop({ ...params, command }, signal, resolveProjectRoot(pi, ctx));
    const head = primary.content[0]?.text ?? "";
    return {
      content: [{ type: "text", text: `${head}\n\n${outcome.text}` }],
      details: { primary: primary.details, command: outcome.details },
      isError: outcome.isError,
      ranCommand: true,
    };
  };

  pi.registerTool({
    name: "xcodebug",
    label: "Xcode Device Debug",
    description:
      "Build/install/launch an iOS app on a physical device and stream its Xcode-console output into this session. " +
      "Actions: devices, changes, build, install, launch, syslog, logs, wait, status, stop, terminate, doctor, restart, await. " +
      "build and launch first check the working tree: any source change rebuilds, and a new file inside a pod runs " +
      "pod install first. An unchanged tree reuses this session's build (force=true overrides). " +
      "launch restarts the app and captures stdout/stderr + os_log (no jailbreak, no LLDB). " +
      "syslog attaches to an already-running app without restarting it. " +
      "restart rebuilds, reinstalls and relaunches the last app in this session, for a mid-run code edit; a command= that launch carried runs again afterwards, so restart alone closes the edit→restart→test loop. " +
      "await runs a shell command (command=\"...\") to completion, then stops the capture it was watching and reports the exit code, so an automated run and its app-side log arrive together. Passing command= to launch runs it after the app is already up, which is the one-command linkage run.",
    promptSnippet: "Build/launch an iOS app on a real device and read its console logs",
    promptGuidelines: [
      "Use xcodebug instead of raw xcodebuild/devicectl when debugging on a physical iOS device; it keeps a cursor so xcodebug action=logs returns only new output.",
      "xcodebug action=launch restarts the app; use action=syslog when the app must keep running.",
      "Use xcodebug action=wait to block on an expected log line when verifying a feature end to end. With regex=true, match is a pattern, so one wait covers both outcomes: match=\"sync (done|failed)\".",
      "xcodebug action=changes reports whether a rebuild or pod install is pending without running either.",
      "After editing code mid-run, use xcodebug action=restart instead of a full launch: it replays the last launch's app, device, scheme, goal and command, and forces the rebuild.",
      "For an automated run, pass command=\"cd /repo && npm run test:xxx\" to launch: it builds, installs, launches, runs the command to completion, then stops the capture and returns the exit code plus the app-side cursor. Never poll the log for silence to decide a run is done.",
      "The command's runner must not restart the app itself (disable any auto-launch option in the test config), or the launch that xcodebug is capturing dies and the log stops at the restart.",
      "Verification is a loop: run, read the log, stop, edit the code, run again. Once the log has answered the question, call action=stop and report the conclusion - keeping the capture alive only floods the session.",
      "The one case where you must NOT stop: the user has not touched the app yet, so the log is silent because nothing happened. Wait, tell them what to do on the phone, and keep capturing.",
      "A capture also ends on its own when the app process exits, or when something else relaunched the app; status and logs then say why, and name the crash report if the device wrote one. Do not reconnect a run whose app the user deliberately closed.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("devices"),
        Type.Literal("build"),
        Type.Literal("install"),
        Type.Literal("launch"),
        Type.Literal("syslog"),
        Type.Literal("logs"),
        Type.Literal("wait"),
        Type.Literal("status"),
        Type.Literal("stop"),
        Type.Literal("terminate"),
        Type.Literal("doctor"),
        Type.Literal("changes"),
        Type.Literal("restart"),
        Type.Literal("await"),
      ]),
      device: Type.Optional(Type.String({ description: "Device name, UDID, ECID or CoreDevice uuid. Defaults to .xcodebug.json device, else the only connected physical device." })),
      scheme: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      configuration: Type.Optional(Type.String({ description: "Defaults to Debug" })),
      derivedDataPath: Type.Optional(Type.String()),
      bundleId: Type.Optional(Type.String({ description: "App bundle id; defaults to the built product's CFBundleIdentifier" })),
      appPath: Type.Optional(Type.String({ description: "Install this .app instead of building" })),
      processName: Type.Optional(Type.String({ description: "Executable/process name for syslog filtering" })),
      captureId: Type.Optional(Type.String()),
      since: Type.Optional(Type.Number({ description: "Return lines with index > since; omit for all buffered lines" })),
      limit: Type.Optional(Type.Number({ description: "Max lines to return (default 200)" })),
      grep: Type.Optional(Type.String({ description: "Only return lines containing this text" })),
      match: Type.Optional(Type.String({ description: "wait: substring to wait for; also filters pushed lines" })),
      regex: Type.Optional(Type.Boolean({ description: "logs/wait: treat grep and match as regular expressions instead of substrings, e.g. match=\"sync (done|failed)\"." })),
      times: Type.Optional(Type.Boolean({ description: "logs/wait: prefix each line with the host time it arrived (HH:MM:SS.mmm), to line it up with a test runner's output." })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "wait/build timeout in seconds; await: max run time (default 1800)" })),
      command: Type.Optional(Type.String({ description: "await/launch/restart: shell command line to run to completion after the app is up, e.g. \"cd /repo && npm run test:xxx\". Only /bin/sh -lc runs it, so the cd into the repo that owns the runner is part of the line. Quoted in the slash command (command=\"...\"); restart re-runs the last launch's command unless this overrides it." })),
      push: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("context"), Type.Literal("wake")], {
        description: "How new lines reach the session. Defaults to context. off: pull only (opt out). context: append new lines for the next turn. wake: trigger a turn when new lines arrive.",
      })),
      force: Type.Optional(Type.Boolean({ description: "Rebuild even when the working tree has not changed since the last build in this session." })),
      installPods: Type.Optional(Type.Boolean({ description: "Run pod install when new files belong to a pod (default true)." })),
      dualChannel: Type.Optional(Type.Boolean({ description: "launch: also capture idevicesyslog in parallel so a dropped console bridge leaves no gap (default true)." })),
      changes: Type.Optional(Type.Boolean({ description: "Only report local changes and what they require (no build)." })),
      terminateExisting: Type.Optional(Type.Boolean({ description: "launch: kill an existing instance first (default true)" })),
      keepApp: Type.Optional(Type.Boolean({ description: "stop: leave the app running (default true)" })),
      build: Type.Optional(Type.Boolean({ description: "launch: build and install before launching" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Launch arguments passed to the app" })),
      environment: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra launch environment variables" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Whatever the action returns (including an early error), the transient
      // phase must not outlive it or the footer keeps advertising stale work.
      try {
        const result = await runActionThenCommand(params, ctx, signal, onUpdate);
        return { content: result.content, details: result.details, isError: result.isError };
      } finally {
        clearRunPhase();
      }
    },
  });

  /**
   * `/xcodebug <what you want to verify>` - the one-shot path.
   *
   * Builds the project in the current directory, installs it on the connected
   * device, launches it, and streams the console into this session. A leading
   * action word is honoured when present (/xcodebug logs, /xcodebug stop);
   * anything else is treated as the goal of a launch.
   */
  // `argumentHint` is a host addition (the published RegisteredCommand has only
  // name/description/handler). Spreading a typed object passes it through to hosts
  // that read it and is ignored by those that do not, which keeps this compiling
  // against the published types without dropping the hint where it is supported.
  const commandExtras: { argumentHint?: string } = {
    argumentHint:
      '[what to verify] | [what to verify] command="cd /repo && npm run test:xxx" | <action> [key=value ...]',
  };

  pi.registerCommand("xcodebug", {
    description: "Build, install and launch the current project on a device, then stream its console; command=\"<shell line>\" runs a test command to completion and stops the capture",
    ...commandExtras,
    handler: async (args, ctx) => {
      const parsed = parseCommandArgs(args);
      ctx.ui.notify(`xcodebug: ${parsed.action}${parsed.match ? ` (${parsed.match})` : ""}…`, "info");

      // A command handler has no caller to surface a throw to, so a failed
      // action - `/xcodebug stop` with nothing running, say - must be caught and
      // reported like any other failure instead of escaping as a raw error.
      let text: string;
      let isError = false;
      let ranCommand = false;
      try {
        const result = await runActionThenCommand(
          parsed,
          ctx,
          undefined,
          // Progress frames repaint the status line instead of each becoming a
          // message: a build emits one every two seconds, which used to bury the
          // conversation under identical bars.
          (update) => {
            const frame = update.content[0]?.text;
            if (frame) setRunPhase(frame);
          },
        );
        text = result.content[0]?.text ?? (result.isError ? "xcodebug failed" : "xcodebug done");
        isError = result.isError === true;
        ranCommand = result.ranCommand;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        text = `xcodebug ${parsed.action} failed: ${reason}`;
        isError = true;
      } finally {
        clearRunPhase();
      }
      // The phrase the user typed is what the run is for; without it the model
      // sees build output and logs but not the thing being verified. Only
      // `restart` needs a fallback: it is the one action that types no phrase,
      // because it reuses the run it is restarting. A `stop` or `status` must
      // not inherit that goal, or its output would claim a purpose it lacked.
      const goal =
        parsed.goal ?? (parsed.action === "restart" ? state.lastLaunch?.goal : undefined);
      const withGoal = goal ? `goal: ${goal}\n${text}` : text;
      ctx.ui.notify(text, isError ? "error" : "info");
      // The command surface is how a verification run starts, so its outcome -
      // including a failed build or install - has to reach the session itself.
      // A toast is invisible to the model and would leave it blind to failures.
      try {
        pi.sendMessage(
          {
            customType: CAPTURE_PREFIX,
            content: withGoal,
            display: true,
            details: { action: parsed.action, goal, isError, command: parsed.command },
          },
          // A finished command run always steers: its whole point is that the
          // run is over and the log is ready to analyse, so waiting for the next
          // user turn would strand the result. A bare launch stays `nextTurn` -
          // the user still has to drive the phone and there is nothing to analyse.
          isError || ranCommand
            ? { deliverAs: "steer", triggerTurn: true }
            : { deliverAs: "nextTurn" },
        );
      } catch {
        // Session teardown; the toast already reported it.
      }
    },
  });

  // The todo widget survives turns because it repaints on agent_end; do the same
  // so a verification run stays visible while the user drives the phone.
  pi.on("agent_end", async (_event, ctx) => {
    state.uiCtx ??= ctx;
    refreshStatus();
  });

  pi.on("session_start", async (_event, ctx) => {
    state.uiCtx = ctx;
    refreshStatus();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    crashSearchAbort.abort();
    stopStatusTicker();
    state.uiCtx?.ui.setStatus("xcodebug", undefined);
    state.uiCtx?.ui.setWidget("xcodebug", undefined);
    const captures = [...new Set([...ownedCaptures, ...state.captures.values()])];
    for (const capture of captures) {
      stopPush(capture.id);
      stopWatchdog(capture.id);
      capture.stop(false);
    }
    state.captures.clear();
    state.endedCaptures.clear();
    state.activeCaptureId = undefined;
    // Include pending starts and old result reads, not only the visible capture history.
    const settled = await Promise.all(captures.map((capture) => capture.shutdown(3_000)));
    ownedCaptures.clear();
    const warnings = retiredCleanupWarnings.splice(0);
    for (const [index, capture] of captures.entries()) {
      for (const error of capture.launchResultCleanupErrors ?? []) warnings.push(`${capture.id}: ${error}`);
      if (!settled[index]) warnings.push(`${capture.id}: ${capture.status().error}`);
    }
    if (warnings.length > 0) {
      const message = `xcodebug shutdown cleanup incomplete: ${warnings.join("; ")}`;
      state.uiCtx?.ui.notify(message, "warning");
      console.error(message);
    }
  });
}
