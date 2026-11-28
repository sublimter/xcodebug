import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import xcodebug from "../index.ts";
import { mockPlatform, platformPreload } from "./platform-host.mjs";

async function host(t, platform, { clientPlatform = platform } = {}) {
  mockPlatform(t, clientPlatform);
  const root = await mkdtemp(join(tmpdir(), "xcodebug-platform-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "device-calls.jsonl");
  const requests = join(root, "feedback-requests.jsonl");
  await writeFile(join(root, ".xcodebug.json"), "invalid config: PRIVATE_PROJECT_SETTINGS");
  for (const name of ["gh", "xcrun", "xcodebuild", "idevicesyslog"]) {
    await writeFile(join(bin, name), `#!/usr/bin/env node
const fs = require('node:fs');
const name = ${JSON.stringify(name)}, args = process.argv.slice(2);
if (name === 'gh') {
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({pid: process.pid, args}) + '\\n');
  if (args.some(value => value.startsWith('title=hold-'))) setInterval(() => {}, 1000);
  else console.log('https://github.com/sublimter/xcodebug/issues/73');
} else {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({name, args}) + '\\n');
  console.log(args.includes('devices') ? '{"result":{"devices":[]}}' : 'fixture version');
}
`, { mode: 0o755 });
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  let tool, slash, child;
  const hooks = new Map(), messages = [], notifications = [], pending = new Map();
  xcodebug({ cwd: root, registerTool(value) { tool = value; }, registerCommand(_, value) { slash = value.handler; },
    on(name, handler) { hooks.set(name, handler); }, sendMessage(message) { messages.push(message); } });
  const ctx = { cwd: root, agentDir: join(root, "native"), hasUI: false,
    ui: { notify(message, level) { notifications.push({ message, level }); }, setStatus() {}, setWidget() {} } };
  const native = (args, context = ctx) => tool.execute("platform-test", args, undefined, undefined, context);
  t.after(async () => {
    try { await hooks.get("session_shutdown")?.(); } finally {
      if (child?.exitCode === null) {
        child.stdin.end();
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
      for (const entry of pending.values()) clearTimeout(entry.timer);
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
  child = spawn("bun", ["--preload", platformPreload, new URL("../mcp/server.ts", import.meta.url).pathname], {
    cwd: root, env: { ...process.env, XCODEBUG_TEST_PLATFORM: platform, XCODEBUG_REQUIRE_PROJECT_CWD: "1",
      XCODEBUG_AGENT_DIR: join(root, "mcp") }, stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`MCP timeout: ${method}; ${stderr}`));
    }, 3_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: `${clientPlatform}-client`, version: "1" } });
  const action = args => request("tools/call", { name: "xcodebug", arguments: args });
  const records = async () => (await readFile(requests, "utf8")).trim().split("\n").map(JSON.parse);
  const feedbackStarted = async title => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        const found = (await records()).find(record => record.args.includes(`title=${title}`));
        if (found) return found;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(10);
    }
    assert.fail(`feedback did not start: ${title}`);
  };
  return { root, calls, request, action, native, slash, ctx, hooks, messages, notifications, records, feedbackStarted };
}

for (const platform of ["linux", "win32"]) {
  test(`${platform} rejects Xcode actions before project access while keeping diagnostics and controls`, { timeout: 10_000 }, async t => {
    const h = await host(t, platform);
    const ui = { ...h.ctx, hasUI: true };
    await h.hooks.get("session_start")({}, ui);
    await h.hooks.get("session_start")({}, ui);
    const warnings = h.notifications.filter(entry => entry.level === "warning");
    assert.equal(warnings.length, 1, "repeated session starts must not spam the user");
    assert.match(warnings[0].message, new RegExp(platform));
    const tools = (await h.request("tools/list")).tools;
    assert.match(tools.find(tool => tool.name === "xcodebug").description, new RegExp(platform));
    for (const action of ["devices", "changes", "build", "install", "launch", "syslog", "terminate", "restart"]) {
      const native = await h.native({ action, workspace: "/missing-project" });
      assert.equal(native.isError, true);
      assert.deepEqual(native.details, { code: "unsupported_platform", platform, action, requiredPlatform: "darwin" });
      const mcp = await h.action({ action, cwd: "/missing-project" });
      assert.equal(mcp.isError, true);
      assert.deepEqual(mcp.structuredContent, native.details);
    }
    await h.slash("launch scheme=Missing", h.ctx);
    assert.equal(h.messages.at(-1).details.isError, true);
    assert.match(h.messages.at(-1).content, /macOS \+ Xcode/);
    for (const invoke of [h.native, h.action]) {
      const doctor = await invoke({ action: "doctor" });
      assert.notEqual(doctor.isError, true, doctor.content[0].text);
      assert.equal(doctor.details.platform, platform);
      assert.equal(doctor.details.macOSAvailable, false);
      assert.equal(doctor.details.shellAvailable, platform === "linux");
      assert.doesNotMatch(doctor.content[0].text, /PRIVATE_PROJECT_SETTINGS/);
      assert.notEqual((await invoke({ action: "status" })).isError, true);
      const history = await invoke({ action: "history" });
      assert.deepEqual(history.details.runs, []);
      assert.notEqual((await invoke({ action: "stop" })).isError, true);
    }
    const overrides = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.endsWith("_CODING_AGENT_DIR")));
    for (const name of Object.keys(overrides)) delete process.env[name];
    try {
      const context = { ...h.ctx, agentDir: undefined };
      const diagnostic = await h.native({ action: "doctor" }, context);
      assert.notEqual(diagnostic.isError, true);
      assert.equal(diagnostic.details.platform, platform);
      assert.match(diagnostic.content[0].text, /log dir: unavailable.*cannot locate the agent directory/);
      await assert.rejects(h.native({ action: "history" }, context), /cannot locate the agent directory/);
    } finally { Object.assign(process.env, overrides); }
    const created = await h.action({ action: "feedback", title: "Platform report", body: "Explicit body" });
    assert.equal(created.isError, false, created.content[0].text);
    assert.match(created.content[0].text, /issues\/73/);
    const [record] = await h.records();
    assert.ok(record.args.includes("title=Platform report") && record.args.includes("body=Explicit body"));
    await assert.rejects(access(h.calls), { code: "ENOENT" }, "neither rejection nor doctor may probe Xcode/device CLIs");
  });

  test(`${platform} rejects unsupported requests without queueing behind feedback and still cleans stop`, { timeout: 10_000 }, async t => {
    const h = await host(t, platform);
    let nativeSettled = false;
    const nativeRunning = h.native({ action: "feedback", title: "hold-native" }).finally(() => { nativeSettled = true; });
    void nativeRunning.catch(() => {});
    const nativeProcess = await h.feedbackStarted("hold-native");
    const nativeBlocked = await h.native({ action: "launch" });
    assert.equal(nativeBlocked.details.code, "unsupported_platform");
    assert.equal(nativeSettled, false, "a rejected action must not wait for or cancel active feedback");
    const marker = join(h.root, "command-ran");
    const stopArgs = platform === "win32" ? { action: "stop", command: `touch '${marker}'` } : { action: "stop" };
    const nativeStopped = await h.native(stopArgs);
    assert.equal((await nativeRunning).isError, true);
    assert.throws(() => process.kill(nativeProcess.pid, 0), { code: "ESRCH" });
    assert.equal(platform === "win32" ? nativeStopped.details.primary.cancelledOperations : nativeStopped.details.cancelledOperations, 1);
    if (platform === "win32") assert.equal(nativeStopped.details.command.code, "unsupported_shell");
    let mcpSettled = false;
    const running = h.action({ action: "feedback", title: "hold-mcp" }).finally(() => { mcpSettled = true; });
    void running.catch(() => {});
    const mcpProcess = await h.feedbackStarted("hold-mcp");
    const blocked = await h.action({ action: "launch", cwd: "/missing-project" });
    assert.equal(blocked.structuredContent.code, "unsupported_platform");
    assert.equal(mcpSettled, false, "platform errors must bypass the MCP execution queue");
    const stopped = await h.action(stopArgs);
    assert.equal((await running).isError, true);
    assert.throws(() => process.kill(mcpProcess.pid, 0), { code: "ESRCH" });
    if (platform === "win32") {
      assert.deepEqual(stopped.structuredContent, { code: "unsupported_shell", platform, action: "stop", requiredShell: "/bin/sh" });
      assert.equal(stopped.details.primary.cleanupPending === true, false);
      const unavailable = await h.action({ action: "await", command: `touch '${marker}'`, cwd: "/missing-project" });
      assert.equal(unavailable.structuredContent.code, "unsupported_shell");
      const noProjectNeeded = await h.action({ action: "stop", command: `touch '${marker}'`, cwd: "/missing-project" });
      assert.equal(noProjectNeeded.structuredContent.code, "unsupported_shell");
      await assert.rejects(access(marker), { code: "ENOENT" });
    } else {
      const executed = await h.action({ action: "await", command: `printf done > '${marker}'; exit 7`, cwd: h.root });
      assert.equal(executed.isError, true);
      assert.equal(executed.details.exitCode, 7);
      assert.equal(await readFile(marker, "utf8"), "done");
    }
    await assert.rejects(access(h.calls), { code: "ENOENT" });
  });
}

test("a Windows client can use Xcode actions on a Mac MCP execution host", { timeout: 8_000 }, async t => {
  const h = await host(t, "darwin", { clientPlatform: "win32" });
  const result = await h.action({ action: "devices" });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(result.details.devices, []);
  const calls = (await readFile(h.calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls[0].name, "xcrun");
});
