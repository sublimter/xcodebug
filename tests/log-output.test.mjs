import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Capture } from "../capture.ts";
import { formatLogLines, formatEvidenceLines, MAX_REPLY_BYTES } from "../log-output.ts";

const capture = () => new Capture({ mode: "syslog", deviceId: "d", deviceLabel: "Test", bundleId: "test.app", command: "unused", args: [], logDir: tmpdir() });

test("log output bounds UTF-8 bytes and explicitly identifies truncated evidence", async () => {
  const c = capture();
  for (let i = 0; i < 200; i++) c.pushLine("out", `marker ${i} ` + "汉😀".repeat(5000));
  const result = await formatLogLines(c, { since: 0, limit: 200 });
  assert.ok(Buffer.byteLength(result.text) <= MAX_REPLY_BYTES, Buffer.byteLength(result.text));
  assert.match(result.text, /truncated/);
  assert.match(result.text, /log: /);
  assert.equal(result.cursor, 200);
  assert.doesNotMatch(result.text, /�/);
});

test("context includes neighboring lines once, without relabeling them as matches", async () => {
  const c = capture();
  ["before", "TARGET one", "middle", "TARGET two", "after", "unrelated"].forEach(s => c.pushLine("out", s));
  const result = await formatLogLines(c, { since: 0, limit: 20, grep: "TARGET", context: 1 });
  assert.equal(result.total, 2);
  for (const text of ["before", "middle", "after"]) assert.match(result.text, new RegExp(text));
  assert.doesNotMatch(result.text, /unrelated/);
  assert.equal((result.text.match(/middle/g) ?? []).length, 1);
  assert.match(result.text, /2 match/);
});

test("context reads old neighboring lines from disk and preserves captured indices", async t => {
  const dir = await mkdtemp(join(tmpdir(), "xcodebug-context-"));
  const c = new Capture({ mode: "syslog", deviceId: "d", deviceLabel: "Test", bundleId: "test.app", command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], logDir: dir });
  t.after(async () => { c.stop(false); await c.waitForExit(3000); await rm(dir, { recursive: true, force: true }); });
  await c.start();
  ["neighbor left", "TARGET", "neighbor right"].forEach(s => c.pushLine("out", s));
  for (let i = 0; i < 21000; i++) c.pushLine("out", `filler ${i}`);
  const result = await formatLogLines(c, { since: 0, limit: 2, grep: "TARGET", context: 1 });
  assert.match(result.text, /1 neighbor left/);
  assert.match(result.text, /2 TARGET/);
  assert.match(result.text, /3 neighbor right/);
  assert.equal(result.total, 1);
});

test("wait evidence shares the byte budget", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ index: i + 1, at: Date.now(), text: "Ω".repeat(10000) }));
  const result = formatEvidenceLines(rows);
  assert.ok(Buffer.byteLength(result.text) < MAX_REPLY_BYTES);
  assert.ok(result.truncated);
  assert.ok(result.text.includes("   300 "));
  assert.ok(!result.text.includes("     1 "));
});

test("the byte budget includes the header, paths and notes, with an accurate chronological tail", async () => {
  const path = "/" + "字".repeat(20_000) + "/capture.log";
  const c = new Capture({ mode: "console", deviceId: "d", deviceLabel: "test", bundleId: "app", command: "unused", args: [], logFile: path });
  for (let i = 1; i <= 100; i++) c.pushLine("out", `row ${i} ` + "界".repeat(30_000));
  const reply = await formatLogLines(c, { since: 0, limit: 80, times: true });
  assert.ok(Buffer.byteLength(reply.text) <= MAX_REPLY_BYTES);
  const rows = [...reply.text.matchAll(/^\s*(\d+) \d\d:\d\d:\d\d\.\d{3} \[devicectl\] row (\d+)/gm)];
  assert.ok(rows.length > 0);
  assert.deepEqual(rows.map(m => Number(m[1])), Array.from({ length: rows.length }, (_, i) => 101 - rows.length + i));
  assert.ok(reply.text.startsWith(`${rows.length} line(s) (${100 - rows.length} older omitted)`));
  assert.ok(reply.text.includes("capture.log"));
  assert.ok(!reply.text.includes("\uFFFD"));
});

test("a long unsuccessful pattern leaves room for the cursor and the missing evidence note", async () => {
  const c = capture();
  c.pushLine("out", "q".repeat(3 * 1024 * 1024));
  const result = await formatLogLines(c, { since: 0, limit: 10, grep: new RegExp("界".repeat(20_000)) });
  assert.ok(Buffer.byteLength(result.text) <= MAX_REPLY_BYTES);
  assert.ok(result.text.includes("capture cursor is 1"));
  assert.ok(result.text.includes("1 line(s) are in neither memory nor the log files"));
  const memory = await formatLogLines(c, { since: 0, limit: 10 });
  assert.equal(memory.total, 1);
  assert.ok(memory.text.includes("memory"));
  assert.ok(!memory.text.includes("no new lines since"));
});

test("context clamps the radius, respects the exclusive since and pins the last eligible line", async t => {
  const c = capture();
  for (let i = 1; i <= 100; i++) c.pushLine("out", i === 55 ? "TARGET" : `context-${i}!`);
  const search = c.search.bind(c);
  let first = true;
  t.mock.method(c, "search", async options => {
    const result = await search(options);
    if (first) { first = false; c.pushLine("out", "after snapshot"); }
    return result;
  });
  const result = await formatLogLines(c, { since: 50, limit: 2, grep: "TARGET", context: 1e9 });
  assert.equal(result.cursor, 100);
  assert.ok(result.text.includes("context-54!"));
  assert.ok(result.text.includes("context-56!"));
  assert.ok(!result.text.includes("context-50!"));
  assert.ok(!result.text.includes("context-76!"));
  assert.ok(!result.text.includes("after snapshot"));
});
test("context output keeps the matching line when later context exceeds the byte budget", async () => {
  const c = capture();
  c.pushLine("out", "TARGET");
  for (let i = 0; i < 30; i++) c.pushLine("out", "context " + i + " " + "x".repeat(5000));
  const result = await formatLogLines(c, { since: 0, limit: 1, grep: "TARGET", context: 20 });
  assert.match(result.text, /1 TARGET/);
});

test("only missing neighbors in the requested windows count as unavailable context", async () => {
  const c = capture();
  const huge = "q".repeat(3 * 1024 * 1024);
  for (const text of ["TARGET 1", huge, "unrelated", huge, "unrelated", "left", "TARGET 2", "right"]) c.pushLine("out", text);
  const result = await formatLogLines(c, { since: 0, limit: 10, grep: "TARGET", context: 1 });
  assert.match(result.text, /2 match\(es\) · 4 line\(s\) with context/);
  assert.match(result.text, /1 context line\(s\) unavailable/);
  assert.doesNotMatch(result.text, /unrelated/);
});

test("sparse old context windows share one disk recovery pass", async t => {
  const dir = await mkdtemp(join(tmpdir(), "xcodebug-sparse-context-"));
  const c = new Capture({ mode: "syslog", deviceId: "d", deviceLabel: "Test", bundleId: "app", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], logDir: dir });
  t.after(async () => { c.stop(false); await c.waitForExit(3000); await rm(dir, { recursive: true, force: true }); });
  await c.start();
  for (let i = 0; i < 20; i++) {
    for (const text of [`TARGET ${i}`, `right ${i}`, "outside", `left ${i + 1}`]) c.pushLine("out", text);
  }
  for (let i = 0; i < 20_100; i++) c.pushLine("out", `filler ${i}`);
  const open = t.mock.method(fs, "createReadStream");
  syncBuiltinESMExports();
  t.after(() => { open.mock.restore(); syncBuiltinESMExports(); });
  const result = await formatLogLines(c, { since: 0, limit: 20, grep: "TARGET", context: 1 });
  assert.match(result.text, /20 match\(es\) · 59 line\(s\) with context/);
  assert.match(result.text, /78 right 19/);
  assert.doesNotMatch(result.text, /outside|filler/);
  assert.ok(open.mock.callCount() <= 2, `${open.mock.callCount()} disk passes for one segment`);
});
