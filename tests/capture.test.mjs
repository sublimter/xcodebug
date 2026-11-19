import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Writable } from "node:stream";
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

test("a search that a rotation overtakes reads again", { timeout: 60_000 }, async t => {
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
  assert.equal(found.cursor, 20_052, "the answer is from a read that began after the rotation");
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
  test(`drain deadline bounds ${scenario} and permits reconnect`, { timeout: 40_000 }, async t => {
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
