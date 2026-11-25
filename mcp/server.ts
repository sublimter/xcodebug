/**
 * MCP entry point: serve the xcodebug tool to MCP clients such as Codex CLI.
 *
 * Codex has no in-process extension API - tools reach it as MCP servers - so this
 * file is the adapter, not a second implementation: it loads index.ts with a stub
 * host, captures the tool the extension registers, and forwards calls to that
 * tool's execute. index.ts stays untouched, which is what keeps the pi path
 * behaving exactly as verified across pi, omp and omo.
 *
 * Run it with bun. Node can load this file from a checkout, but not from
 * node_modules: it refuses to strip types there
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and that is where npm installs
 * the package.
 *
 *   codex mcp add xcodebug -- bun /path/to/xcodebug/mcp/server.ts
 *
 * The protocol is hand-written JSON-RPC over stdio because the adapter only needs
 * the MCP handshake, tool calls, and the status-line resource methods; the official
 * SDK would add ~97 transitive packages to every install, including pi users.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { validateParameters } from "../parameters.ts";
import { asRecord, asString, settlesWithin } from "../exec.ts";
import { runtimeVersion } from "../version.ts";

/** Only the fields index.ts reads off its context. */
interface ExtensionContextLike {
  cwd: string;
  agentDir: string;
  /** The status ticker in index.ts only runs when this is set. */
  hasUI?: boolean;
  ui: { notify(): void; setStatus(key: string, text?: string): void; setWidget(key: string, rows?: string[]): void };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: unknown;
}

/** The slice of a pi-registered tool this server forwards to. */
interface RegisteredTool {
  description: string;
  /** Typebox schema; JSON-serialized before it reaches the client. */
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContextLike,
  ): Promise<ToolResult>;
}

/** Only the members index.ts calls on the host API. */
interface StubPi {
  cwd: string;
  on(event: string, handler: () => Promise<void>): void;
  registerCommand(): void;
  sendMessage(): void;
  registerTool(tool: RegisteredTool): void;
}

const AGENT_DIR = process.env.XCODEBUG_AGENT_DIR ?? join(homedir(), ".xcodebug");
const PROTOCOL_VERSION = "2024-11-05";

let registered: RegisteredTool | undefined;
/** The extension's own teardown: it stops every capture the session started. */
let endSession: (() => Promise<void>) | undefined;
const stubPi: StubPi = {
  cwd: process.cwd(),
  on(event, handler) {
    if (event === "session_shutdown") endSession = handler;
  },
  registerCommand() {},
  // Nothing consumes pushed lines here: MCP has no channel that injects messages
  // into the conversation, so push is refused below instead of silently dropped.
  sendMessage() {},
  registerTool(tool) {
    registered = tool;
  },
};

// Dynamic import because the extension is a plugin: it is loaded at run time,
// once the stub host exists, rather than imported for its side effects at start
// up. The cast is the adapter boundary: the extension declares the full
// ExtensionAPI, this server supplies only the members it reads.
const extensionModule = (await import("../index.ts")) as unknown as {
  default(pi: StubPi): void;
};
extensionModule.default(stubPi);
if (!registered) {
  console.error("xcodebug-mcp: the extension did not register a tool");
  process.exit(1);
}
const tool = registered;

// The native Claude mod reads this without joining the mutating action queue.
// Keep the last repaint alive after tools/call ends; only progress is request-scoped.
const uiSnapshot: { status?: string; rows: string[] } = { rows: [] };

// Every xcodebug_ui call runs the client's tool hooks, so a mod that polled it
// once a second ran them once a second for as long as a capture lived. The same
// snapshot goes to a file the mod reads between calls. One file per process:
// several sessions each run their own server.
const UI_DIR = join(AGENT_DIR, "ui");
let uiFile: string | undefined = join(UI_DIR, `${process.pid}.json`);
// Advances on every repaint, which happens once a second while anything is
// shown; a reader that sees it stand still knows this process stopped painting.
let uiSeq = 0;

function publishUi(): void {
  if (!uiFile) return;
  uiSeq += 1;
  try {
    mkdirSync(UI_DIR, { recursive: true });
    // Renamed into place so a reader never sees half a snapshot.
    writeFileSync(`${uiFile}.tmp`, JSON.stringify({ ...uiSnapshot, seq: uiSeq }));
    renameSync(`${uiFile}.tmp`, uiFile);
  } catch (error) {
    // A repaint must not take the action down with it. Without the file the
    // mod is told nothing about it and keeps calling xcodebug_ui.
    console.error("xcodebug-mcp: live display file unavailable:", (error as Error).message);
    uiFile = undefined;
  }
}
publishUi();
process.on("exit", () => {
  if (uiFile) rmSync(uiFile, { force: true });
});
// Claude Code ends a stdio server with SIGINT. Left to the default, a signal
// ends the process without the handler above; the exit codes are the shell's.
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
// A server that was killed outright never ran it either. Its file is named after
// a process that no longer exists, which is how the next server to start finds it.
try {
  for (const name of readdirSync(UI_DIR)) {
    try {
      process.kill(Number.parseInt(name, 10), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(UI_DIR, name), { force: true });
    }
  }
} catch {
  // No directory to sweep: publishUi() could not create it and said so.
}
const statusResource = { uri: "ui://xcodebug/statusline", name: "xcodebug live status", mimeType: "application/json" };
const normalizeStatusText = (value: string | undefined): string | undefined =>
  value?.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

function idleCodexStatusline(meta: unknown): string | undefined {
  const state = asRecord(asRecord(meta)["com.openai/codex-statusline-state"]);
  const items = asRecord(state.config).statusline_items;
  if (!Array.isArray(items)) return;
  const thread = asRecord(state.thread);
  const model = asRecord(thread.model);
  const name = asString(model.display_name);
  const reasoning = asString(model.reasoning_level) ?? "default";
  const tier = asString(model.service_tier_display_name);
  const cwd = asString(asRecord(thread.workspace).cwd);
  const used = asRecord(asRecord(thread.usage).context).used_percentage;
  const home = homedir();
  // shortcut: mirror the four configured default items; extend when other items are enabled.
  return items.map(item => {
    switch (item) {
      case "model-with-reasoning":
        return name ? `${name} ${reasoning}${tier ? ` ${tier.toLowerCase()}` : ""}` : undefined;
      case "current-dir":
        return cwd === home ? "~" : cwd?.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
      case "context-remaining":
        return typeof used === "number" && Number.isInteger(used) && used >= 0 && used <= 100
          ? `Context ${100 - used}% left` : undefined;
      case "fast-mode":
        return tier ?? (model.service_tier === "normal" ? "Standard" : undefined);
      default:
        return undefined;
    }
  }).filter(Boolean).join(" · ") || undefined;
}
const uiTool = {
  name: "xcodebug_ui",
  description: "Read the current display snapshot for the xcodebug Claude Code mod. For capture details or log analysis use xcodebug with action=status or action=logs.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: statusResource.uri }] } },
};

function sendNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

// While an action runs, index.ts repaints its status line once a second. That is
// the same cadence MCP progress wants, so the status text becomes the progress
// message instead of being dropped. `hasUI` is what makes that ticker run at all.
function makeCtx(cwd: string, progressToken: unknown): { ctx: ExtensionContextLike; close(): void } {
  let step = 0;
  let active = true;
  const report = (text: string | undefined): void => {
    if (!active) return;
    if (progressToken === undefined || progressToken === null) return;
    if (text === undefined || text === "") return;
    step += 1;
    sendNotification("notifications/progress", { progressToken, progress: step, message: text });
  };
  return {
    ctx: {
      cwd,
      agentDir: AGENT_DIR,
      hasUI: true,
      ui: {
        notify() {},
        setStatus(_key, text) {
          uiSnapshot.status = text;
          publishUi();
          report(text);
        },
        setWidget(_key, rows) {
          uiSnapshot.rows = rows ?? [];
          publishUi();
        },
      },
    },
    // The status ticker keeps running while a capture is alive, which outlives
    // the call that started it. Without closing, the adapter would keep
    // reporting progress for a request that already answered.
    close() {
      active = false;
    },
  };
}

// Typebox attaches symbol metadata; JSON round-tripping leaves a plain schema.
const inputSchema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
const { properties } = inputSchema as { properties: Record<string, unknown> };
properties.cwd = { type: "string", description: "Absolute path to an existing project directory. Required for Codex Marketplace project actions except restart, which uses the last launch directory." };

const CWD_FREE_ACTIONS = { devices: true, logs: true, wait: true, history: true, status: true, stop: true };

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

interface StopBoundary {
  controllers: AbortController[];
  settled: Promise<void>;
}

async function callTool(
  input: unknown,
  signal: AbortSignal,
  progressToken: unknown,
  stopBoundary?: StopBoundary,
): Promise<ToolResult> {
  // Preserve invalid input for validation; spreading null or a number hides its type.
  const { cwd, ...args } = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : { ...validateParameters(input), cwd: undefined };
  if (stopBoundary) validateParameters(args);
  let projectCwd: string | undefined;
  if (cwd !== undefined) {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute project directory path.");
    }
    const statDirectory = (path: string) => stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    const directory = await statDirectory(cwd);
    if (!directory?.isDirectory()) {
      throw new Error(`cwd must be an existing directory: ${cwd}`);
    }
    const normalized = resolve(cwd);
    // Collapsing `..` before following a symlink can select a different directory.
    if (cwd.split("/").includes("..")) {
      const target = await statDirectory(normalized);
      if (target?.dev !== directory.dev || target.ino !== directory.ino) {
        throw new Error(`cwd is ambiguous: ${cwd}. Pass the resolved project directory.`);
      }
    }
    projectCwd = await realpath(normalized);
  }
  if (process.env.XCODEBUG_REQUIRE_PROJECT_CWD === "1" && cwd === undefined && args.action !== "restart" &&
      (args.command !== undefined || !Object.hasOwn(CWD_FREE_ACTIONS, String(args.action)))) {
    throw new Error("Pass cwd with the absolute path to your project directory.");
  }
  // `defaultPushMode` defaults to "context", but this transport cannot deliver
  // pushed lines. Refusing an explicit request beats accepting it and going quiet.
  if (args.push === "context" || args.push === "wake") {
    return {
      content: [{ type: "text", text: 'MCP has no push channel; use push=off and read with action=logs.' }],
      isError: true,
    };
  }
  if (signal.aborted) throw new Error("Request cancelled");
  let cancelled = 0;
  const bareStop = stopBoundary && args.captureId === undefined;
  const appendedCommand = bareStop && args.command ? args.command : undefined;
  const progress = makeCtx(projectCwd ?? process.cwd(), progressToken);
  try {
    // Apply native termination intent before forwarded request aborts can stop consoles.
    const backendArgs: Record<string, unknown> = { ...args, push: args.push === undefined ? "off" : args.push };
    if (appendedCommand) delete backendArgs.command;
    const execution = tool.execute("mcp", backendArgs, signal, undefined, progress.ctx);
    if (bareStop) {
      for (const controller of stopBoundary.controllers) {
        if (pendingActions.has(controller) && !controller.signal.aborted) {
          controller.abort();
          cancelled++;
        }
      }
    }
    let result = await execution;
    if (bareStop) {
      const details = asRecord(result.details);
      const primary = asRecord(details.primary ?? details);
      const cleanupPending = primary.cleanupPending === true || !await settlesWithin(stopBoundary.settled, 3_000);
      if (cleanupPending) {
        const idleStopMessage = asString(primary.idleStopMessage);
        const text = result.content[0]?.text ?? "";
        const suffix = idleStopMessage && text.startsWith(idleStopMessage) ? text.slice(idleStopMessage.length) : text ? `\n${text}` : "";
        result = {
          ...result,
          content: [{ type: "text", text: `Cleanup is still pending for admitted requests.${suffix}` }, ...result.content.slice(1)],
          details: details.primary ? { ...details, primary: { ...primary, cleanupPending: true } } : { ...details, cleanupPending: true },
          isError: true,
        };
      } else if (appendedCommand && !result.isError) {
        signal.throwIfAborted();
        const command = await tool.execute("mcp", { ...args, action: "await", push: args.push === undefined ? "off" : args.push }, signal, undefined, progress.ctx);
        result = {
          content: [{ type: "text", text: `${result.content[0]?.text ?? ""}\n\n${command.content[0]?.text ?? ""}` }],
          details: { primary: result.details, command: command.details },
          isError: command.isError,
        };
      }
    }
    if (cancelled > 0) {
      const details = asRecord(result.details);
      const primary = asRecord(details.primary ?? details);
      const idleStopMessage = asString(primary.idleStopMessage);
      const text = result.content[0]?.text ?? "";
      // Replace only an idle primary header; an appended command's output is opaque.
      const suffix = idleStopMessage && text.startsWith(idleStopMessage)
        ? text.slice(idleStopMessage.length)
        : text ? `\n${text}` : "";
      return { ...result, content: [{ type: "text", text: `Cancelled ${cancelled} admitted request(s).${suffix}` }, ...result.content.slice(1)] };
    }
    return result;
  } finally {
    progress.close();
  }
}

async function handle(message: Record<string, unknown>, controller?: AbortController, stopBoundary?: StopBoundary): Promise<void> {
  const id = message.id;
  const method = message.method;
  // Notifications carry no id and must never be answered.
  if (id === undefined) return;

  if (method === "initialize") {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    reply(id, {
      protocolVersion: requested ?? PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "xcodebug", version: runtimeVersion.identity.version },
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [{ name: "xcodebug", description: tool.description, inputSchema }, uiTool] });
    return;
  }
  if (method === "resources/list") {
    reply(id, { resources: [statusResource] });
    return;
  }
  if (method === "resources/templates/list") {
    reply(id, { resourceTemplates: [] });
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as {
      name?: string;
      arguments?: unknown;
      _meta?: { progressToken?: unknown };
    };
    if (params.name !== "xcodebug") {
      replyError(id, -32602, `Unknown tool "${params.name ?? ""}"`);
      return;
    }
    try {
      if (controller!.signal.aborted) {
        reply(id, { content: [{ type: "text", text: "Request cancelled" }], isError: true });
        return;
      }
      reply(id, await callTool(params.arguments === undefined ? {} : params.arguments, controller!.signal, params._meta?.progressToken, stopBoundary));
    } catch (error) {
      reply(id, { content: [{ type: "text", text: (error as Error).message }], isError: true });
    }
    return;
  }
  replyError(id, -32601, `Unknown method "${String(method)}"`);
}

// Ordinary requests are serialized. Stops bypass execution but join the queue's
// settlement barrier so later calls cannot start until the stop has finished.
let queue: Promise<void> = Promise.resolve();
/** Admitted calls, including queued calls, so cancellation cannot miss one. */
const inflight = new Map<unknown, AbortController>();
const pendingActions = new Set<AbortController>();

/**
 * Stop what the client's calls started, then exit.
 *
 * A capture's bridge and a running build are child processes that nothing else
 * stops. A bridge that is still alive keeps this process alive after stdin has
 * closed, and one that outlives it stays for good if the app is quiet.
 */
let exiting = false;
async function shutdown(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  for (const controller of inflight.values()) controller.abort();
  try {
    // Native cleanup has its own deadline; do not hide it behind held adapter I/O.
    const cleanup = endSession?.();
    await Promise.all([cleanup, settlesWithin(queue, 3_000)]);
    if (!process.stdout.destroyed) {
      await new Promise<void>(resolve => process.stdout.write("", () => resolve()));
    }
  } finally {
    process.exit(code);
  }
}

// EOF on stdin is only a half-close: scripts commonly finish sending requests
// and keep stdout open to collect replies. A full disconnect is observable only
// when stdout closes or a write fails; stdio cannot detect a silent reader gone.
process.stdout.on("error", () => { void shutdown(0); });
process.stdout.on("close", () => { void shutdown(0); });

const input = createInterface({ input: process.stdin });
input.on("close", () => {
  void queue.then(() => shutdown(0));
});
input.on("line", (line) => {
  if (exiting) return;
  const text = line.trim();
  if (text.length === 0) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    replyError(null, -32700, "Parse error");
    return;
  }
  // UI reads must remain responsive during a build/install/wait and must never
  // replace state.uiCtx with the context of a polling call.
  if (message.method === "resources/read") {
    if (message.id === undefined) return;
    const uri = (message.params as { uri?: string } | undefined)?.uri;
    if (uri !== statusResource.uri) {
      replyError(message.id, -32002, "Resource not found");
      return;
    }
    const { status, rows } = uiSnapshot;
    const capturing = rows[0]?.startsWith("Xcodebug · capturing ");
    const label = (capturing ? status?.replace(/ · \/xcodebug stop to end$/, "") : status) ??
      (rows.length === 0 ? idleCodexStatusline((message.params as { _meta?: unknown } | undefined)?._meta) : undefined);
    // Keep every text leaf valid UTF-8; Codex rejects UI trees containing lone surrogates.
    const normalized = normalizeStatusText(label);
    const preview = normalized && normalized.length > 1024
      ? normalizeStatusText(`${normalized.slice(0, 1024)}…`)
      : normalized;
    const latest = capturing ? normalizeStatusText(rows.at(-1)?.trim()) : undefined;
    const tree = preview && latest && latest !== "(waiting for the first line…)"
      ? { type: "row", props: { gap: 2, wrap: "wrap" }, children: [preview, latest] }
      : preview ?? null;
    reply(message.id, { contents: [{ uri, mimeType: statusResource.mimeType, text: JSON.stringify(tree) }] });
    return;
  }
  if (message.method === "tools/call" &&
      (message.params as { name?: string } | undefined)?.name === uiTool.name) {
    if (message.id !== undefined) {
      reply(message.id, {
        content: [{ type: "text", text: JSON.stringify({ ...uiSnapshot, seq: uiSeq, file: uiFile }) }],
      });
    }
    return;
  }
  // Handled here rather than in handle(): the queue serializes calls, so a
  // cancellation queued behind the very call it targets could never arrive in
  // time. It is a notification, so nothing is sent back.
  if (message.method === "notifications/cancelled") {
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    inflight.get(requestId)?.abort();
    return;
  }
  const controller = message.method === "tools/call" && message.id !== undefined
    ? new AbortController() : undefined;
  if (controller) inflight.set(message.id, controller);
  const params = asRecord(message.params);
  const stop = controller && params?.name === "xcodebug" && asRecord(params.arguments)?.action === "stop";
  const stopBoundary = stop ? { controllers: [...pendingActions], settled: queue } : undefined;
  if (controller && params.name === "xcodebug" && (!stop || asRecord(params.arguments).command !== undefined)) {
    pendingActions.add(controller);
  }
  const run = async () => {
    try {
      await handle(message, controller, stopBoundary);
    } finally {
      if (controller) {
        pendingActions.delete(controller);
        if (inflight.get(message.id) === controller) inflight.delete(message.id);
      }
    }
  };
  const reportError = (error: unknown) => { console.error("xcodebug-mcp:", error); };
  if (stop) {
    const stopping = run().catch(reportError);
    queue = Promise.all([queue, stopping]).then(() => undefined);
  } else {
    queue = queue.then(run).catch(reportError);
  }
});
