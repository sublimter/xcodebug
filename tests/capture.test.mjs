import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { addAbortSignal, PassThrough, Writable } from "node:stream";
import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Capture } from "../capture.ts";

function capture(options = {}) {
  return new Capture({
    mode: "console", deviceId: "test", deviceLabel: "test", bundleId: "test",
    logDir: tmpdir(), command: process.execPath, args: [], ...options,
  });
}

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "xcodebug-capture-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function idleCapture(t, dir) {
  const c = capture({ logDir: dir, args: ["-e", "setInterval(() => {}, 1000)"] });
  t.after(async () => {
    c.stop(false);
    await c.waitForExit(5_000);
  });
  await c.start();
  return c;
}

function holdLaunchResultRead(t, dir) {
  const { promise: reading, resolve: readStarted } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const original = fs.promises.readFile;
  let held = false;
  t.mock.method(fs.promises, "readFile", async (path, ...args) => {
    if (!held && String(path).startsWith(join(dir, ".xcodebug-launch-")) && String(path).endsWith("/launch.json")) {
      held = true;
      const raw = await original(path, ...args);
      readStarted({ path: String(path), signal: args[0]?.signal });
      await released;
      return raw;
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { reading, release };
}

function holdLogWrites(t, path) {
  fs.writeFileSync(path, "");
  let held = true;
  let release;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      const append = () => {
        try {
          fs.appendFileSync(path, chunk);
          callback();
        } catch (error) {
          callback(error);
        }
      };
      if (held) release = () => { held = false; append(); };
      else append();
    },
  });
  t.mock.method(fs, "createWriteStream", () => sink);
  syncBuiltinESMExports();
  t.after(() => {
    sink.destroy();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => release();
}

const producer = String.raw`
  const { once } = require('node:events');
  (async () => {
    for (let i = 0; i < Number(process.argv[1]); i++) {
      if (!process.stdout.write(i + ' ' + 'x'.repeat(Number(process.argv[2])) + '\n')) {
        await once(process.stdout, 'drain');
      }
    }
    if (process.argv[3]) process.stdout.write(process.argv[3] + '\n');
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

test("bounded buffer preserves cursor, chronological tails and filtered totals", () => {
  const c = capture();
  for (let i = 1; i <= 25_000; i++) c.pushLine(i % 2 ? "out" : "err", `line ${i}`);
  assert.equal(c.status().droppedLines, 5_000);
  assert.deepEqual(c.read({ limit: 3 }).lines.map(line => line.index), [24_998, 24_999, 25_000]);
  const filtered = c.read({ since: 24_990, streams: ["err"], grep: "line", limit: 2 });
  assert.deepEqual(filtered.lines.map(line => line.index), [24_998, 25_000]);
  assert.equal(filtered.total, 5);
  assert.equal(filtered.cursor, 25_000);
  assert.deepEqual(c.read({ since: 25_000 }).lines, []);
});

test("long lines cannot make the retained text exceed 4 MiB", () => {
  const c = capture();
  for (let i = 0; i < 1_000; i++) c.pushLine("out", `${i} ${"字".repeat(8_192)}`);
  const retained = c.read({ limit: 5_000 });
  assert.ok(retained.lines.reduce((bytes, line) => bytes + line.text.length * 2, 0) <= 4 * 1024 * 1024);
  assert.match(retained.lines.at(-1).text, /^999 /);
  assert.equal(c.status().droppedLines + retained.total, 1_000);
  c.pushLine("err", "z".repeat(3 * 1024 * 1024));
  assert.equal(c.read({ since: 1_000 }).lines.length, 0);
  c.pushLine("out", "after oversized line");
  assert.equal(c.read({ limit: 1 }).lines[0].text, "after oversized line");
  assert.equal(c.status().cursor, 1_002);
});

test("a search cannot advance past a pending write, including when started by a line listener", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const path = join(dir, "pending.log");
  const release = holdLogWrites(t, path);
  const c = capture({ logFile: path, args: ["-e", "setInterval(() => {}, 1000)"] });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  await c.start();
  let searching;
  t.after(c.onLine(line => {
    if (line.index === 1) searching = c.search({ grep: "MATCH" });
  }));
  c.pushLine("out", `MATCH ${"x".repeat(3 * 1024 * 1024)}`);
  let settled = false;
  void searching.then(() => { settled = true; });
  await delay(20);
  assert.equal(settled, false, "EOF before the queued write must not produce a final cursor");
  c.pushLine("out", "MATCH later");
  release();
  const found = await searching;
  assert.deepEqual(found.lines.map(line => [line.index, line.text.slice(0, 6)]), [[1, "MATCH "]]);
  assert.deepEqual([found.cursor, found.total, found.evicted, found.missing], [1, 1, 1, 0]);
  const later = await c.search({ since: found.cursor, grep: "MATCH" });
  assert.deepEqual(later.lines.map(line => [line.index, line.text]), [[2, "MATCH later"]]);
});

test("disk search fills interior oversized-line holes and merges chronological tails", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const c = await idleCapture(t, dir);
  c.pushLine("out", "MATCH before");
  c.pushLine("out", `MATCH ${"x".repeat(3 * 1024 * 1024)}`);
  c.pushLine("out", "MATCH after");
  const memory = c.read({});
  assert.deepEqual(memory.lines.map(line => line.index), [1, 3]);
  assert.equal(memory.evicted, 1);
  const found = await c.search({ grep: "MATCH", limit: 2 });
  assert.deepEqual(found.lines.map(line => line.index), [2, 3]);
  assert.deepEqual([found.cursor, found.total, found.evicted, found.missing], [3, 3, 1, 0]);
  const since = await c.search({ since: 1, grep: "MATCH" });
  assert.deepEqual(since.lines.map(line => line.index), [2, 3]);
  assert.deepEqual([since.total, since.evicted, since.missing], [2, 1, 0]);
  assert.deepEqual((await c.search({ grep: "MATCH", limit: 1 })).lines.map(line => line.index), [3]);
  assert.equal((await c.search({ since: 2, grep: "MATCH" })).evicted, 0);
});

test("an interior hole without a disk copy is reported as missing", async () => {
  const c = capture();
  c.pushLine("out", "MATCH before");
  c.pushLine("out", `MATCH ${"x".repeat(3 * 1024 * 1024)}`);
  c.pushLine("out", "MATCH after");
  const found = await c.search({ grep: "MATCH" });
  assert.deepEqual(found.lines.map(line => line.index), [1, 3]);
  assert.deepEqual([found.total, found.evicted, found.missing], [2, 1, 1]);
});

test("search cancellation interrupts a pending writer barrier", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const path = join(dir, "pending.log");
  const release = holdLogWrites(t, path);
  const c = capture({ logFile: path, args: ["-e", "setInterval(() => {}, 1000)"] });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  await c.start();
  c.pushLine("out", `MATCH ${"x".repeat(3 * 1024 * 1024)}`);
  const abort = new AbortController();
  const reason = new Error("search cancelled");
  const searching = c.search({ grep: "MATCH", signal: abort.signal });
  abort.abort(reason);
  await assert.rejects(searching, error => error === reason);
  release();
  const found = await c.search({ grep: "MATCH" });
  assert.deepEqual([found.total, found.missing], [1, 0], "cancelling a search does not cancel capture writes");
});

test("search cancellation destroys an active disk reader and preserves the abort reason", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const c = await idleCapture(t, dir);
  c.pushLine("out", `MATCH ${"x".repeat(3 * 1024 * 1024)}`);
  c.stop(false);
  assert.equal(await c.waitForExit(5_000), true);
  const abort = new AbortController();
  const reason = new Error("scan cancelled");
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let reader;
  t.mock.method(fs, "createReadStream", (_path, options) => {
    assert.equal(options.signal, abort.signal);
    reader = addAbortSignal(options.signal, new PassThrough());
    started();
    return reader;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const searching = c.search({ grep: "MATCH", signal: abort.signal });
  await ready;
  abort.abort(reason);
  await assert.rejects(searching, error => error === reason);
  assert.equal(reader.destroyed, true);
});

test("an already-aborted search rejects even when all lines are in memory", async () => {
  const c = capture();
  c.pushLine("out", "MATCH");
  const reason = new Error("already cancelled");
  await assert.rejects(c.search({ grep: "MATCH", signal: AbortSignal.abort(reason) }), error => error === reason);
});

test("a stop during start's mkdir prevents opening a writer or spawning a bridge", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const c = capture({ logDir: dir, args: ["-e", "setInterval(() => {}, 1000)"] });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  const starting = c.start();
  c.stop(false);
  await starting;
  assert.equal(c.running, false);
  assert.equal(c.pid, undefined);
  assert.deepEqual(await readdir(dir), []);
  c.resetForReconnect();
  await c.start();
  assert.equal(c.running, false, "reconnect must not clear explicit stop intent");
});

test("a cancelled start never opens a writer or spawns a bridge", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const c = capture({ logDir: dir, args: ["-e", "setInterval(() => {}, 1000)"] });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  const abort = new AbortController();
  const reason = new Error("start cancelled");
  const starting = c.start(abort.signal);
  abort.abort(reason);
  await assert.rejects(starting, error => error === reason);
  assert.equal(c.running, false);
  assert.equal(c.pid, undefined);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(c.start(abort.signal), error => error === reason);
  assert.equal(c.running, false);
});

test("owned launch result survives natural exit followed by stop without entering logs", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const raw = '{"result":{"process":{"processIdentifier":123}}}\n';
  const script = `
    const fs = require('node:fs');
    const args = process.argv.slice(1);
    const output = args.indexOf('--json-output');
    if (output < 0 || args[output + 2] !== '--console' || args.at(-2) !== '--' || args.at(-1) !== 'app-argument') process.exit(2);
    fs.writeFileSync(args[output + 1], ${JSON.stringify(raw)});
    console.log('app output');
    process.exitCode = 1;
  `;
  const args = ["-e", script, "--", "--console", "--", "app-argument"];
  const original = [...args];
  const c = capture({ logDir: dir, args, collectLaunchResult: true });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  let observedResult;
  let observedExitAt;
  c.onProcessExit(() => {
    observedResult = c.launchResult;
    observedExitAt = c.naturalExitAt;
    c.stop(false);
  });
  await c.start();
  const result = c.launchResult;
  assert.equal(await c.waitForExit(5_000), true);
  assert.equal(observedResult, result);
  assert.equal(typeof observedExitAt, "number");
  assert.equal(await result, raw);
  assert.equal(c.status().exitCode, 1);
  assert.deepEqual(args, original, "caller launch arguments must not be mutated");
  assert.match(c.status().commandLine, /--json-output .* --console -- app-argument$/);
  assert.deepEqual(c.read({ since: 0 }).lines.map(line => line.text), ["app output"]);
  assert.deepEqual(await readdir(dir), [c.logFile.split("/").at(-1)]);
});

for (const action of ["stop", "shutdown"]) {
  test(`${action} keeps its own result-read cancellation semantics after natural exit`, { timeout: 10_000 }, async t => {
    const dir = await directory(t);
    const { reading, release } = holdLaunchResultRead(t, dir);
    const raw = '{"result":{"process":{"processIdentifier":123}}}\n';
    const script = `
      const fs = require('node:fs');
      const args = process.argv.slice(1);
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], ${JSON.stringify(raw)});
      console.log('app output');
    `;
    const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", script, "--", "--console"] });
    t.after(async () => { await c.shutdown(); });
    await c.start();
    const result = c.launchResult;
    const held = await reading;
    assert.equal(await c.waitForExit(5_000), true);
    const resultDir = held.path.slice(0, -"/launch.json".length);
    const owner = JSON.parse(await fs.promises.readFile(join(resultDir, "owner.json"), "utf8"));
    assert.deepEqual(Object.keys(owner).sort(), ["createdAt", "kind", "pid", "version"]);
    assert.equal(owner.kind, "xcodebug.launch-result");
    assert.equal(owner.version, 1);
    assert.equal(owner.pid, process.pid);
    assert.ok(Number.isSafeInteger(owner.createdAt) && owner.createdAt >= c.startedAt && owner.createdAt <= Date.now());
    assert.equal((await stat(resultDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(resultDir, "owner.json"))).mode & 0o777, 0o600);
    let settled = false;
    let cleanupSettled = false;
    void result.then(() => { settled = true; });
    const cleanup = c.waitForLaunchResults().then(() => { cleanupSettled = true; });
    if (action === "stop") {
      c.stop(false);
      await delay(0);
      assert.equal(held.signal.aborted, false, "ordinary stop must not cancel independent exit diagnostics");
      assert.equal(settled, false);
      assert.equal(cleanupSettled, false);
      assert.equal(await fs.promises.readFile(held.path, "utf8"), raw);
      release();
      assert.equal(await result, raw);
      await cleanup;
    } else {
      assert.equal(await c.shutdown(), true);
      assert.equal(held.signal.aborted, true);
      assert.equal(await result, undefined);
      await cleanup;
      assert.equal(cleanupSettled, true);
      assert.equal((await readdir(dir)).some(name => name.startsWith(".xcodebug-launch-")), false,
        "shutdown must remove the result without releasing the held read");
      const terminal = c.status();
      release();
      await delay(0);
      assert.deepEqual(c.status(), terminal, "a late result-read callback must not rewrite terminal state");
      await c.start();
      assert.equal(c.launchResult, result, "shutdown must not start or register another run");
      assert.equal(c.running, false);
      assert.equal(c.starting, false);
    }
    assert.deepEqual(c.read({ since: 0 }).lines.map(line => line.text), ["app output"]);
    assert.deepEqual(await readdir(dir), [c.logFile.split("/").at(-1)]);
  });
}

test("owned launch result cleanup failure is reported without losing the result", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const originalRmdir = fs.promises.rmdir;
  t.mock.method(fs.promises, "rmdir", async (path, ...args) => {
    if (String(path).startsWith(join(dir, ".xcodebug-launch-"))) {
      const error = new Error("owned result directory removal denied");
      error.code = "EACCES";
      throw error;
    }
    return originalRmdir(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const raw = '{"result":{"process":{"processIdentifier":123}}}';
  const script = `
    const fs = require('node:fs');
    const args = process.argv.slice(1);
    fs.writeFileSync(args[args.indexOf('--json-output') + 1], ${JSON.stringify(raw)});
    console.log('console complete');
  `;
  const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", script, "--", "--console"] });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  await c.start();
  assert.equal(await c.waitForExit(5_000), true);
  assert.equal(await c.launchResult, raw);
  assert.match(c.status().error, /launch result cleanup failed:.*removal denied/);
});

for (const [scenario, raw] of [["missing", undefined], ["malformed", "{malformed command result"], ["unreadable", undefined]]) {
  test(`a ${scenario} owned launch result settles and removes its directory`, { timeout: 10_000 }, async t => {
    const dir = await directory(t);
    if (scenario === "unreadable") {
      const original = fs.promises.readFile;
      t.mock.method(fs.promises, "readFile", async (path, ...args) => {
        if (String(path).startsWith(join(dir, ".xcodebug-launch-")) && String(path).endsWith("/launch.json")) {
          const error = new Error("launch result read denied");
          error.code = "EACCES";
          throw error;
        }
        return original(path, ...args);
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    }
    const script = `
      const fs = require('node:fs');
      const args = process.argv.slice(1);
      const raw = ${JSON.stringify(scenario === "unreadable" ? "unreadable result" : raw)};
      if (raw !== undefined) fs.writeFileSync(args[args.indexOf('--json-output') + 1], raw);
      console.log('console complete');
    `;
    const c = capture({ logDir: dir, args: ["-e", script, "--", "--console"], collectLaunchResult: true });
    t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
    await c.start();
    assert.equal(await c.waitForExit(5_000), true);
    assert.equal(await c.launchResult, raw);
    assert.deepEqual(c.read({ since: 0 }).lines.map(line => line.text), ["console complete"]);
    assert.deepEqual(await readdir(dir), [c.logFile.split("/").at(-1)]);
  });
}

test("a manually stopped console and a failed spawn settle missing owned results", { timeout: 15_000 }, async t => {
  const dir = await directory(t);
  const c = capture({
    logDir: dir, collectLaunchResult: true,
    args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)", "--", "--console"],
  });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  const { promise: ready, resolve } = Promise.withResolvers();
  c.onLine(line => { if (line.text === "ready") resolve(); });
  await c.start();
  await ready;
  c.stop(false);
  assert.equal(await c.waitForExit(5_000), true);
  assert.equal(await c.launchResult, undefined);
  assert.equal(c.naturalExitAt, undefined);
  assert.equal((await readdir(dir)).some(name => name.startsWith(".xcodebug-launch-")), false);

  const failed = capture({ logDir: dir, collectLaunchResult: true, command: join(dir, "missing-command"), args: ["--console"] });
  t.after(async () => { failed.stop(false); await failed.waitForExit(5_000); });
  await failed.start();
  assert.equal(await failed.waitForExit(5_000), true);
  assert.equal(await failed.launchResult, undefined);
  assert.match(failed.status().error, /ENOENT/);
  assert.equal((await readdir(dir)).some(name => name.startsWith(".xcodebug-launch-")), false);
});

for (const cancellation of ["stop", "caller abort"]) {
  test(`${cancellation} during owned result directory creation leaves no bridge or files`, { timeout: 10_000 }, async t => {
    const dir = await directory(t);
    const { promise: created, resolve: directoryCreated } = Promise.withResolvers();
    const { promise: released, resolve: release } = Promise.withResolvers();
    const original = fs.promises.mkdtemp;
    t.mock.method(fs.promises, "mkdtemp", async (...args) => {
      const path = await original(...args);
      directoryCreated(path);
      await released;
      return path;
    });
    syncBuiltinESMExports();
    t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
    const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", "setInterval(() => {}, 1000)", "--", "--console"] });
    t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
    const abort = new AbortController();
    const reason = new Error("cancelled owned launch startup");
    const starting = c.start(abort.signal);
    await created;
    if (cancellation === "stop") c.stop(false);
    else abort.abort(reason);
    release();
    if (cancellation === "stop") await starting;
    else await assert.rejects(starting, error => error === reason);
    assert.equal(await c.launchResult, undefined);
    assert.equal(c.running, false);
    assert.equal(c.pid, undefined);
    assert.deepEqual(await readdir(dir), []);
  });
}

for (const operation of ["mkdir", "mkdtemp", "writeFile"]) {
  test(`shutdown reports a pending ${operation} honestly and cleans startup after it resumes`, { timeout: 10_000 }, async t => {
    const dir = await directory(t);
    const { promise: entered, resolve: operationEntered } = Promise.withResolvers();
    const { promise: released, resolve: release } = Promise.withResolvers();
    const original = fs.promises[operation];
    t.mock.method(fs.promises, operation, async (...args) => {
      const result = await original(...args);
      operationEntered();
      await released;
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
    const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", "setInterval(() => {}, 1000)", "--", "--console"] });
    t.after(async () => { await c.shutdown(); });
    const starting = c.start();
    const result = c.launchResult;
    await entered;
    assert.equal(c.starting, true);
    assert.equal(c.running, false);
    let resultSettled = false;
    let cleanupSettled = false;
    void result.then(() => { resultSettled = true; });
    const cleanup = c.waitForLaunchResults().then(() => { cleanupSettled = true; });
    // The injected pending syscall has no OS handle; keep the loop live for the unref'ed deadline.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      assert.equal(await c.shutdown(20), false);
    } finally {
      clearInterval(keepAlive);
    }
    assert.match(c.status().error, /shutdown timed out.*resource cleanup remains pending/);
    assert.equal(c.starting, true);
    assert.equal(resultSettled, false, "an unresolved creation syscall still owns its result task");
    assert.equal(cleanupSettled, false);
    if (operation !== "mkdir") {
      assert.equal((await readdir(dir)).filter(name => name.startsWith(".xcodebug-launch-")).length, 1);
    }
    release();
    await starting;
    await cleanup;
    assert.equal(await result, undefined);
    assert.equal(c.starting, false);
    assert.equal(c.running, false);
    assert.equal(c.pid, undefined);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await c.shutdown(), true);
    c.resetForReconnect();
    await c.start();
    assert.equal(c.launchResult, result);
    assert.equal(c.running, false);
    assert.deepEqual(await readdir(dir), []);
  });
}

for (const partial of [false, true]) {
  test(`a ${partial ? "partial" : "failed"} owner marker write cancels launch and settles cleanup once`, { timeout: 10_000 }, async t => {
    const dir = await directory(t);
    const reason = new Error("owner marker write denied");
    const original = fs.promises.writeFile;
    t.mock.method(fs.promises, "writeFile", async (path, ...args) => {
      if (String(path).endsWith("/owner.json")) {
        if (partial) await original(path, ...args);
        throw reason;
      }
      return original(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", "setInterval(() => {}, 1000)", "--", "--console"] });
    t.after(async () => { await c.shutdown(); });
    const starting = c.start();
    const result = c.launchResult;
    let settlements = 0;
    void result.then(() => { settlements++; });
    await assert.rejects(starting, error => error === reason);
    await c.waitForLaunchResults();
    assert.equal(await result, undefined);
    assert.equal(c.starting, false);
    assert.equal(c.running, false);
    assert.equal(c.pid, undefined);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await c.shutdown(), true);
    assert.equal(settlements, 1);
    assert.equal(c.launchResult, result);
  });
}

test("reconnect owns a fresh result while the old bridge's result read is still pending", { timeout: 15_000 }, async t => {
  const dir = await directory(t);
  const { promise: reading, resolve: readStarted } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const original = fs.promises.readFile;
  const paths = [];
  t.mock.method(fs.promises, "readFile", async (path, ...args) => {
    if (String(path).startsWith(join(dir, ".xcodebug-launch-"))) {
      paths.push(String(path));
      if (paths.length === 1) { readStarted(); await released; }
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const counter = join(dir, "launch-count");
  const script = `
    const fs = require('node:fs');
    const args = process.argv.slice(1);
    const counter = args.at(-1);
    const run = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    fs.writeFileSync(counter, String(run));
    fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ run }));
    console.log('bridge ' + run);
  `;
  const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", script, "--", "--console", "--", counter] });
  t.after(async () => { c.stop(false); await c.waitForExit(5_000); });
  await c.start();
  const first = c.launchResult;
  await reading;
  assert.equal(await c.waitForExit(5_000), true);
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  c.resetForReconnect();
  await c.start();
  const second = c.launchResult;
  assert.notEqual(second, first);
  assert.equal(await c.waitForExit(5_000), true);
  assert.equal(await second, '{"run":2}');
  assert.equal(firstSettled, false, "reattaching must not settle or replace the old result");
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  release();
  assert.equal(await first, '{"run":1}');
  assert.equal((await readdir(dir)).some(name => name.startsWith(".xcodebug-launch-")), false);
  assert.deepEqual(c.read({ since: 0 }).lines.map(line => line.text), ["bridge 1", "bridge 2"]);
});

test("shutdown joins an old reconnect result and the new live bridge without releasing the old read", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const { reading, release } = holdLaunchResultRead(t, dir);
  const counter = join(dir, "launch-count");
  const script = `
    const fs = require('node:fs');
    const args = process.argv.slice(1);
    const counter = args.at(-1);
    const run = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    fs.writeFileSync(counter, String(run));
    fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ run }));
    console.log('bridge ' + run);
    if (run === 2) setInterval(() => {}, 1000);
  `;
  const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", script, "--", "--console", "--", counter] });
  t.after(async () => { await c.shutdown(); });
  const { promise: ready, resolve: bridgeReady } = Promise.withResolvers();
  c.onLine(line => { if (line.text === "bridge 2") bridgeReady(); });
  await c.start();
  const first = c.launchResult;
  const held = await reading;
  assert.equal(await c.waitForExit(5_000), true);
  c.resetForReconnect();
  await c.start();
  const second = c.launchResult;
  await ready;
  assert.notEqual(second, first);
  assert.equal(c.running, true);
  assert.equal((await readdir(dir)).filter(name => name.startsWith(".xcodebug-launch-")).length, 2);
  assert.equal(await c.shutdown(), true);
  assert.equal(held.signal.aborted, true);
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  await c.waitForLaunchResults();
  assert.equal(c.running, false);
  assert.equal(c.starting, false);
  assert.equal((await readdir(dir)).some(name => name.startsWith(".xcodebug-launch-")), false);
  const terminal = c.status();
  release();
  await delay(0);
  assert.deepEqual(c.status(), terminal);
  assert.equal(c.launchResult, second);
  assert.deepEqual(c.read({ since: 0 }).lines.map(line => line.text), ["bridge 1", "bridge 2"]);
});

for (const entry of ["extra file", "payload directory", "marker symlink"]) {
  test(`owned cleanup retains a result directory containing a ${entry}`, { timeout: 10_000 }, async t => {
    const dir = await directory(t);
    const foreign = join(dir, "foreign-content");
    const raw = '{"owned":true}';
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const args = process.argv.slice(1);
      const output = args[args.indexOf('--json-output') + 1];
      const directory = path.dirname(output);
      fs.writeFileSync(${JSON.stringify(foreign)}, 'keep foreign content');
      if (${entry === "payload directory"}) {
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, 'nested'), 'keep nested content');
      } else {
        fs.writeFileSync(output, ${JSON.stringify(raw)});
        if (${entry === "extra file"}) fs.writeFileSync(path.join(directory, 'foreign.txt'), 'keep extra content');
        if (${entry === "marker symlink"}) {
          fs.unlinkSync(path.join(directory, 'owner.json'));
          fs.symlinkSync(${JSON.stringify(foreign)}, path.join(directory, 'owner.json'));
        }
      }
      console.log('console complete');
    `;
    const c = capture({ logDir: dir, collectLaunchResult: true, args: ["-e", script, "--", "--console"] });
    t.after(async () => { await c.shutdown(); });
    await c.start();
    assert.equal(await c.waitForExit(5_000), true);
    assert.equal(await c.launchResult, entry === "payload directory" ? undefined : raw);
    await c.waitForLaunchResults();
    assert.match(c.status().error, /launch result cleanup failed/);
    const directories = (await readdir(dir)).filter(name => name.startsWith(".xcodebug-launch-"));
    assert.equal(directories.length, 1);
    const resultDir = join(dir, directories[0]);
    assert.equal(await fs.promises.readFile(foreign, "utf8"), "keep foreign content");
    if (entry === "extra file") assert.equal(await fs.promises.readFile(join(resultDir, "foreign.txt"), "utf8"), "keep extra content");
    if (entry === "payload directory") assert.equal(await fs.promises.readFile(join(resultDir, "launch.json", "nested"), "utf8"), "keep nested content");
    assert.equal((await fs.promises.lstat(join(resultDir, "owner.json"))).isSymbolicLink(), entry === "marker symlink");
    assert.equal(await c.shutdown(), true, "a reported cleanup failure settles the job rather than claiming deletion");
    assert.equal((await readdir(dir)).includes(directories[0]), true);
  });
}

test("file rotation keeps the newest three segments and continues past 150 MiB", { timeout: 60_000 }, async t => {
  const dir = await directory(t);
  const rows = 170_000;
  const c = capture({ logDir: dir, args: ["-e", producer, String(rows), "1000"] });
  t.after(() => c.stop(false));
  await c.start();
  assert.equal(await c.waitForExit(50_000), true);
  const files = c.status().logFiles;
  assert.equal(files.length, 3);
  assert.equal((await readdir(dir)).length, 3);
  let first;
  let previous;
  for (const file of files) {
    assert.ok((await stat(file)).size <= 50 * 1024 * 1024);
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const index = Number(line.split(" ", 3)[1]);
      first ??= index;
      if (previous !== undefined) assert.equal(index, previous + 1);
      previous = index;
    }
  }
  assert.ok(first > 0, "the oldest segment should have been replaced");
  assert.equal(previous, rows - 1, "the newest log must still reach disk after the old 50 MiB cutoff");
  assert.equal(c.status().cursor, rows);
  // Row i is line i + 1. The first rows went with the overwritten segment.
  const oldest = await c.search({ grep: new RegExp(`^${first} `) });
  assert.deepEqual(oldest.lines.map(line => line.index), [first + 1]);
  const overwritten = await c.search({ grep: /^0 / });
  assert.deepEqual(overwritten.lines, []);
  assert.equal(overwritten.missing, first, "rows no file holds any more must be counted, not passed over");
});

test("a search reads back the lines the buffer dropped, under their own indices", { timeout: 30_000 }, async t => {
  const dir = await directory(t);
  const c = capture({ logDir: dir, args: ["-e", producer, "25000", "10"] });
  t.after(() => c.stop(false));
  c.pushLine("out", "said before any file existed");
  await c.start();
  assert.equal(await c.waitForExit(20_000), true);
  assert.equal(c.read({ grep: /^0 / }).lines.length, 0, "the buffer no longer holds the first rows");
  assert.equal(c.read({}).evicted, 5_001);
  assert.equal(c.read({ since: 5_001 }).evicted, 0);

  const early = await c.search({ grep: /^0 / });
  assert.deepEqual(early.lines.map(line => [line.index, line.text]), [[2, "0 xxxxxxxxxx"]]);
  assert.ok(Math.abs(early.lines[0].at - c.status().startedAt) < 20_000);
  assert.deepEqual([early.total, early.evicted, early.missing], [1, 5_001, 1]);
  assert.deepEqual((await c.search({ since: 2, grep: /^0 / })).lines, [], "a line at or before `since` is not asked for");
  const neverWritten = await c.search({ grep: "before any file" });
  assert.deepEqual([neverWritten.lines.length, neverWritten.missing], [0, 1]);
  // One row from disk and two from the buffer, in order.
  const both = await c.search({ grep: "4999 x" });
  assert.deepEqual(both.lines.map(line => line.index), [5_001, 15_001, 25_001]);
  assert.equal(both.total, 3);
  assert.deepEqual((await c.search({ grep: "4999 x", limit: 2 })).lines.map(line => line.index), [15_001, 25_001]);
  assert.equal((await c.search({ grep: "x", limit: 3 })).total, 25_000, "matches beyond the limit are still counted");

  // What is said while the bridge is down is written too, and a reattach keeps the numbering.
  c.pushLine("err", "[test] bridge down");
  c.resetForReconnect();
  await c.start();
  assert.equal(await c.waitForExit(20_000), true);
  c.pushLine("err", "[test] ended for good");
  assert.deepEqual((await c.search({ grep: "[test] bridge down" })).lines.map(line => line.index), [25_002]);
  assert.deepEqual((await c.search({ grep: /^0 / })).lines.map(line => line.index), [2, 25_003]);
  const handle = await open(c.logFile);
  const text = await handle.readFile("utf8");
  await handle.close();
  assert.equal(text.trim().split("\n").length, 50_002);
  assert.match(text, / \[test\] ended for good\n$/);
});

test("a rotation to a new segment does not invalidate a disk search snapshot", { timeout: 60_000 }, async t => {
  const dir = await directory(t);
  const c = capture({ logDir: dir, args: ["-e", "setInterval(() => {}, 1000)"] });
  t.after(() => c.stop(false));
  await c.start();
  c.pushLine("out", "MARKER");
  for (let i = 0; i < 20_000; i++) c.pushLine("out", `filler ${i}`);
  // On disk before the search starts, so what follows is about the rotation alone.
  for (;;) {
    const settled = await c.search({ grep: "filler 19998" });
    if (settled.lines.length === 1 && settled.missing === 0) break;
    await delay(20);
  }
  const searching = c.search({ grep: "MARKER" });
  // More than one segment's worth, pushed before the search has read anything.
  const megabyte = "y".repeat(1024 * 1024);
  for (let i = 0; i < 51; i++) c.pushLine("out", megabyte);
  const found = await searching;
  assert.deepEqual(found.lines.map(line => [line.index, line.text]), [[1, "MARKER"]]);
  assert.equal(found.cursor, 20_001, "creating a new segment must preserve the original search snapshot");
});

test("overwriting a snapshot segment retries the disk search with current indices", { timeout: 30_000 }, async t => {
  const dir = await directory(t);
  const c = await idleCapture(t, dir);
  c.pushLine("out", "MARKER");
  for (let i = 0; i < 20_000; i++) c.pushLine("out", `filler ${i}`);
  assert.equal((await c.search({ grep: "MARKER" })).missing, 0);
  const original = fs.createReadStream;
  let rotate = true;
  t.mock.method(fs, "createReadStream", (...args) => {
    if (rotate) {
      rotate = false;
      // Boundary accounting is covered by the large-file test. Force each next
      // line over that boundary here so a three-segment overwrite stays small.
      for (let i = 0; i < 3; i++) {
        c.fileBytes = 50 * 1024 * 1024;
        c.pushLine("out", `rotated ${i}`);
      }
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const found = await c.search({ grep: "MARKER" });
  assert.deepEqual(found.lines, []);
  assert.deepEqual([found.cursor, found.total, found.evicted, found.missing], [20_004, 0, 4, 4]);
});

test("a blocked log sink pauses the producer and drains without losing the final lines", { timeout: 30_000 }, async t => {
  const dir = await directory(t);
  const fifo = join(dir, "slow.log");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const rows = 10_000;
  const c = capture({ logDir: dir, logFile: fifo, args: ["-e", producer, String(rows), "1000", "producer finished"] });
  t.after(() => c.stop(false));
  let producerFinished;
  const producerDone = new Promise(resolve => { producerFinished = resolve; });
  let firstLine;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("producer did not start")), 15_000);
    firstLine = () => { clearTimeout(timeout); resolve(); };
    t.after(() => clearTimeout(timeout));
  });
  const unsubscribe = c.onLine(line => {
    firstLine();
    if (line.text === "producer finished") producerFinished();
  });
  t.after(unsubscribe);
  await c.start();
  await ready;
  await Promise.race([producerDone, delay(3_000)]);
  const beforeDrain = c.status().cursor;
  let last = "";
  let sawFinalRow = false;
  let count = 0;
  const drained = (async () => {
    const reader = createInterface({ input: createReadStream(fifo), crlfDelay: Infinity });
    for await (const line of reader) { last = line; count++; if (/ 9999 x+$/.test(line)) sawFinalRow = true; }
  })();
  assert.equal(await c.waitForExit(20_000), true);
  await drained;
  assert.ok(beforeDrain < rows, "capture must apply backpressure before the producer finishes");
  assert.equal(count, rows + 1);
  assert.equal(sawFinalRow, true);
  assert.match(last, / producer finished$/);
});

test("reattaching appends to the current segment and retains cursor ordering", { timeout: 30_000 }, async t => {
  const dir = await directory(t);
  const c = capture({ logDir: dir, args: ["-e", producer, "20", "10"] });
  t.after(() => c.stop(false));
  await c.start();
  assert.equal(await c.waitForExit(12_000), true);
  c.resetForReconnect();
  await c.start();
  assert.equal(await c.waitForExit(12_000), true);
  const handle = await open(c.logFile);
  const text = await handle.readFile("utf8");
  await handle.close();
  assert.equal(text.trim().split("\n").length, 40);
  assert.equal(c.read({ since: 20 }).total, 20);
  assert.equal(c.status().cursor, 40);
});

test("fractional limits return integer tails across every read branch", () => {
  const c = capture();
  for (let i = 1; i <= 6; i++) c.pushLine(i % 2 ? "out" : "err", `line ${i}`);
  for (const [filter, indices] of [
    [{}, [1, 2, 3, 4, 5, 6]],
    [{ grep: "line" }, [1, 2, 3, 4, 5, 6]],
    [{ streams: ["err"] }, [2, 4, 6]],
    [{ streams: ["out"], grep: "line" }, [1, 3, 5]],
  ]) {
    for (const [limit, count] of [[0.5, 1], [1, 1], [1.5, 1], [2, 2], [2.9, 2]]) {
      const result = c.read({ ...filter, limit });
      assert.deepEqual(result.lines.map(line => line.index), indices.slice(-count));
      assert.equal(result.total, indices.length);
      assert.equal(result.cursor, 6);
    }
  }
});

test("an existing directory is not reported as a successfully opened log file", { timeout: 10_000 }, async t => {
  const dir = await directory(t);
  const c = capture({ logDir: dir, logFile: dir, command: "/bin/echo", args: ["ready"] });
  t.after(() => c.stop(false));
  await c.start();
  assert.equal(await c.waitForExit(5_000), true);
  assert.match(c.status().error, /EISDIR/);
  assert.deepEqual(c.status().logFiles, []);
  assert.deepEqual(c.read({}).lines.map(line => line.text), ["ready"]);

  const file = join(dir, "success.log");
  const successful = capture({ logDir: dir, logFile: file, command: "/bin/echo", args: ["ready"] });
  t.after(() => successful.stop(false));
  await successful.start();
  assert.equal(await successful.waitForExit(5_000), true);
  assert.deepEqual(successful.status().logFiles, [file]);
  assert.ok((await stat(file)).size > 0);
});

for (const scenario of ["explicit stop with paused pipes", "natural exit with paused pipes", "natural close with pending writer"]) {
  test(`drain deadline bounds ${scenario} and preserves stop intent`, { timeout: 40_000 }, async t => {
    const dir = await directory(t);
    let releaseWrite;
    let sinkReady;
    const ready = new Promise(resolve => { sinkReady = resolve; });
    // Hold a real Writable's callback indefinitely, without occupying an fs worker.
    // A small write lets child close fire; large rows also leave stdout paused.
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        releaseWrite = () => {
          releaseWrite = undefined;
          callback();
        };
        sinkReady();
      },
    });
    const original = fs.createWriteStream;
    let opens = 0;
    t.mock.method(fs, "createWriteStream", (...args) => ++opens === 1 ? sink : original(...args));
    syncBuiltinESMExports();
    t.after(() => {
      sink.destroy();
      releaseWrite?.();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const marker = join(dir, "started");
    const script = `
      const fs = require('node:fs');
      if (fs.existsSync(process.argv[1])) {
        console.log('reconnected');
        setTimeout(() => process.exit(0), 700);
      } else {
        fs.writeFileSync(process.argv[1], 'started');
        if (process.argv[2] === 'natural close with pending writer') {
          console.log('ready');
        } else {
          for (let i = 0; i < 10000; i++) process.stdout.write(i + ' ' + 'x'.repeat(4096) + '\\n');
          ${scenario === "explicit stop with paused pipes" ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 300);"}
        }
      }
    `;
    const c = capture({ logDir: dir, args: ["-e", script, marker, scenario] });
    t.after(() => c.stop(false));
    let exits = 0;
    const unsubscribe = c.onExit(() => { exits++; });
    t.after(unsubscribe);
    await c.start();
    assert.equal(await Promise.race([ready.then(() => true), delay(12_000, false)]), true);
    if (!scenario.includes("pending writer")) {
      await delay(100);
      assert.ok(c.status().cursor < 10_000, "the blocked sink must pause capture before all producer rows arrive");
    }
    const started = Date.now();
    if (scenario.startsWith("explicit")) c.stop(false);
    assert.equal(await c.waitForExit(3_900), true, "blocked output must not prevent exit notification");
    assert.ok(Date.now() - started < 4_000);
    assert.equal(c.running, false);
    assert.equal(exits, 1);
    assert.match(c.status().error, /drain.*(timed? out|timeout|truncat)/i);
    if (scenario.startsWith("explicit")) {
      c.resetForReconnect();
      await c.start();
      assert.equal(c.running, false, "explicit stop must prevent even a queued reconnect");
      assert.equal(exits, 1);
      return;
    }

    c.resetForReconnect();
    let reconnected;
    const reconnectReady = new Promise(resolve => { reconnected = resolve; });
    const unsubscribeLine = c.onLine(line => { if (line.text === "reconnected") reconnected(); });
    t.after(unsubscribeLine);
    await c.start();
    assert.equal(await Promise.race([reconnectReady.then(() => true), delay(12_000, false)]), true);
    releaseWrite?.();
    await delay(100);
    assert.equal(c.running, true, "late completion of the old writer must not finish the new bridge");
    assert.equal(exits, 1);
    assert.equal(c.status().error, undefined);
    assert.equal(await c.waitForExit(3_000), true);
    assert.equal(exits, 2);
    assert.equal(c.running, false);
  });
}
