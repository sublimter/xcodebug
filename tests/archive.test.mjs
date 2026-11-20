import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneLogs } from "../archive.ts";

const NOW = Date.UTC(2026, 10, 20);
const AGE = 24 * 60 * 60 * 1_000;
const OLD = NOW - 2 * AGE;
const DEAD_PID = process.pid + 10_000;

async function fixture(t, kill = () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); }) {
  const dir = await mkdtemp(join(tmpdir(), "xcodebug-archive-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(signal, 0);
    return kill(pid);
  });
  return dir;
}

async function age(path, at = OLD) {
  await utimes(path, at / 1_000, at / 1_000);
}

async function owned(dir, name, { marker = {}, payload = true } = {}) {
  const path = join(dir, `.xcodebug-launch-${name}`);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "owner.json"), JSON.stringify({
    kind: "xcodebug.launch-result", version: 1, pid: DEAD_PID, createdAt: OLD, ...marker,
  }), { mode: 0o600 });
  if (payload) await writeFile(join(path, "launch.json"), '{"result":"raw"}', { mode: 0o600 });
  await ageContents(path);
  return path;
}

async function ageContents(path) {
  for (const name of await readdir(path)) {
    if (!(await lstat(join(path, name))).isSymbolicLink()) await age(join(path, name));
  }
  await age(path);
}

function mockFilesystem(t, method, implementation) {
  t.mock.method(fs.promises, method, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("pruning reclaims only stale dead-owner result directories, including marker-only startup leftovers", async t => {
  const dir = await fixture(t, pid => {
    assert.equal(pid, DEAD_PID);
    throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
  await owned(dir, "complete");
  await owned(dir, "startup", { payload: false });
  await pruneLogs(dir, AGE);
  assert.deepEqual(await readdir(dir), []);
});

test("fresh marker, directory or either known file preserves the entire result directory", async t => {
  const dir = await fixture(t);
  const paths = [];
  paths.push(await owned(dir, "marker-created", { marker: { createdAt: NOW } }));
  for (const name of ["directory", "owner.json", "launch.json"]) {
    const path = await owned(dir, name.replace(".", "-"));
    await age(name === "directory" ? path : join(path, name), NOW);
    paths.push(path);
  }
  await pruneLogs(dir, AGE);
  for (const path of paths) assert.deepEqual((await readdir(path)).sort(), ["launch.json", "owner.json"]);
});

test("active PID, EPERM and uncertain owner errors are never reclaimed", async t => {
  const dir = await fixture(t, pid => {
    if (pid === process.pid) return true;
    const code = pid === DEAD_PID ? "EPERM" : "EINVAL";
    throw Object.assign(new Error("uncertain"), { code });
  });
  const paths = [
    await owned(dir, "active", { marker: { pid: process.pid } }),
    await owned(dir, "permission"),
    await owned(dir, "uncertain", { marker: { pid: DEAD_PID + 1 } }),
  ];
  await pruneLogs(dir, AGE);
  for (const path of paths) assert.deepEqual((await readdir(path)).sort(), ["launch.json", "owner.json"]);
});

test("malformed, foreign, unmarked and extra-content result directories are preserved", async t => {
  const dir = await fixture(t);
  const paths = [];
  for (const [name, marker] of [
    ["foreign", { kind: "another-tool" }],
    ["version", { version: 2 }],
    ["extra-key", { extra: true }],
    ["invalid-pid", { pid: 0 }],
    ["fractional-pid", { pid: 1.5 }],
    ["invalid-age", { createdAt: "old" }],
    ["negative-age", { createdAt: -1 }],
  ]) paths.push(await owned(dir, name, { marker }));
  for (const [name, contents] of [["invalid-json", "{"], ["null", "null"], ["array", "[]"], ["missing-fields", "{}"]]) {
    const path = await owned(dir, name);
    await writeFile(join(path, "owner.json"), contents);
    await ageContents(path);
    paths.push(path);
  }
  for (const name of ["unmarked", "empty", "extra-file", "extra-directory", "payload-directory"]) {
    const path = await owned(dir, name);
    if (name === "unmarked" || name === "empty") await rm(join(path, "owner.json"));
    if (name === "empty" || name === "payload-directory") await rm(join(path, "launch.json"));
    if (name === "extra-file") await writeFile(join(path, "user.txt"), "keep me");
    if (name === "extra-directory") await mkdir(join(path, "user-directory"));
    if (name === "payload-directory") await mkdir(join(path, "launch.json"));
    await ageContents(path);
    paths.push(path);
  }
  const before = await Promise.all(paths.map(path => readdir(path)));
  await pruneLogs(dir, AGE);
  assert.deepEqual(await Promise.all(paths.map(path => readdir(path))), before);
  assert.equal(await readFile(join(dir, ".xcodebug-launch-extra-file", "user.txt"), "utf8"), "keep me");
});

test("symlink roots and either symlink payload never affect outside targets", async t => {
  const dir = await fixture(t);
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "outside target");
  await age(outside);
  const paths = [];
  for (const name of ["owner.json", "launch.json"]) {
    const path = await owned(dir, `symlink-${name}`);
    await rm(join(path, name));
    await symlink(outside, join(path, name));
    await age(path);
    paths.push(path);
  }
  const outsideRoot = await owned(dir, "outside-root");
  await rename(outsideRoot, join(dir, "outside-directory"));
  const rootLink = join(dir, ".xcodebug-launch-symlink-root");
  await symlink(join(dir, "outside-directory"), rootLink);
  await pruneLogs(dir, AGE);
  assert.equal(await readFile(outside, "utf8"), "outside target");
  assert.ok((await lstat(rootLink)).isSymbolicLink());
  assert.deepEqual((await readdir(join(dir, "outside-directory"))).sort(), ["launch.json", "owner.json"]);
  for (const path of paths) assert.deepEqual((await readdir(path)).sort(), ["launch.json", "owner.json"]);
});

test("revalidation preserves a directory made fresh or given unknown content during inspection", async t => {
  const dir = await fixture(t);
  const fresh = await owned(dir, "changed-file");
  const extra = await owned(dir, "changed-entries");
  const reads = new Map();
  const original = fs.promises.readdir;
  mockFilesystem(t, "readdir", async (path, ...args) => {
    const count = (reads.get(path) ?? 0) + 1;
    reads.set(path, count);
    if (count === 2 && path === fresh) await age(join(path, "launch.json"), NOW);
    if (count === 2 && path === extra) await writeFile(join(path, "user.txt"), "keep me");
    return original(path, ...args);
  });
  await pruneLogs(dir, AGE);
  assert.deepEqual((await readdir(fresh)).sort(), ["launch.json", "owner.json"]);
  assert.deepEqual((await readdir(extra)).sort(), ["launch.json", "owner.json", "user.txt"]);
});

test("a known payload made fresh while rereading ownership is not deleted", async t => {
  const dir = await fixture(t);
  const path = await owned(dir, "fresh-during-marker-read");
  const original = fs.promises.open;
  let opens = 0;
  mockFilesystem(t, "open", async (target, ...args) => {
    const handle = await original(target, ...args);
    if (target === join(path, "owner.json") && ++opens === 2) {
      await writeFile(join(path, "launch.json"), "fresh result");
      await age(join(path, "launch.json"), NOW);
    }
    return handle;
  });
  await pruneLogs(dir, AGE);
  assert.deepEqual((await readdir(path)).sort(), ["launch.json", "owner.json"]);
  assert.equal(await readFile(join(path, "launch.json"), "utf8"), "fresh result");
});

test("a root replaced by a symlink during revalidation preserves the outside directory", async t => {
  const dir = await fixture(t);
  const path = await owned(dir, "replaced");
  const outside = await owned(dir, "outside");
  await rename(outside, join(dir, "outside-directory"));
  const original = fs.promises.lstat;
  let inspections = 0;
  mockFilesystem(t, "lstat", async (target, ...args) => {
    if (target === path && ++inspections === 2) {
      await rename(path, join(dir, "original-directory"));
      await symlink(join(dir, "outside-directory"), path);
    }
    return original(target, ...args);
  });
  await pruneLogs(dir, AGE);
  assert.ok((await lstat(path)).isSymbolicLink());
  for (const name of ["original-directory", "outside-directory"]) {
    assert.deepEqual((await readdir(join(dir, name))).sort(), ["launch.json", "owner.json"]);
  }
});

test("cleanup errors fail closed without failing pruning or deleting unrelated content", async t => {
  const dir = await fixture(t);
  const path = await owned(dir, "unlink-error");
  const original = fs.promises.unlink;
  mockFilesystem(t, "unlink", async (target, ...args) => {
    if (target === join(path, "launch.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(target, ...args);
  });
  await pruneLogs(dir, AGE);
  assert.deepEqual((await readdir(path)).sort(), ["launch.json", "owner.json"]);
  await pruneLogs(join(dir, "missing"), AGE);
});

test("existing log pruning removes only old recognized logs and preserves other files and directories", async t => {
  const dir = await fixture(t);
  const oldLogs = ["build-old.log", "console-old.log.2", "syslog-old.log", "pod-install-old.log", "crash-old.ips"];
  for (const name of [...oldLogs, "console-fresh.log", "user.log", ".xcodebug-launch-not-a-directory"]) {
    await writeFile(join(dir, name), "keep unless owned and old");
    await age(join(dir, name), name === "console-fresh.log" ? NOW : OLD);
  }
  await mkdir(join(dir, "unknown-directory"));
  await age(join(dir, "unknown-directory"));
  await pruneLogs(dir, AGE);
  assert.deepEqual((await readdir(dir)).sort(), [
    ".xcodebug-launch-not-a-directory", "console-fresh.log", "unknown-directory", "user.log",
  ]);
});
