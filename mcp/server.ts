/**
 * MCP entry point: serve the xcodebug tool to MCP clients such as Codex CLI.
 *
 * Codex has no in-process extension API - tools reach it as MCP servers - so this
 * file is the adapter, not a second implementation: it loads index.ts with a stub
 * host, captures the tool the extension registers, and forwards calls to that
 * tool's execute. index.ts stays untouched, which is what keeps the pi path
 * behaving exactly as verified across pi, omp and omo.
 *
 * Run it with bun, not node: the extension uses extensionless relative imports
 * (`./capture`) that Bun resolves and Node's ESM loader does not.
 *
 *   codex mcp add xcodebug -- bun /path/to/xcodebug/mcp/server.ts
 *
 * The protocol is hand-written JSON-RPC over stdio because only three methods are
 * needed (initialize, tools/list, tools/call); the official SDK would add ~97
 * transitive packages to every install, including the pi users who never run MCP.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Only the fields index.ts reads off its context. */
interface ExtensionContextLike {
  cwd: string;
  agentDir: string;
  ui: { notify(): void; setStatus(): void; setWidget(): void };
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
    signal: undefined,
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

// Dynamic import is required: the extension is loaded as a plugin at run time, and
// the specifier is extensionless because Bun resolves it while a static import
// would force a build step. The cast is the adapter boundary: the extension
// declares the full ExtensionAPI, this server supplies only the members it reads.
const extensionModule = (await import("../index.ts")) as unknown as {
  default(pi: StubPi): void;
};
extensionModule.default(stubPi);
if (!registered) {
  console.error("xcodebug-mcp: the extension did not register a tool");
  process.exit(1);
}
const tool = registered;

const ctx: ExtensionContextLike = {
  cwd: process.cwd(),
  agentDir: AGENT_DIR,
  ui: { notify() {}, setStatus() {}, setWidget() {} },
};

// Typebox attaches symbol metadata; JSON round-tripping leaves a plain schema.
const inputSchema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function callTool(args: Record<string, unknown>): Promise<ToolResult> {
  // `defaultPushMode` defaults to "context", but this transport cannot deliver
  // pushed lines. Refusing an explicit request beats accepting it and going quiet.
  if (args.push !== undefined && args.push !== "off") {
    return {
      content: [{ type: "text", text: 'MCP has no push channel; use push=off and read with action=logs.' }],
      isError: true,
    };
  }
  return tool.execute("mcp", { ...args, push: "off" }, undefined, undefined, ctx);
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
      serverInfo: { name: "xcodebug", version: "1.0.0" },
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
    const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (params.name !== "xcodebug") {
      replyError(id, -32602, `Unknown tool "${params.name ?? ""}"`);
      return;
    }
    try {
      reply(id, await callTool(params.arguments ?? {}));
    } catch (error) {
      reply(id, { content: [{ type: "text", text: (error as Error).message }], isError: true });
    }
    return;
  }
  replyError(id, -32601, `Unknown method "${String(method)}"`);
}

// Requests are serialized: a capture's state is a plain map, and two overlapping
// calls (launch + stop) would interleave mutations on it.
let queue: Promise<void> = Promise.resolve();
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
  queue = queue.then(() => handle(message)).catch((error: unknown) => {
    console.error("xcodebug-mcp:", error);
  });
});
