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
 * The protocol is hand-written JSON-RPC over stdio because only three methods are
 * needed (initialize, tools/list, tools/call); the official SDK would add ~97
 * transitive packages to every install, including the pi users who never run MCP.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Only the fields index.ts reads off its context. */
interface ExtensionContextLike {
  cwd: string;
  agentDir: string;
  /** The status ticker in index.ts only runs when this is set. */
  hasUI?: boolean;
  ui: { notify(): void; setStatus(key: string, text?: string): void; setWidget(): void };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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
  on(): void;
  registerCommand(): void;
  sendMessage(): void;
  registerTool(tool: RegisteredTool): void;
}

const AGENT_DIR = process.env.XCODEBUG_AGENT_DIR ?? join(homedir(), ".xcodebug");
const PROTOCOL_VERSION = "2024-11-05";

// Reported to clients on initialize; read from the package so a version bump does
// not leave the handshake advertising the previous release.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

let registered: RegisteredTool | undefined;
const stubPi: StubPi = {
  cwd: process.cwd(),
  on() {},
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

function sendNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

// While an action runs, index.ts repaints its status line once a second. That is
// the same cadence MCP progress wants, so the status text becomes the progress
// message instead of being dropped. `hasUI` is what makes that ticker run at all.
function makeCtx(progressToken: unknown): { ctx: ExtensionContextLike; close(): void } {
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
      cwd: process.cwd(),
      agentDir: AGENT_DIR,
      hasUI: true,
      ui: {
        notify() {},
        setStatus(_key, text) {
          report(text);
        },
        setWidget() {},
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

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function callTool(
  args: Record<string, unknown>,
  signal: AbortSignal,
  progressToken: unknown,
): Promise<ToolResult> {
  // `defaultPushMode` defaults to "context", but this transport cannot deliver
  // pushed lines. Refusing an explicit request beats accepting it and going quiet.
  if (args.push !== undefined && args.push !== "off") {
    return {
      content: [{ type: "text", text: 'MCP has no push channel; use push=off and read with action=logs.' }],
      isError: true,
    };
  }
  const progress = makeCtx(progressToken);
  try {
    return await tool.execute("mcp", { ...args, push: "off" }, signal, undefined, progress.ctx);
  } finally {
    progress.close();
  }
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  const method = message.method;
  // Notifications carry no id and must never be answered.
  if (id === undefined) return;

  if (method === "initialize") {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    reply(id, {
      protocolVersion: requested ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "xcodebug", version: pkg.version },
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [{ name: "xcodebug", description: tool.description, inputSchema }] });
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
      _meta?: { progressToken?: unknown };
    };
    if (params.name !== "xcodebug") {
      replyError(id, -32602, `Unknown tool "${params.name ?? ""}"`);
      return;
    }
    // Registered before the call starts so a cancellation that arrives while it
    // runs finds the controller; `finally` keeps the map from growing.
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      reply(id, await callTool(params.arguments ?? {}, controller.signal, params._meta?.progressToken));
    } catch (error) {
      reply(id, { content: [{ type: "text", text: (error as Error).message }], isError: true });
    } finally {
      inflight.delete(id);
    }
    return;
  }
  replyError(id, -32601, `Unknown method "${String(method)}"`);
}

// Requests are serialized: a capture's state is a plain map, and two overlapping
// calls (launch + stop) would interleave mutations on it.
let queue: Promise<void> = Promise.resolve();
/** Calls running right now, so a cancellation can reach the one it names. */
const inflight = new Map<unknown, AbortController>();
createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    replyError(null, -32700, "Parse error");
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
  queue = queue.then(() => handle(message)).catch((error: unknown) => {
    console.error("xcodebug-mcp:", error);
  });
});
