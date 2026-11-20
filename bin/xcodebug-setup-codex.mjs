#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TOOL_TIMEOUT_SECONDS = 4_200;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(packageRoot, "mcp", "server.ts");
const codex = process.env.CODEX_BIN ?? "codex";
const runtime = process.env.XCODEBUG_MCP_RUNTIME ?? "bun";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return result;
}

function getRegistration() {
  return run(codex, ["mcp", "get", "xcodebug"]);
}

function ensureServerRegistration() {
  const existing = getRegistration();
  if (existing.status === 0) return existing;

  const runtimeCheck = run(runtime, ["--version"]);
  if (runtimeCheck.status !== 0) {
    throw new Error(`xcodebug is not registered and ${runtime} is unavailable; install Bun or set XCODEBUG_MCP_RUNTIME`);
  }
  const added = run(codex, ["mcp", "add", "xcodebug", "--", runtime, serverPath]);
  if (added.status !== 0) {
    throw new Error((added.stderr || added.stdout || "codex mcp add failed").trim());
  }
  const registered = getRegistration();
  if (registered.status !== 0) {
    throw new Error((registered.stderr || registered.stdout || "could not read the new xcodebug registration").trim());
  }
  return registered;
}

function projectOverrides() {
  const configs = [];
  for (let dir = process.cwd();; dir = dirname(dir)) {
    const path = join(dir, ".codex", "config.toml");
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (/^\s*\[mcp_servers\.xcodebug\]\s*$/m.test(text) || (/^\s*\[mcp_servers\]\s*$/m.test(text) && /^\s*xcodebug\s*=/m.test(text))) configs.push(path);
      }
    } catch {
      // A config that cannot be read is reported by Codex itself; setup must not edit it.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  return configs;
}

function reportWarnings(registration) {
  for (const path of projectOverrides()) {
    console.error(`Warning: project Codex config may override xcodebug: ${path}`);
  }
  if (registration.stdout && !registration.stdout.includes(serverPath)) {
    console.error(`Warning: existing xcodebug registration points elsewhere; setup kept it: ${serverPath}`);
  }
}

function hasTimeout(registration) {
  return /^\s*tool_timeout_sec\s*:/m.test(registration.stdout);
}

async function writeTimeout() {
  const app = startAppServer();
  try {
    await app.request("initialize", { clientInfo: { name: "xcodebug-setup-codex", version: "1" } });
    app.child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
    const result = await app.request("config/value/write", {
      keyPath: "mcp_servers.xcodebug.tool_timeout_sec",
      value: TOOL_TIMEOUT_SECONDS,
      mergeStrategy: "upsert",
    });
    if (result?.status !== "ok") throw new Error(`Codex rejected the config write: ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

function startAppServer() {
  const child = spawn(codex, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pending = new Map();
  let nextId = 0;
  const input = createInterface({ input: child.stdout });
  input.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex app-server timed out during ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const close = async () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    input.close();
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  return { child, request, close, get stderr() { return stderr; } };
}

try {
  const registration = ensureServerRegistration();
  reportWarnings(registration);
  if (hasTimeout(registration)) {
    console.log("Existing Codex xcodebug tool timeout preserved");
  } else {
    await writeTimeout();
    console.log(`Configured xcodebug MCP timeout: ${TOOL_TIMEOUT_SECONDS}s`);
  }
} catch (error) {
  console.error(`xcodebug setup-codex failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
