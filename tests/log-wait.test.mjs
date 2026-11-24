import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Capture } from "../capture.ts";
import { MAX_REPLY_BYTES } from "../log-output.ts";
import { waitForEvidence } from "../log-wait.ts";

async function bridge(t, script = "setInterval(() => {}, 1000)") {
  const dir = await mkdtemp(join(tmpdir(), "xcodebug-wait-"));
  const capture = new Capture({ mode: "syslog", deviceId: "d", deviceLabel: "test", bundleId: "app", logDir: dir, command: process.execPath, args: ["-e", script] });
  t.after(async () => { capture.stop(false); await capture.waitForExit(3000); await rm(dir, { recursive: true, force: true }); });
  await capture.start();
  return capture;
}

function wait(capture, options = {}) {
  return waitForEvidence(capture, { since: 0, match: "MATCH", timeoutMs: 1000, ...options });
}

function holdSearch(t, capture) {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const search = capture.search.bind(capture);
  t.mock.method(capture, "search", async options => {
    entered.resolve(options);
    await gate.promise;
    return search(options);
  });
  t.after(gate.resolve);
  return { entered: entered.promise, release: gate.resolve };
}

test("historical and live matches form disjoint intervals even when a delayed scan takes a later snapshot", async t => {
  const c = await bridge(t);
  for (let i = 1; i <= 600; i++) c.pushLine("out", `MATCH old ${i}`);
  const gate = holdSearch(t, c);
  const waiting = wait(c, { since: 100, timeoutMs: 5000 });
  const scan = await gate.entered;
  for (let i = 1; i <= 10_100; i++) c.pushLine("out", `MATCH new ${i}`);
  gate.release();
  const result = await waiting;
  assert.equal(scan.until, 600);
  assert.equal(result.matched, 10_600);
  assert.equal(result.cursor, 10_700);
  assert.equal(result.isError, false);
  assert.equal(result.missing, 0);
  assert.match(result.text, /10700 MATCH new 10100/);
  assert.doesNotMatch(result.text, /MATCH old |MATCH new 1\n/);
  assert.match(result.text, /truncated/);
  assert.match(result.text, /predates this wait/);
});

test("live delivery honors an explicit future cursor and counts only matching output", async t => {
  const c = await bridge(t);
  const waiting = wait(c, { since: 2, match: /^MATCH /, times: true });
  for (const text of ["MATCH before", "MATCH boundary", "unrelated", "MATCH one", "unrelated", "MATCH two"]) c.pushLine("out", text);
  const result = await waiting;
  assert.equal(result.matched, 2);
  assert.equal(result.cursor, 6);
  assert.match(result.text, /\n +4 \d\d:\d\d:\d\d\.\d{3} MATCH one/);
  assert.match(result.text, /MATCH two/);
  assert.doesNotMatch(result.text, /unrelated|MATCH before|MATCH boundary|predates/);
});

test("the same literal substring is required in the backlog and live output", async t => {
  const c = await bridge(t);
  c.pushLine("out", "MATCH without leading space");
  const waiting = wait(c, { match: " MATCH " });
  c.pushLine("out", "prefix MATCH suffix");
  c.pushLine("out", "MATCH without leading space again");
  const result = await waiting;
  assert.equal(result.matched, 1);
  assert.match(result.text, /2 prefix MATCH suffix/);
  assert.doesNotMatch(result.text, /without leading space|predates/);
});

test("an absence check starting at a future cursor has not covered the full interval", async t => {
  const c = await bridge(t);
  const result = await wait(c, { since: 1, absent: true, timeoutMs: 20 });
  assert.equal(result.isError, true);
  assert.equal(result.cursor, 0);
  assert.match(result.text, /inconclusive/);
});

for (const absent of [false, true]) {
  test(`a stalled ${absent ? "absence" : "positive"} backlog scan respects the deadline and reports unchecked lines`, async t => {
    const c = await bridge(t);
    c.pushLine("out", "old");
    const gate = holdSearch(t, c);
    const waiting = wait(c, { absent, timeoutMs: 25 });
    const scan = await gate.entered;
    const first = await Promise.race([waiting, delay(250, undefined)]);
    gate.release();
    const result = await waiting;
    assert.ok(first, "deadline must settle independently of the writer or reader");
    assert.equal(scan.signal.aborted, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.isError, true);
    assert.equal(result.missing, 1);
    assert.match(result.text, /backlog.*(incomplete|not searched|unchecked)|not fully searched/i);
    if (absent) assert.match(result.text, /inconclusive/);
  });
}

test("a live forbidden match settles during a stalled backlog scan", async t => {
  const c = await bridge(t);
  c.pushLine("out", "old");
  const gate = holdSearch(t, c);
  const waiting = wait(c, { absent: true });
  const scan = await gate.entered;
  c.pushLine("out", "MATCH forbidden");
  const first = await Promise.race([waiting, delay(200, undefined)]);
  gate.release();
  const result = await waiting;
  assert.ok(first);
  assert.equal(scan.signal.aborted, true);
  assert.equal(result.isError, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.matched, 1);
  assert.match(result.text, /forbidden pattern appeared/);
  assert.match(result.text, /2 MATCH forbidden/);
});

test("caller cancellation wins over a buffered match and detaches from a blocked scan", async t => {
  const c = await bridge(t);
  c.pushLine("out", "old");
  const gate = holdSearch(t, c);
  const caller = new AbortController();
  const waiting = wait(c, { signal: caller.signal });
  const scan = await gate.entered;
  c.pushLine("out", "MATCH during scan");
  caller.abort();
  const first = await Promise.race([waiting, delay(200, undefined)]);
  gate.release();
  const result = await waiting;
  assert.ok(first);
  assert.equal(scan.signal.aborted, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.isError, true);
  assert.equal(result.timedOut, false);
  assert.match(result.text, /cancelled while waiting/);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  const already = await wait(c, { signal: AbortSignal.abort() });
  assert.equal(already.cancelled, true);
});

test("unexpected scan failures release every listener and preserve the scan error", async t => {
  const c = await bridge(t);
  c.pushLine("out", "old");
  let subscriptions = 0;
  for (const event of ["onLine", "onExit", "onProcessExit"]) {
    const subscribe = c[event].bind(c);
    t.mock.method(c, event, callback => {
      subscriptions++;
      const off = subscribe(callback);
      return () => { subscriptions--; off(); };
    });
  }
  const caller = new AbortController();
  const before = getEventListeners(c.signal, "abort").length;
  const error = new Error("scan failed");
  t.mock.method(c, "search", async () => { throw error; });
  await assert.rejects(wait(c, { absent: true, signal: caller.signal }), e => e === error);
  assert.equal(subscriptions, 0);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(getEventListeners(c.signal, "abort").length, before);
});

test("a syslog disconnect stays visible after reattachment, and a new interval can succeed", async t => {
  const c = await bridge(t);
  c.pushLine("out", "before gap");
  const gate = holdSearch(t, c);
  const waiting = wait(c, { absent: true, timeoutMs: 300 });
  await gate.entered;
  c.restartBridge();
  assert.equal(await c.waitForExit(3000), true);
  c.resetForReconnect();
  await c.start();
  const boundary = c.status().cursor;
  c.pushLine("out", "after gap");
  gate.release();
  const interrupted = await waiting;
  assert.equal(interrupted.isError, true);
  assert.match(interrupted.text, /inconclusive/);
  const historical = await wait(c, { since: 0, absent: true, timeoutMs: 20 });
  assert.equal(historical.isError, true);
  assert.match(historical.text, /inconclusive/);
  const fresh = await wait(c, { since: boundary, absent: true, timeoutMs: 20 });
  assert.equal(fresh.isError, false);
  assert.match(fresh.text, /no matching line observed/);
});

test("a positive wait reads the final matching output while an exited bridge is draining", async t => {
  const c = await bridge(t, `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => console.log("MATCH final"), 150)'], {stdio: ['ignore', 1, 2]}).unref()`);
  await new Promise(resolve => { if (c.processExited) resolve(); else c.onProcessExit(resolve); });
  const result = await wait(c);
  assert.equal(result.isError, false);
  assert.match(result.text, /1 MATCH final/);
});

test("an ended capture can confirm a historical match, and stop cuts a live absence interval short", async t => {
  const c = await bridge(t);
  const waiting = wait(c, { match: "missing", absent: true, timeoutMs: 500 });
  c.pushLine("err", "MATCH historical");
  c.stop(false);
  const stopped = await waiting;
  assert.equal(stopped.isError, true);
  assert.equal(stopped.timedOut, false);
  assert.match(stopped.text, /inconclusive/);
  assert.equal(await c.waitForExit(3000), true);
  const forbidden = await wait(c, { absent: true });
  assert.equal(forbidden.matched, 1);
  assert.match(forbidden.text, /forbidden pattern appeared/);
  const ended = await wait(c, { since: 1 });
  assert.equal(ended.ended, true);
  assert.match(ended.text, /capture ended before/);
  const long = await wait(c, { match: "字".repeat(20_000), since: 1 });
  assert.ok(Buffer.byteLength(long.text) <= MAX_REPLY_BYTES);
  assert.ok(long.text.includes("(cursor 1)"));
});
