import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import xcodebug from "../index.ts";

async function fixture(t, { code = 0, output, delayMs = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-feedback-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const requests = join(root, "requests.jsonl");
  await writeFile(join(root, ".xcodebug.json"), "invalid config: PRIVATE_DEVICE_SETTINGS");
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
const payload = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--raw-field' || args[i] === '--field') {
    const raw = args[++i], at = raw.indexOf('=');
    let value = raw.slice(at + 1);
    if (args[i - 1] === '--field' && value.startsWith('@')) value = fs.readFileSync(value.slice(1), 'utf8');
    payload[raw.slice(0, at)] = value;
  }
}
const endpoint = args.find(arg => arg.startsWith('repos/')) ?? 'repos/' + process.env.GH_REPO + '/issues';
const hostname = args.includes('--hostname') ? option('--hostname') : process.env.GH_HOST;
fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({endpoint, hostname, payload}) + '\\n');
const url = ${JSON.stringify(output)} ?? 'https://' + hostname + '/' + endpoint.slice(6) + '/73';
setTimeout(() => {
  if (${code}) process.stderr.write('Bad credentials: PRIVATE_AUTH_TOKEN');
  else process.stdout.write(url + '\\n');
  process.exit(${code});
}, ${delayMs});
`, { mode: 0o755 });
  const previous = { PATH: process.env.PATH, GH_HOST: process.env.GH_HOST, GH_REPO: process.env.GH_REPO };
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.GH_HOST = "enterprise.invalid";
  process.env.GH_REPO = "company/app";
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  let tool, slash;
  const messages = [];
  xcodebug({ registerTool(value) { tool = value; }, registerCommand(_, value) { slash = value.handler; },
    on() {}, sendMessage(message) { messages.push(message); } });
  const ctx = { cwd: root, agentDir: join(root, "agent"), hasUI: false,
    ui: { notify() {}, setStatus() {}, setWidget() {} } };
  const execute = (args, signal) => tool.execute("feedback-test", args, signal, undefined, ctx);
  const submitted = async () => (await readFile(requests, "utf8")).trim().split("\n").map(JSON.parse);
  return { root, bin, requests, execute, slash, ctx, messages, submitted };
}

test("feedback submits only explicit text to the xcodebug repository, without shell or file expansion", async t => {
  const f = await fixture(t);
  const secret = join(f.root, "secret.txt");
  const marker = join(f.root, "shell-ran");
  await writeFile(secret, "PRIVATE_FILE_CONTENT");
  const body = `@${secret}\n$(touch ${marker})\n    markdown = literal`;
  const result = await f.execute({ action: "feedback", title: "Log read timed out", body });
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(result.details.issueUrl, "https://github.com/sublimter/xcodebug/issues/73");
  const [request] = await f.submitted();
  assert.equal(request.endpoint, "repos/sublimter/xcodebug/issues");
  assert.equal(request.hostname, "github.com");
  assert.deepEqual(request.payload, { title: "Log read timed out", body });
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_DEVICE_SETTINGS|PRIVATE_FILE_CONTENT/);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("native feedback description creates an issue instead of launching an app", async t => {
  const f = await fixture(t);
  const cases = [
    ["feedback 读取日志时超时", "读取日志时超时"],
    ["feedback scheme=MiDong 运行失败", "scheme=MiDong 运行失败"],
    ["feedback foo=bar --force 读取失败", "foo=bar --force 读取失败"],
    ['feedback "scheme=MiDong 运行失败"', "scheme=MiDong 运行失败"],
    ['"feedback" scheme=MiDong 运行失败', "scheme=MiDong 运行失败"],
    ["'feedback' foo=bar --force 读取失败", "foo=bar --force 读取失败"],
    ["feedback 查询失败 --grep title=missing scheme=MiDong", "查询失败 --grep title=missing scheme=MiDong"],
    ["feedback 查询失败 --grep title=missing foo=bar", "查询失败 --grep title=missing foo=bar"],
    ["feedback 查询失败 --grep action=launch foo=bar", "查询失败 --grep action=launch foo=bar"],
  ];
  for (const [input, title] of cases) {
    await f.slash(input, f.ctx);
    assert.equal(f.messages.at(-1).details.action, "feedback");
    assert.equal(f.messages.at(-1).details.isError, false);
    assert.match(f.messages.at(-1).content, /https:\/\/github\.com\/sublimter\/xcodebug\/issues\/73/);
    assert.deepEqual((await f.submitted()).at(-1).payload, { title, body: "" });
  }
  await f.slash("feedback --body title=missing --title action=launch", f.ctx);
  assert.equal(f.messages.at(-1).details.isError, false);
  assert.deepEqual((await f.submitted()).at(-1).payload, { title: "action=launch", body: "title=missing" });
  for (const input of ["feedback 读取日志失败 action=launch", '"feedback" 读取日志失败 action=launch',
    "'feedback' 读取日志失败 --action launch", 'timeoutSeconds=5 "feedback" 读取日志失败 action=launch',
    'feedback 读取失败 body="复现步骤" timeoutSeconds=5', 'feedback body="Steps"',
    'feedback --grep title=missing title="Report" 查询失败']) {
    await f.slash(input, f.ctx);
    assert.equal(f.messages.at(-1).details.isError, true, input);
    assert.match(f.messages.at(-1).content, /invalid arguments \(no action started\):/, input);
  }
  assert.equal((await f.submitted()).length, cases.length + 1, "invalid commands must not post an issue");
});

test("failed feedback warns about uncertain creation without leaking auth details or retrying", async t => {
  const f = await fixture(t, { code: 1 });
  const result = await f.execute({ action: "feedback", title: "Log read timed out" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /issue may already have been created/);
  assert.match(result.content[0].text, /gh auth status/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUTH_TOKEN/);
  assert.equal((await f.submitted()).length, 1, "a public issue POST must never be retried automatically");
});

test("unexpected issue URLs are not presented as successful submission", async t => {
  const f = await fixture(t, { output: "https://attacker.invalid/issues/73" });
  const result = await f.execute({ action: "feedback", title: "Log read timed out" });
  assert.equal(result.isError, true);
  assert.equal(result.details.issueUrl, undefined);
  assert.doesNotMatch(result.content[0].text, /attacker\.invalid/);
  assert.equal((await f.submitted()).length, 1);
});

test("cancelled feedback retains the uncertainty warning after its request starts", { timeout: 5_000 }, async t => {
  const f = await fixture(t, { delayMs: 10_000 });
  const controller = new AbortController();
  const pending = f.execute({ action: "feedback", title: "Log read timed out" }, controller.signal);
  t.after(async () => { controller.abort(); await pending; });
  const deadline = Date.now() + 2_000;
  while (true) {
    try { await access(f.requests); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.ok(Date.now() < deadline, "feedback request did not start");
    await delay(10);
  }
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /issue may already have been created/);
  assert.equal((await f.submitted()).length, 1);
});

test("MCP feedback is cwd-free, accepts unset body, and rejects invalid requests before posting", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const child = spawn("bun", [new URL("../mcp/server.ts", import.meta.url).pathname], {
    cwd: f.root, env: { ...process.env, XCODEBUG_REQUIRE_PROJECT_CWD: "1", XCODEBUG_AGENT_DIR: join(f.root, "agent") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", data => { stderr += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    const result = JSON.parse(line), entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    clearTimeout(entry.timer);
    result.error ? entry.reject(new Error(JSON.stringify(result.error))) : entry.resolve(result.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 3_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    for (const entry of pending.values()) clearTimeout(entry.timer);
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "feedback-test", version: "1" } });
  const action = args => request("tools/call", { name: "xcodebug", arguments: args });
  const created = await action({ action: "feedback", title: "MCP report", body: null, cwd: null });
  assert.equal(created.isError, false, created.content[0].text);
  assert.match(created.content[0].text, /https:\/\/github\.com\/sublimter\/xcodebug\/issues\/73/);
  for (const args of [{ action: "feedback" }, { action: "feedback", title: " " },
    { action: "feedback", title: "MCP report", command: "exit 0" }]) {
    const result = await action(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid arguments \(no action started\)/);
  }
  assert.deepEqual((await f.submitted())[0].payload, { title: "MCP report", body: "" });
  assert.equal((await f.submitted()).length, 1, "invalid requests must not create public issues");
});
