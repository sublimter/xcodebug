import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BuildTarget } from "./xcode.ts";
import { runCommand } from "./exec.ts";

export interface ProjectOptions {
  workspace?: string;
  project?: string;
  scheme?: string;
  configuration?: string;
  derivedDataPath?: string;
  xcodebuildArgs?: string[];
  extraArgs?: string[];
}

export type ResolvedTarget = BuildTarget & { source?: string };

export interface ProjectConfig extends ProjectOptions {
  bundleId?: string;
  device?: string;
  args?: string[];
  environment?: Record<string, string>;
}

const STRING_FIELDS = ["workspace", "project", "scheme", "configuration", "bundleId", "device", "derivedDataPath"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOptions(value: unknown, label: string): asserts value is ProjectConfig {
  if (!record(value)) throw new Error(`${label} must contain a JSON object.`);
  for (const key of STRING_FIELDS) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !(value[key] as string).trim())) {
      throw new Error(`${label}: ${key} must be a nonempty string.`);
    }
  }
  for (const key of ["args", "xcodebuildArgs", "extraArgs"]) {
    const item = value[key];
    if (item !== undefined && (!Array.isArray(item) || !item.every((arg) => typeof arg === "string"))) {
      throw new Error(`${label}: ${key} must be an array of strings.`);
    }
  }
  if (value.environment !== undefined && (!record(value.environment) ||
      !Object.values(value.environment).every((item) => typeof item === "string"))) {
    throw new Error(`${label}: environment must be an object of strings.`);
  }
}

export async function readConfigDetails(cwd: string): Promise<{ config: ProjectConfig; path?: string }> {
  for (const dir of await searchDirectories(cwd)) {
    const path = join(dir, ".xcodebug.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (missing(error)) continue;
      throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
    }
    validateOptions(value, path);
    return {
      path,
      config: {
        ...value,
        ...(value.workspace ? { workspace: resolve(dir, value.workspace) } : {}),
        ...(value.project ? { project: resolve(dir, value.project) } : {}),
        ...(value.derivedDataPath ? { derivedDataPath: resolve(dir, value.derivedDataPath) } : {}),
      },
    };
  }
  return { config: {} };
}

export async function readConfig(cwd: string): Promise<ProjectConfig> {
  return (await readConfigDetails(cwd)).config;
}

export interface DetectedContainer {
  workspace?: string;
  project?: string;
  cocoaPods: boolean;
  ambiguous?: string[];
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw new Error(`Cannot read ${dir}: ${(error as Error).message}`);
  }
}

async function searchDirectories(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    try {
      await lstat(join(dir, ".git"));
      return dirs;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (dirname(dir) === dir) return dirs;
  }
}

async function localContainer(dir: string): Promise<DetectedContainer | undefined> {
  if (/\.(?:xcodeproj|xcworkspace)(?:\/|$)/.test(dir)) return undefined;
  const files = await entries(dir);
  const cocoaPods = files.some((entry) => ["Podfile", "Podfile.lock"].includes(entry.name));
  const workspaces = files.filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"));
  const projects = files.filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
  const candidates = workspaces.length > 0 ? workspaces : projects;
  if (candidates.length > 1) return { cocoaPods, ambiguous: candidates.map((entry) => join(dir, entry.name)).sort() };
  if (candidates.length === 0) return undefined;
  const path = join(dir, candidates[0].name);
  return workspaces.length > 0 ? { workspace: path, cocoaPods } : { project: path, cocoaPods };
}

const SCAN_DEPTH = 4;
const SCAN_DIRECTORIES = 500;
const SKIP = new Set(["pods", "carthage", "node_modules", "build", "deriveddata", "vendor", "dist"]);

async function containersBelow(root: string): Promise<DetectedContainer[]> {
  let visited = 0;
  const scan = async (dir: string, depth: number): Promise<DetectedContainer[]> => {
    if (++visited > SCAN_DIRECTORIES) {
      throw new Error(`Project scan exceeded ${SCAN_DIRECTORIES} directories in ${root}; pass workspace=... or project=... .`);
    }
    const found = await localContainer(dir);
    if (found) return [found];
    if (depth >= SCAN_DEPTH) return [];
    const children = (await entries(dir)).filter((entry) => entry.isDirectory() &&
      !entry.name.startsWith(".") && !SKIP.has(entry.name.toLowerCase()) &&
      !/\.(?:xcodeproj|xcworkspace)$/.test(entry.name));
    const results: DetectedContainer[][] = [];
    for (const entry of children) {
      const child = join(dir, entry.name);
      if ((await entries(child)).some((file) => file.name === ".git")) continue;
      results.push(await scan(child, depth + 1));
    }
    return results.flat();
  };
  return scan(root, 0);
}

export async function resolveProjectDirectory(cwd: string): Promise<string> {
  return (await searchDirectories(cwd)).at(-1)!;
}

export async function detectContainer(cwd: string): Promise<DetectedContainer> {
  const dirs = await searchDirectories(cwd);
  for (const dir of dirs) {
    const found = await localContainer(dir);
    if (found) return found;
  }
  const found = await containersBelow(dirs.at(-1)!);
  if (found.length === 1) return found[0];
  const ambiguous = found.flatMap((item) => item.ambiguous ?? [item.workspace ?? item.project!]).sort();
  return ambiguous.length > 0 ? { cocoaPods: false, ambiguous } : { cocoaPods: false };
}

function selectedContainer(value: ProjectOptions, cwd: string, source: string): ResolvedSelection | undefined {
  if (value.workspace && value.project) throw new Error(`${source}: workspace and project are mutually exclusive; provide only one.`);
  if (value.workspace) return { workspace: resolve(cwd, value.workspace), source: `${source} workspace` };
  if (value.project) return { project: resolve(cwd, value.project), source: `${source} project` };
  return undefined;
}

type ResolvedSelection = Pick<BuildTarget, "workspace" | "project"> & { source: string };

async function selection(cwd: string, config: ProjectConfig, params: ProjectOptions): Promise<ResolvedSelection> {
  const chosen = selectedContainer(params, cwd, "explicit") ?? selectedContainer(config, cwd, "config");
  if (chosen) return chosen;
  const found = await detectContainer(cwd);
  if (found.ambiguous?.length) {
    throw new Error(`Several Xcode containers found: ${found.ambiguous.join(", ")}. Pass workspace=... or project=... .`);
  }
  if (!found.workspace && !found.project) {
    for (const dir of await searchDirectories(cwd)) {
      if ((await entries(dir)).some((entry) => entry.name === "Package.swift")) {
        throw new Error(`${join(dir, "Package.swift")} requires a host iOS app. Pass its workspace or project.`);
      }
    }
    throw new Error(`No Xcode workspace or project found in ${cwd}.`);
  }
  return { workspace: found.workspace, project: found.project, source: "discovered container" };
}


const MAX_SCHEME_PROBES = 12;
const XCODE_QUERY_TIMEOUT = 30_000;

async function xcodeJSON(chosen: ResolvedSelection, args: string[], cwd: string): Promise<unknown> {
  const flags = chosen.workspace ? ["-workspace", chosen.workspace] : ["-project", chosen.project!];
  const result = await runCommand("xcodebuild", [...flags, ...args, "-json"], { cwd, timeoutMs: XCODE_QUERY_TIMEOUT });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    throw new Error(`xcodebuild ${args.join(" ")} ${result.timedOut ? "timed out" : `exited ${result.code}`} ` +
      `${result.truncated ? "(output truncated) " : ""}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`xcodebuild ${args.join(" ")} returned unparseable JSON.`);
  }
}

async function listedSchemes(chosen: ResolvedSelection, cwd: string, extraArgs: string[]): Promise<string[]> {
  const value = await xcodeJSON(chosen, ["-list", ...extraArgs], cwd);
  const container = record(value) ? value.workspace ?? value.project : undefined;
  const schemes = record(container) ? container.schemes : undefined;
  if (!Array.isArray(schemes) || !schemes.every((name) => typeof name === "string" && name.length > 0)) {
    throw new Error("xcodebuild -list returned no valid scheme list.");
  }
  return [...new Set(schemes)].sort();
}

function mainApp(settings: Record<string, unknown>): boolean {
  if (settings.PLATFORM_NAME && settings.PLATFORM_NAME !== "iphoneos") return false;
  if (settings.SUPPORTED_PLATFORMS && !String(settings.SUPPORTED_PLATFORMS).split(/\s+/).includes("iphoneos")) return false;
  if (/simulator|watch|appletv|macosx|maccatalyst|xros|driverkit/i.test(
    [settings.SDKROOT, settings.SDK_NAME, settings.EFFECTIVE_PLATFORM_NAME, settings.SDK_VARIANT].join(" "))
  ) return false;
  if ([settings.INFOPLIST_KEY_WKWatchKitApp, settings.INFOPLIST_KEY_WKApplication].some((value) => /^(YES|true|1)$/i.test(String(value)))) return false;
  if (settings.PRODUCT_TYPE && settings.PRODUCT_TYPE !== "com.apple.product-type.application") return false;
  if (settings.WRAPPER_EXTENSION && settings.WRAPPER_EXTENSION !== "app") return false;
  const wrapper = settings.WRAPPER_NAME ?? settings.FULL_PRODUCT_NAME;
  if (typeof wrapper === "string") return wrapper.endsWith(".app");
  return settings.PRODUCT_TYPE === "com.apple.product-type.application" || settings.WRAPPER_EXTENSION === "app";
}

/** A scheme named for a framework or test target may list an app it depends on. */
export function appBuildSettings(value: unknown, scheme: string, discovery = false): Record<string, unknown> | undefined {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || !rows.every((row) => record(row) && record(row.buildSettings))) {
    throw new Error(`No valid build settings for scheme ${scheme}.`);
  }
  const own = rows.filter((row) => row.target === scheme || row.buildSettings.TARGET_NAME === scheme);
  const ownApps = own.filter((row) => mainApp(row.buildSettings));
  const apps = discovery && own.length ? ownApps : ownApps.length ? ownApps : rows.filter((row) => mainApp(row.buildSettings));
  if (apps.length > 1) {
    const names = apps.map((row) => row.target ?? row.buildSettings.TARGET_NAME ?? row.buildSettings.WRAPPER_NAME);
    throw new Error(`Several installable iOS app targets in scheme ${scheme}: ${names.join(", ")}. Select a scheme for one app.`);
  }
  return apps[0]?.buildSettings;
}

async function resolveScheme(chosen: ResolvedSelection, cwd: string, configuration: string, extraArgs: string[], derivedDataPath?: string): Promise<string> {
  const container = chosen.workspace ?? chosen.project!;
  const listed = await listedSchemes(chosen, cwd, extraArgs);
  if (listed.length > MAX_SCHEME_PROBES) {
    throw new Error(`Cannot automatically inspect ${listed.length} schemes (limit ${MAX_SCHEME_PROBES}): ${listed.join(", ")}. Pass scheme=... .`);
  }
  const candidates: string[] = [];
  const flags = [...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []), ...extraArgs];
  for (const scheme of listed) {
    let settings: unknown;
    try {
      settings = await xcodeJSON(chosen, ["-scheme", scheme, "-configuration", configuration, ...flags,
        "-destination", "generic/platform=iOS", "-showBuildSettings"], cwd);
    } catch {
      continue;
    }
    if (appBuildSettings(settings, scheme, true)) candidates.push(scheme);
  }
  if (candidates.length === 1) return candidates[0];
  throw new Error(`${candidates.length ? "Several main app schemes" : "No main app scheme"} found in ${container}` +
    `${candidates.length ? `: ${candidates.join(", ")}` : ""}; pass scheme=... .`);
}

export async function withContainer(cwd: string, config: ProjectConfig, params: ProjectOptions): Promise<ResolvedTarget> {
  validateOptions(params, "Parameters");
  validateOptions(config, ".xcodebug.json");
  const chosen = await selection(cwd, config, params);
  const configuration = params.configuration ?? config.configuration ?? "Debug";
  const dataPath = params.derivedDataPath ?? config.derivedDataPath;
  const derivedDataPath = dataPath ? resolve(cwd, dataPath) : undefined;
  const extraArgs = params.xcodebuildArgs ?? params.extraArgs ?? config.xcodebuildArgs ?? config.extraArgs;
  const scheme = params.scheme ?? config.scheme ?? await resolveScheme(chosen, cwd, configuration, extraArgs ?? [], derivedDataPath);
  return {
    ...chosen, scheme, configuration,
    derivedDataPath,
    extraArgs,
  };
}
