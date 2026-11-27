import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { runtimeVersion } from "./version.ts";

const actions = ["devices", "changes", "build", "install", "launch", "syslog", "logs", "wait", "history", "status", "stop", "terminate", "doctor", "restart", "await"] as const;
const text = (description?: string) => Type.Optional(Type.String({ description }));
const flag = (description: string) => Type.Optional(Type.Boolean({ description }));
const strings = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

const parameterType = Type.Object({
  action: Type.Enum(actions),
  goal: text("What the caller wants to verify during this launch"),
  device: text("Device name, UDID, ECID or CoreDevice UUID. Defaults to the configured device or the only connected physical device."),
  scheme: text(), workspace: text(), project: text(), configuration: text("Defaults to Debug"), derivedDataPath: text(),
  xcodebuildArgs: strings("Additional xcodebuild arguments, one argv element per item"),
  extraArgs: strings("Alias for xcodebuildArgs"),
  bundleId: text("Defaults to the built product's CFBundleIdentifier"),
  appPath: text("Install this .app instead of building"),
  processName: text("Executable/process name for syslog filtering"),
  captureId: text("Capture to query/control, or exact run for history. stop with an ID is scoped; without one it cancels executing/queued work and all captures."),
  since: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Exclusive capture line index. logs defaults to 0. wait resumes from the last logs/wait reply for this capture. Use 0 to replay." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum log lines (default 200) or history records" })),
  grep: text("logs: return lines containing this text"),
  match: text("wait: pattern to observe. Also filters native pushes or standalone syslog."),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Only action=logs with a non-empty grep: include neighboring lines around each match. Omit for other actions, including launch; 0 is not an unset value." })),
  absent: flag("wait: succeed only after the complete interval if no matching line was observed"),
  regex: flag("logs/wait: interpret grep or match as a regular expression"),
  times: flag("logs/wait: prefix each line with the local host time it arrived (HH:MM:SS.mmm)"),
  timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Per-stage timeout in seconds for scheme discovery, build/pod install, install action or wait. Discovery defaults to 120s; build/pod install 900s; install 180s; wait 30s; await 1800s. Not an overall launch deadline." })),
  command: text("Shell line to run to completion for await or after an action, e.g. cd /repo && npm test. A restart replays the last launch's command unless overridden."),
  push: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("context"), Type.Literal("wake")], {
    description: "Native: context queues lines for the next turn (default), wake starts a turn, off uses pull reads. MCP uses off.",
  })),
  force: flag("Build even when unchanged"), installPods: flag("Install Pods when needed (default true)"),
  dualChannel: flag("launch: also capture idevicesyslog as a companion (default true)"),
  changes: flag("Report local changes without building"), terminateExisting: flag("launch: replace a running instance (default true)"),
  keepApp: flag("stop: leave the app running (default true)"), build: flag("launch: build and install before launching"),
  args: strings("Arguments passed to the app at launch"),
  environment: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra app launch environment variables" })),
}, { additionalProperties: false });

// OMP's TypeBox facade uses IR internally; `json` is IR, not JSON Schema.
export const parameters = (parameterType as typeof parameterType & {
  toJsonSchema?: (options: { target: "draft-07" }) => typeof parameterType;
}).toJsonSchema?.({ target: "draft-07" }) ?? parameterType;

export type ToolParams = Static<typeof parameters>;

export function invalid(reason: string): never {
  throw new Error(`xcodebug ${runtimeVersion.identity.version}: invalid arguments (no action started): ${reason}`);
}

export function validateParameters(input: unknown): ToolParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("arguments must be an object");
  if (!Value.Check(parameters, input)) {
    const unknown = Object.keys(input).find(key => !Object.hasOwn(parameters.properties, key));
    if (unknown !== undefined) invalid(`unknown parameter "${unknown.slice(0, 120)}". Check the running tool schema.`);
    const [error] = Value.Errors(parameters, input);
    invalid(`${error?.instancePath || "arguments"} ${error?.message ?? "failed validation"}`);
  }
  if (input.absent && input.action !== "wait") invalid("absent requires action=wait");
  if (input.context !== undefined && (input.action !== "logs" || !input.grep)) invalid("context requires action=logs with grep; omit context for other actions, even when it is 0");
  if (input.command !== undefined && input.action === "history") invalid("history is read-only and does not accept command");
  return input;
}

// Keep quotes until the key is known: shell commands and JSON use them differently.
function tokens(raw: string): string[] {
  const parts: string[] = [];
  let word = "", quote = "", escaped = false;
  for (const ch of raw) {
    if (!quote && /\s/.test(ch)) {
      if (word) parts.push(word);
      word = "";
      continue;
    }
    word += ch;
    if (escaped) escaped = false;
    else if (quote === '"' && ch === "\\") escaped = true;
    else if (ch === quote) quote = "";
    else if (!quote && (ch === "'" || ch === '"')) quote = ch;
  }
  if (quote) invalid("unterminated quote in slash command");
  if (word) parts.push(word);
  return parts;
}

function unquote(value: string): string {
  if (value.length < 2 || value.at(-1) !== value[0]) return value;
  if (value[0] === "'") return value.slice(1, -1);
  if (value[0] === '"') return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return value;
}

function argument(key: string, raw: string): unknown {
  if (!Object.hasOwn(parameters.properties, key)) invalid(`unknown parameter "${key.slice(0, 120)}"`);
  const value = unquote(raw);
  if (key === "command" && value === raw) invalid('command must be quoted, e.g. command="cd /repo && npm test"');
  const spec = parameters.properties[key as keyof ToolParams];
  if ("type" in spec) {
    if (spec.type === "number" || spec.type === "integer") return value.trim() ? Number(value) : NaN;
    if (spec.type === "boolean") return value === "true" ? true : value === "false" ? false : value;
    if (spec.type === "array" || spec.type === "object") {
      try { return JSON.parse(value); } catch { invalid(`${key} needs valid JSON`); }
    }
  }
  return value;
}

export function parseCommandArgs(raw: string): ToolParams {
  const args: Record<string, unknown> = Object.create(null);
  const words: string[] = [];
  const parts = tokens(raw);
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    const isFlag = token.startsWith("--");
    const body = isFlag ? token.slice(2) : token;
    const eq = body.indexOf("=");
    if (eq > 0) {
      args[body.slice(0, eq)] = argument(body.slice(0, eq), body.slice(eq + 1));
    } else if (isFlag) {
      if (!Object.hasOwn(parameters.properties, body)) invalid(`unknown parameter "${body.slice(0, 120)}"`);
      const spec = parameters.properties[body as keyof ToolParams];
      const next = parts[i + 1];
      if ("type" in spec && spec.type === "boolean" && next !== "false" && next !== "true") args[body] = true;
      else if (next === undefined || next.startsWith("--")) invalid(`--${body} needs a value`);
      else args[body] = argument(body, parts[++i]!);
    } else words.push(unquote(token));
  }
  if (words[0] && (actions as readonly string[]).includes(words[0])) args.action = words.shift();
  args.action ??= "launch";
  if (words.length) args.goal = words.join(" ");
  return validateParameters(args);
}
