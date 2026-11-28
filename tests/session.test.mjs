import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Writable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import xcodebug from "../index.ts";
import { mockPlatform } from "./platform-host.mjs";

test("ended history stays bounded without evicting active or reconnecting captures", { timeout: 60_000 }, async t => {
  mockPlatform(t, "darwin");
  const root = await mkdtemp(join(tmpdir(), "xcodebug-session-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const marker = join(root, "reattach");
  const device = { identifier: "test-device", properties: {
    hardware: { udid: "test-udid", reality: "physical" },
    connection: { state: "connected", transportType: "wired" }, state: { name: "Test" },
  } };
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(bin, "xcrun"), `#!/bin/sh\nprintf '%s\\n' ${quote(JSON.stringify({ result: { devices: [device] } }))}\n`, { mode: 0o755 });
  await writeFile(join(bin, "idevicesyslog"), `#!/bin/sh
printf 'ready\\n'
if [ "$4" = reconnecting ]; then
  [ -f ${quote(marker)} ] || exit 0
  printf 'heartbeat\\n'
fi
exec /bin/sleep 60
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let tool;
  const hooks = new Map();
  xcodebug({ cwd: root, registerTool(value) { tool = value; }, on(name, fn) { hooks.set(name, fn); },
    registerCommand() {}, sendMessage() {} });
  const context = { cwd: root, agentDir: root, hasUI: true, ui: { setStatus() {}, setWidget() {}, notify() {} } };
  const call = args => tool.execute("test", args, undefined, undefined, context);
  const ok = async args => {
    const result = await call(args);
    assert.ok(!result.isError, result.content[0]?.text);
    return result;
  };
  t.after(async () => {
    try { await call({ action: "stop" }); await hooks.get("session_shutdown")(); }
    finally { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); }
  });
  const running = (await ok({ action: "syslog", device: "test-device", processName: "keep-running", push: "off" })).details.capture.id;
  const reconnecting = (await ok({ action: "syslog", device: "test-device", processName: "reconnecting", push: "off" })).details.capture.id;
  await ok({ action: "wait", captureId: reconnecting, match: "ready", timeoutSeconds: 3 });
  await delay(50);
  const ended = [];
  for (let i = 0; i < 14; i++) {
    const id = (await ok({ action: "syslog", device: "test-device", processName: "cycled", push: "off" })).details.capture.id;
    await ok({ action: "wait", captureId: id, match: "ready", timeoutSeconds: 3 });
    await ok({ action: "stop", captureId: id });
    ended.push(id);
  }
  const captures = (await ok({ action: "status" })).details.captures;
  assert.equal(captures.filter(capture => ended.includes(capture.id)).length, 10);
  assert.ok(captures.some(capture => capture.id === running && capture.running));
  assert.ok(captures.some(capture => capture.id === reconnecting));
  await assert.rejects(call({ action: "logs", captureId: ended[0] }), /Unknown capture/);
  assert.match((await ok({ action: "logs", captureId: ended.at(-1) })).content[0].text, /ready/);
  await writeFile(marker, "");
  const deadline = Date.now() + 6_000;
  let reattached = false;
  while (Date.now() < deadline) {
    const status = (await ok({ action: "status" })).details.captures;
    if (status.some(capture => capture.id === reconnecting && capture.running)) {
      reattached = true;
      break;
    }
    await delay(20);
  }
  assert.equal(reattached, true, "the reconnecting capture must survive history eviction");
  assert.match((await ok({ action: "wait", captureId: reconnecting, match: "heartbeat", timeoutSeconds: 6 })).content[0].text, /heartbeat/);
  await ok({ action: "stop" });
  const final = (await ok({ action: "status" })).details.captures;
  assert.equal(final.length, 10);
  assert.ok(final.every(capture => !capture.running));
});

test("stopping console stops its companion before the console writer drains", { timeout: 20_000 }, async t => {
  mockPlatform(t, "darwin");
  const root = await mkdtemp(join(tmpdir(), "xcodebug-companion-test-"));
  const bin = join(root, "bin");
  const oldPath = process.env.PATH;
  const originalCreateWriteStream = fs.createWriteStream;
  const pendingWrites = [];
  let released = false;
  let writer;
  let stopPromise;
  let tool;
  const hooks = new Map();
  const releaseWriter = () => {
    released = true;
    for (const callback of pendingWrites.splice(0)) callback();
  };
  const context = { cwd: root, agentDir: root, hasUI: true, ui: { setStatus() {}, setWidget() {}, notify() {} } };
  const call = args => tool.execute("test", args, undefined, undefined, context);
  const ok = async args => {
    const result = await call(args);
    assert.ok(!result.isError, result.content[0]?.text);
    return result;
  };
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    await mkdir(bin);
    const device = { identifier: "test-device", properties: {
      hardware: { udid: "test-udid", reality: "physical" },
      connection: { state: "connected", transportType: "wired" }, state: { name: "Test" },
    } };
    const devicesJSON = JSON.stringify({ result: { devices: [device] } });
    const processesJSON = JSON.stringify({ result: { runningProcesses: [
      { executable: "/ReviewApp.app/ReviewApp", processIdentifier: 1234 },
    ] } });
    // The app is in the process table once it has been launched, not before:
    // launch tells its own instance from one that was already running by pid.
    await writeFile(join(bin, "xcrun"), `#!/bin/sh
case "$*" in
  *"list devices"*) printf '%s\\n' ${quote(devicesJSON)} ;;
  *"info processes"*)
    if [ -f ${quote(join(root, "launched"))} ]; then printf '%s\\n' ${quote(processesJSON)}
    else printf '%s\\n' '{"result":{"runningProcesses":[]}}'; fi ;;
  *"install app"*) exit 0 ;;
  *"process launch"*) : > ${quote(join(root, "launched"))}; printf 'console ready\\n'; exec /bin/sleep 60 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    await writeFile(join(bin, "idevicesyslog"), "#!/bin/sh\nprintf 'syslog ready\\n'\nexec /bin/sleep 60\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${oldPath}`;
    fs.createWriteStream = (path, options) => {
      if (!String(path).includes("/console-")) return originalCreateWriteStream(path, options);
      writer = new Writable({
        write(_chunk, _encoding, callback) {
          if (released) callback();
          else pendingWrites.push(callback);
        },
      });
      // Capture tracks successfully opened writers; this controlled sink has no fd.
      queueMicrotask(() => writer.emit("open", 123));
      return writer;
    };
    syncBuiltinESMExports();
    xcodebug({ cwd: root, registerTool(value) { tool = value; }, on(name, fn) { hooks.set(name, fn); },
      registerCommand() {}, sendMessage() {} });
    const launch = await ok({ action: "launch", build: false, appPath: join(root, "ReviewApp.app"),
      device: "test-device", bundleId: "test.review", processName: "ReviewApp", push: "off" });
    const consoleId = launch.details.capture.id;
    await ok({ action: "wait", captureId: consoleId, match: "console ready", timeoutSeconds: 3 });
    const initial = (await ok({ action: "status" })).details.captures;
    const companion = initial.find(capture => capture.mode === "syslog");
    assert.ok(companion, "launch must create the syslog companion");
    await ok({ action: "wait", captureId: companion.id, match: "syslog ready", timeoutSeconds: 3 });
    assert.ok(initial.find(capture => capture.id === consoleId)?.running);
    assert.equal(companion.running, true);
    assert.ok(pendingWrites.length > 0, "console writes must remain blocked");

    let stopSettled = false;
    stopPromise = ok({ action: "stop", captureId: consoleId, keepApp: true });
    void stopPromise.then(() => { stopSettled = true; }, () => { stopSettled = true; });
    // This window ends well before the two-second console drain deadline.
    const deadline = Date.now() + 700;
    let duringStop;
    do {
      duringStop = (await ok({ action: "status" })).details.captures;
      if (!duringStop.find(capture => capture.id === companion.id)?.running) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert.equal(duringStop.find(capture => capture.id === companion.id)?.running, false,
      "companion must stop while console file drainage is still blocked");
    assert.equal(duringStop.find(capture => capture.id === consoleId)?.running, true);
    assert.equal(stopSettled, false);
    assert.equal(released, false);

    releaseWriter();
    await stopPromise;
    // Cross the first reconnect backoff to catch an exit notification restarting a bridge.
    await delay(1_200);
    const ended = (await ok({ action: "status" })).details.captures;
    assert.equal(ended.length, 2);
    assert.ok(ended.every(capture => !capture.running));
    for (const capture of ended) {
      const logs = await ok({ action: "logs", captureId: capture.id });
      assert.doesNotMatch(logs.content[0].text, /reconnecting|reattached/);
    }
  } finally {
    releaseWriter();
    try {
      try {
        if (stopPromise) await stopPromise;
      } finally {
        try {
          if (tool) await call({ action: "stop" });
        } finally {
          await hooks.get("session_shutdown")?.();
        }
      }
    } finally {
      writer?.destroy();
      fs.createWriteStream = originalCreateWriteStream;
      syncBuiltinESMExports();
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  }
});
