import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the real stdio adapter and real child pipes; only device CLIs are fake.
test("UI snapshots show operation phases and resume live capture between actions", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-ui-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const device = { identifier: "test-device", properties: {
    hardware: { udid: "test-udid", reality: "physical" },
    connection: { state: "connected", transportType: "wired" }, state: { name: "Test" },
  } };
  await writeFile(join(bin, "xcrun"), `#!/bin/sh
case " $* " in
  *" device install app "*)
    touch '${root}/install-started'
    while [ ! -f '${root}/install-release' ]; do /bin/sleep 0.05; done
    exit 0 ;;
esac
printf '%s\\n' '${JSON.stringify({ result: { devices: [device] } })}'
`, { mode: 0o755 });
  await writeFile(join(bin, "xcodebuild"), `#!/bin/sh
touch '${root}/build-started'
printf 'CompileC UIProbe\\n'
while [ ! -f '${root}/build-release' ]; do /bin/sleep 0.05; done
printf '** BUILD FAILED **\\n' >&2
exit 65
`, { mode: 0o755 });
  await writeFile(join(bin, "idevicesyslog"), `#!/bin/sh
n=0
while :; do
  n=$((n + 1))
  printf 'UI heartbeat %s\\n' "$n"
  /bin/sleep 0.1
done
`, { mode: 0o755 });
  // Left by servers that were killed before they could remove their own file.
  // No process has this pid; the test's own pid stands for a server still running.
  const deadFile = join(root, "ui", "2147483646.json");
  const liveFile = join(root, "ui", `${process.pid}.json`);
  await mkdir(join(root, "ui"));
  await Promise.all([deadFile, liveFile].map(path => writeFile(path, '{"rows":["left behind"],"seq":1}')));
  const child = spawn("bun", [new URL("../mcp/server.ts", import.meta.url).pathname], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XCODEBUG_AGENT_DIR: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  let stderr = "";
  const pending = new Map();
  const notifications = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else notifications.push(message);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timed out: ${method}; ${stderr}`)); }, 12_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  const action = (args, token) => request("tools/call", {
    name: "xcodebug", arguments: args, ...(token ? { _meta: { progressToken: token } } : {}),
  });
  const snapshot = async () => JSON.parse((await request("tools/call", { name: "xcodebug_ui", arguments: {} })).content[0].text);
  const waitForStart = async name => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try { await access(join(root, name)); return; } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    assert.fail(`fixture did not start: ${name}`);
  };
  t.after(async () => {
    await Promise.all(["install-release", "build-release"].map(name => writeFile(join(root, name), "")));
    try { await action({ action: "stop" }); } finally {
      child.stdin.end();
      child.kill();
      for (const entry of pending.values()) clearTimeout(entry.timer);
      await rm(root, { recursive: true, force: true });
    }
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ui-test", version: "1" } });
  // The mod reads this file between tool calls; it must say what xcodebug_ui says.
  const { file } = await snapshot();
  const published = async () => JSON.parse(await readFile(file, "utf8"));
  await t.test("the snapshot file exists before anything is painted", async () => {
    assert.ok(file.startsWith(root), `expected a file under the agent dir, got ${file}`);
    assert.deepEqual((await published()).rows, []);
  });
  await t.test("a killed server's file is removed, a running server's is kept", async () => {
    await assert.rejects(access(deadFile), { code: "ENOENT" });
    await access(liveFile);
  });
  await t.test("standalone install publishes its phase and clears after success", async () => {
    const idle = await published();
    const installing = action({ action: "install", device: "test-device", appPath: "/test/Probe.app" });
    try {
      await waitForStart("install-started");
      const duringInstall = await snapshot();
      assert.ok(duringInstall.rows.some(row => row.includes("installing on Test")), JSON.stringify(duringInstall));
      const onDisk = await published();
      assert.ok(onDisk.rows.some(row => row.includes("installing on Test")), JSON.stringify(onDisk));
      assert.ok(onDisk.seq > idle.seq, "each repaint must advance seq, so a reader can tell a live file from a frozen one");
    } finally {
      await writeFile(join(root, "install-release"), "");
      assert.equal((await installing).isError, false);
    }
    assert.deepEqual((await snapshot()).rows, []);
    assert.deepEqual((await published()).rows, []);
  });
  await action({ action: "syslog", device: "test-device", processName: "Heartbeat", push: "off" }, "launch-token");
  const afterResponse = notifications.length;
  await delay(1200);
  const first = await snapshot();
  assert.ok(first.rows.some(row => row.includes("UI heartbeat")), JSON.stringify(first));
  await delay(1200);
  const second = await snapshot();
  assert.notDeepEqual(second.rows, first.rows, "idle capture must continue to repaint after syslog returns");
  assert.equal(notifications.length, afterResponse, "closed progress tokens must not be reused for idle paints");

  await t.test("a build takes priority over capture and restores it after failure", async () => {
    const building = action({ action: "build", device: "test-device", project: join(root, "UIProbe.xcodeproj"), scheme: "UIProbe", force: true });
    try {
      await waitForStart("build-started");
      const duringBuild = await snapshot();
      assert.match(duringBuild.rows[0], /running/);
      assert.ok(duringBuild.rows.some(row => /building|compil/i.test(row)), JSON.stringify(duringBuild));
    } finally {
      await writeFile(join(root, "build-release"), "");
      assert.equal((await building).isError, true);
    }
    const afterBuild = await snapshot();
    assert.match(afterBuild.rows[0], /capturing/);
    assert.ok(afterBuild.rows.some(row => row.includes("UI heartbeat")));
  });

  await t.test("cancelling install restores the existing capture display", async () => {
    await rm(join(root, "install-started"));
    await rm(join(root, "install-release"));
    const requestId = id + 1;
    const installing = action({ action: "install", device: "test-device", appPath: "/test/Probe.app" });
    try {
      await waitForStart("install-started");
      assert.ok((await snapshot()).rows.some(row => row.includes("installing on Test")));
    } finally {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } })}\n`);
      assert.equal((await installing).isError, true);
    }
    assert.match((await snapshot()).rows[0], /capturing/);
  });

  let waitSettled = false;
  const waiting = action({ action: "wait", match: "NEVER_MATCH_THIS", timeoutSeconds: 3 });
  waiting.finally(() => { waitSettled = true; });
  await delay(100);
  const duringWait = await Promise.race([snapshot(), delay(700).then(() => { throw new Error("UI read was blocked by wait"); })]);
  assert.equal(waitSettled, false);
  assert.ok(duringWait.rows.some(row => row.includes("UI heartbeat")));
  await waiting;
  await action({ action: "stop" });
  assert.deepEqual((await snapshot()).rows, [], "stopped captures must clear the band");
  assert.deepEqual((await published()).rows, [], "the file must clear with the band");
});

// Claude Code ends a stdio server with SIGINT, not by closing its stdin.
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} removes the snapshot file`, { timeout: 15_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "xcodebug-ui-exit-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = spawn("bun", [new URL("../mcp/server.ts", import.meta.url).pathname], {
      cwd: root, env: { ...process.env, XCODEBUG_AGENT_DIR: root }, stdio: ["pipe", "ignore", "inherit"],
    });
    t.after(() => child.kill("SIGKILL"));
    const file = join(root, "ui", `${child.pid}.json`);
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await access(file); break; } catch (error) {
        if (error.code !== "ENOENT" || Date.now() > deadline) throw error;
      }
      await delay(25);
    }
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill(signal);
    await exited;
    await assert.rejects(access(file), { code: "ENOENT" });
  });
}
