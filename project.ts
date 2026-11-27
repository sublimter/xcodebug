import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
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
const XCODE_QUERY_TIMEOUT = 120_000;

async function xcodeJSON(chosen: ResolvedSelection, args: string[], cwd: string, timeoutMs: number): Promise<unknown> {
  const flags = chosen.workspace ? ["-workspace", chosen.workspace] : ["-project", chosen.project!];
  const result = await runCommand("xcodebuild", [...flags, ...args, "-json"], { cwd, timeoutMs });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    throw new Error(`xcodebuild ${args.join(" ")} ${result.timedOut ? `timed out after ${timeoutMs / 1000}s` : `exited ${result.code}`} ` +
      `${result.truncated ? "(output truncated) " : ""}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`xcodebuild ${args.join(" ")} returned unparseable JSON.`);
  }
}

async function listedSchemes(chosen: ResolvedSelection, cwd: string, extraArgs: string[], timeoutMs: number): Promise<string[]> {
  const value = await xcodeJSON(chosen, ["-list", ...extraArgs], cwd, timeoutMs);
  const container = record(value) ? value.workspace ?? value.project : undefined;
  const schemes = record(container) ? container.schemes : undefined;
  if (!Array.isArray(schemes) || !schemes.every((name) => typeof name === "string" && name.length > 0)) {
    throw new Error("xcodebuild -list returned no valid scheme list.");
  }
  return [...new Set(schemes)].sort();
}

async function referencedProjects(workspace: string): Promise<string[]> {
  let xml: string;
  try {
    xml = await readFile(join(workspace, "contents.xcworkspacedata"), "utf8");
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const container = dirname(workspace);
  const groups = [container];
  const projects = new Set<string>();
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?(?:Group|FileRef)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
    const tag = match[0];
    if (tag.startsWith("<!")) continue;
    if (tag.startsWith("</")) {
      if (tag.startsWith("</Group")) {
        if (groups.length === 1) throw new Error(`Unbalanced workspace groups in ${workspace}.`);
        groups.pop();
      }
      continue;
    }
    const group = tag.startsWith("<Group");
    const attribute = /\blocation\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
    if (!attribute && !group) throw new Error(`Missing workspace reference location in ${workspace}.`);
    const location = (attribute?.[1] ?? attribute?.[2] ?? "group:").replace(
      /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) =>
        entity.startsWith("#") ? String.fromCodePoint(parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10)) : entities[entity],
    );
    if (!group && !location.replace(/\/+$/, "").endsWith(".xcodeproj")) continue;
    const colon = location.indexOf(":");
    const kind = colon < 0 ? "group" : location.slice(0, colon);
    const path = colon < 0 ? location : location.slice(colon + 1);
    if (!["group", "container", "absolute"].includes(kind) || (kind === "absolute" && !isAbsolute(path))) {
      throw new Error(`Unsupported workspace reference ${location} in ${workspace}.`);
    }
    const resolved = resolve(kind === "group" ? groups.at(-1)! : container, path);
    if (group) {
      if (!/\/\s*>$/.test(tag)) groups.push(resolved);
    } else {
      projects.add(resolved);
    }
  }
  if (groups.length !== 1) throw new Error(`Unbalanced workspace groups in ${workspace}.`);
  return [...projects];
}

async function schemeVisibility(container: string, username: string): Promise<Map<string, boolean> | undefined> {
  const path = join(container, "xcuserdata", `${username}.xcuserdatad`, "xcschemes", "xcschememanagement.plist");
  try {
    await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const result = await runCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { timeoutMs: 30_000 });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    throw new Error(`Cannot read scheme management ${path}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid scheme management JSON from ${path}.`);
  }
  if (!record(value) || (value.SchemeUserState !== undefined && !record(value.SchemeUserState))) {
    throw new Error(`Invalid SchemeUserState in ${path}.`);
  }
  if (value.SchemeUserState === undefined) return undefined;
  const visibility = new Map<string, boolean>();
  for (const [key, state] of Object.entries(value.SchemeUserState)) {
    if (!record(state) || (state.isShown !== undefined && typeof state.isShown !== "boolean")) {
      throw new Error(`Invalid scheme visibility for ${key} in ${path}.`);
    }
    const name = /^(.+)\.xcscheme(?:_\^#shared#\^_)?$/.exec(key)?.[1];
    if (name) visibility.set(name, visibility.get(name) === true || state.isShown !== false);
  }
  return visibility;
}

async function shownSchemes(chosen: ResolvedSelection, listed: string[]): Promise<{ shown: string[]; projectNames: Set<string> }> {
  const projects = chosen.project ? [chosen.project] : await referencedProjects(chosen.workspace!);
  const projectNames = new Set<string>();
  const username = userInfo().username;
  const visibility = new Map<string, boolean>();
  let managed = false;
  for (const project of projects) {
    const state = await schemeVisibility(project, username);
    if (!state) continue;
    managed = true;
    const name = basename(project, ".xcodeproj");
    if (state.has(name)) projectNames.add(name);
    for (const [name, shown] of state) visibility.set(name, visibility.get(name) === true || shown);
  }
  if (chosen.workspace) {
    const state = await schemeVisibility(chosen.workspace, username);
    if (state) {
      managed = true;
      for (const [name, shown] of state) visibility.set(name, shown);
    }
  }
  // Only absent management metadata permits Xcode's default-visible scheme list.
  if (!managed) for (const project of projects) projectNames.add(basename(project, ".xcodeproj"));
  return { shown: managed ? listed.filter((name) => visibility.get(name) === true) : listed, projectNames };
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

async function resolveScheme(chosen: ResolvedSelection, cwd: string, configuration: string, extraArgs: string[], timeoutMs: number, derivedDataPath?: string): Promise<string> {
  const container = chosen.workspace ?? chosen.project!;
  const { shown, projectNames } = await shownSchemes(chosen, await listedSchemes(chosen, cwd, extraArgs, timeoutMs));
  const candidates: { scheme: string; app: Record<string, unknown> }[] = [];
  const flags = [...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []), ...extraArgs];
  let probes = 0;
  for (const schemes of [shown.filter((name) => projectNames.has(name)), shown.filter((name) => !projectNames.has(name))]) {
    if (probes + schemes.length > MAX_SCHEME_PROBES) {
      throw new Error(`Cannot automatically inspect ${shown.length} shown schemes (limit ${MAX_SCHEME_PROBES}): ${shown.join(", ")}. Pass scheme=... .`);
    }
    for (const scheme of schemes) {
      probes++;
      let settings: unknown;
      try {
        settings = await xcodeJSON(chosen, ["-scheme", scheme, "-configuration", configuration, ...flags,
          "-destination", "generic/platform=iOS", "-showBuildSettings"], cwd, timeoutMs);
      } catch {
        continue;
      }
      const app = appBuildSettings(settings, scheme, true);
      if (app) candidates.push({ scheme, app });
    }
    if (candidates.length === 1) return candidates[0].scheme;
    if (candidates.length > 1) {
      const named = candidates.find(({ scheme, app }) => scheme === app.TARGET_NAME);
      if (named && typeof named.app.PROJECT_FILE_PATH === "string" && candidates.every(({ app }) =>
        app.PROJECT_FILE_PATH === named.app.PROJECT_FILE_PATH && app.TARGET_NAME === named.scheme &&
        app.PRODUCT_BUNDLE_IDENTIFIER === named.app.PRODUCT_BUNDLE_IDENTIFIER && app.FULL_PRODUCT_NAME === named.app.FULL_PRODUCT_NAME)) {
        return named.scheme;
      }
      break;
    }
  }
  throw new Error(`${candidates.length ? "Several main app schemes" : "No main app scheme"} found in ${container}` +
    `${candidates.length ? `: ${candidates.map(({ scheme }) => scheme).join(", ")}` : ""}; pass scheme=... .`);
}

export async function withContainer(cwd: string, config: ProjectConfig, params: ProjectOptions & { timeoutSeconds?: number }): Promise<ResolvedTarget> {
  validateOptions(params, "Parameters");
  validateOptions(config, ".xcodebug.json");
  if (params.timeoutSeconds !== undefined &&
      (typeof params.timeoutSeconds !== "number" || !Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds <= 0)) {
    throw new Error("Parameters timeoutSeconds must be a positive finite number.");
  }
  const timeoutMs = params.timeoutSeconds === undefined ? XCODE_QUERY_TIMEOUT : params.timeoutSeconds * 1000;
  const chosen = await selection(cwd, config, params);
  const configuration = params.configuration ?? config.configuration ?? "Debug";
  const dataPath = params.derivedDataPath ?? config.derivedDataPath;
  const derivedDataPath = dataPath ? resolve(cwd, dataPath) : undefined;
  const extraArgs = params.xcodebuildArgs ?? params.extraArgs ?? config.xcodebuildArgs ?? config.extraArgs;
  const scheme = params.scheme ?? config.scheme ?? await resolveScheme(chosen, cwd, configuration, extraArgs ?? [], timeoutMs, derivedDataPath);
  return {
    ...chosen, scheme, configuration,
    derivedDataPath,
    extraArgs,
  };
}
