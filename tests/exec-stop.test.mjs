import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand, withCommandSignal } from "../exec.ts";

const CHILD = `const fs = require("node:fs");
process.on("SIGINT", () => { fs.writeFileSync(process.argv[2], "interrupted"); process.exit(0); });
fs.writeFileSync(process.argv[1], String(process.pid));
setInterval(() => {}, 1000);`;

async function started(path) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const pid = await readFile(path, "utf8").then(Number, error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (pid) return pid;
    await delay(20);
  }
  assert.fail(`command did not start: ${path}`);
}

test("runCommand rejects a timeout beyond the Node timer limit before spawning", () => {
  assert.throws(() => runCommand("not-started", [], { timeoutMs: 2_147_483_648 }),
    /timeoutMs must be finite and no greater than 2147483647/);
});

test("runCommand accepts the maximum Node timer value for a short command", { timeout: 5_000 }, async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('done')"], { timeoutMs: 2_147_483_647 });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "done");
});

test("action cancellation reaches nested commands without stopping another action", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-command-stop-"));
  const first = new AbortController();
  const second = new AbortController();
  const explicit = new AbortController();
  const commands = [];
  t.after(async () => {
    first.abort();
    second.abort();
    await Promise.allSettled(commands);
    await rm(root, { recursive: true, force: true });
  });
  const firstPid = join(root, "first.pid");
  const secondPid = join(root, "second.pid");
  const interrupted = join(root, "first.interrupted");
  commands.push(withCommandSignal(first.signal, () => runCommand(process.execPath,
    ["-e", CHILD, firstPid, interrupted], { signal: explicit.signal, timeoutMs: 10_000 })));
  commands.push(withCommandSignal(second.signal, () => runCommand(process.execPath,
    ["-e", CHILD, secondPid, join(root, "second.interrupted")], { timeoutMs: 10_000 })));
  const [a, b] = await Promise.all([started(firstPid), started(secondPid)]);
  first.abort();
  await commands[0];
  assert.equal(await readFile(interrupted, "utf8"), "interrupted", "the command must get a chance to cancel its own work");
  assert.throws(() => process.kill(a, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(b, 0), "another action must remain alive");
});

test("an already stopped action cannot start another subprocess", async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-pre-aborted-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = new Error("stop requested");
  controller.abort(reason);
  const marker = join(root, "started.pid");
  assert.throws(() => withCommandSignal(controller.signal, () => runCommand(process.execPath,
    ["-e", CHILD, marker, join(root, "interrupted")], { timeoutMs: 10_000 })), error => error === reason);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("cancellation forces down an owned command that ignores SIGINT", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-forced-command-stop-"));
  const controller = new AbortController();
  const marker = join(root, "started.pid");
  const source = 'process.on("SIGINT", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  const running = withCommandSignal(controller.signal, () => runCommand(process.execPath,
    ["-e", source, marker], { timeoutMs: 10_000 }));
  t.after(async () => {
    controller.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  });
  const pid = await started(marker);
  controller.abort();
  const result = await running;
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("cancellation removes an ignored-SIGINT descendant after its parent exits", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-descendant-stop-"));
  const marker = join(root, "descendant.pid");
  const descendant = 'process.on("SIGINT", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  const parent = `process.on("SIGINT", () => process.exit(0)); require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], {stdio: "ignore"}); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const running = runCommand(process.execPath, ["-e", parent, marker], { signal: controller.signal, timeoutMs: 10_000 });
  let pid;
  t.after(async () => {
    controller.abort();
    await running;
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  pid = await started(marker);
  controller.abort();
  const result = await running;
  assert.equal(result.timedOut, false);
  const deadline = Date.now() + 3_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    if (alive) await delay(20);
  }
  assert.equal(alive, false, "parent completion must not leave its owned background command alive");
});
