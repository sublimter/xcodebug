import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import xcodebug from "../index.ts";

const DEVICE = { identifier: "test-device", properties: {
  hardware: { udid: "test-udid", reality: "physical" },
  connection: { state: "connected", transportType: "wired" }, state: { name: "Test" },
} };
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Probe</string><key>CFBundleIdentifier</key><string>test.probe</string></dict></plist>
`;

// One session of the real extension against a fake device. The device is a set
// of files under `root` that the fake CLIs read and the tests write:
//   pid         the app's process, as the process table reports it; absent when it is not running
//   launches    one line per console launch; each launch gives the app the pid 4000 + its number
//   drop        the first launch's console bridge exits, the app keeps running
//   slow-table  the process table takes two seconds to answer
//   die         the app is killed: its process is gone and the bridge says so
//   linger      a launch takes a moment to replace the instance in the process table
//   crash-name  a crash report by this name is on the device, about the process in crash-pid;
//               a crash from 2020 and a resource diagnostic are always there
//   builds      one line per xcodebuild build
//   edit-during-build  the build finds the sources changed under it
async function session(t) {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-run-test-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const agent = join(root, "agent");
  const app = join(root, "out", "Probe.app");
  for (const dir of [bin, repo, agent, app]) await mkdir(dir, { recursive: true });
  await writeFile(join(app, "Info.plist"), INFO_PLIST);
  const script = (name, body) => writeFile(join(bin, name), `#!/bin/sh\nroot='${root}'\n${body}\n`, { mode: 0o755 });
  await script("xcrun", `case " $* " in
  *" --version "*) echo "fake devicectl" ;;
  *" list devices "*) printf '%s\\n' '${JSON.stringify({ result: { devices: [DEVICE] } })}' ;;
  *" device install app "*) exit 0 ;;
  *" device info processes "*)
    if [ -f "$root/slow-table" ]; then /bin/sleep 2; fi
    if [ -s "$root/pid" ]; then
      printf '{"result":{"runningProcesses":[{"executable":"file:///private/var/containers/Bundle/Application/X/Probe.app/PlugIns/Widget.appex/Widget","processIdentifier":55},{"executable":"file:///private/var/containers/Bundle/Application/X/Probe.app/Probe","processIdentifier":%s}]}}\\n' "$(/bin/cat "$root/pid")"
    else
      printf '{"result":{"runningProcesses":[{"executable":"file:///private/var/containers/Bundle/Application/X/Probe.app/PlugIns/Widget.appex/Widget","processIdentifier":55}]}}\\n'
    fi ;;
  *" device info files "*)
    now=$(/bin/date -u +%Y-%m-%dT%H:%M:%S.000Z)
    recent=''
    if [ -f "$root/crash-name" ]; then
      recent=$(printf '{"name":"%s","metadata":{"lastModDate":"%s"}},' "$(/bin/cat "$root/crash-name")" "$now")
    fi
    printf '{"result":{"files":[{"name":"Probe.cpu_resource-2026-11-19-101011.ips","metadata":{"lastModDate":"%s"}},%s{"name":"Probe-2020-01-01-000000.ips","metadata":{"lastModDate":"2020-01-01T00:00:00.000Z"}}]}}\\n' "$now" "$recent" ;;
  *" device copy from "*)
    while [ $# -gt 1 ]; do
      [ "$1" = "--source" ] && source="$2"
      [ "$1" = "--destination" ] && destination="$2"
      shift
    done
    # Pids come round again: the crash from years ago was of a process numbered like the first launch.
    case "$source" in *2020*) pid=4001 ;; *) pid=$(/bin/cat "$root/crash-pid") ;; esac
    printf '{"bug_type":"309"}\\n{\\n  "pid" : %s,\\n  "procName" : "Probe"\\n}\\n' "$pid" > "$destination" ;;
  *" device process launch "*)
    echo launched >> "$root/launches"
    n=$(/usr/bin/wc -l < "$root/launches" | /usr/bin/tr -d ' ')
    # The instance being replaced stays in the process table for a moment.
    if [ -f "$root/linger" ]; then /bin/sleep 0.4; fi
    echo $((4000 + n)) > "$root/pid"
    printf 'Launched application with test.probe bundle identifier.\\n'
    printf 'instance %s logging\\n' "$n" >&2
    while :; do
      if [ "$n" = 1 ] && [ -f "$root/drop" ]; then exit 1; fi
      if [ -f "$root/die" ]; then /bin/rm -f "$root/pid"; printf 'App terminated due to signal 9.\\n'; exit 1; fi
      /bin/sleep 0.05
    done ;;
  *) exit 1 ;;
esac`);
  await script("xcodebuild", `case " $* " in
  *" -version "*) echo "Xcode fake" ;;
  *" -showBuildSettings "*) printf '%s\\n' '${JSON.stringify([{ buildSettings: {
    TARGET_BUILD_DIR: join(root, "out"), WRAPPER_NAME: "Probe.app", PRODUCT_BUNDLE_IDENTIFIER: "test.probe" } }])}' ;;
  *)
    echo built >> "$root/builds"
    if [ -f "$root/edit-during-build" ]; then
      /bin/rm "$root/edit-during-build"
      echo "// edited while the build ran" >> "$root/repo/A.swift"
    fi
    /bin/date > "$root/out/Probe.app/Probe"
    printf "CompileC probe.o (in target 'Probe' from project 'Probe')\\n** BUILD SUCCEEDED **\\n" ;;
esac`);
  await script("idevicesyslog", `case " $* " in
  *" --version "*) echo "fake idevicesyslog"; exit 0 ;;
  *" Burst "*)
    printf 'EARLY_MARKER the line the check waits for\\n'
    /usr/bin/awk 'BEGIN { for (i = 0; i < 30000; i++) print "filler line " i }' ;;
esac
exec /bin/sleep 120`);

  const git = (...args) => execFileSync("git", [
    "-c", "user.name=test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q");
  await writeFile(join(repo, "A.swift"), "// one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let tool;
  const hooks = new Map();
  xcodebug({ cwd: repo, registerTool(value) { tool = value; }, on(name, fn) { hooks.set(name, fn); },
    registerCommand() {}, sendMessage() {} });
  const context = { cwd: repo, agentDir: agent, hasUI: true, ui: { setStatus() {}, setWidget() {}, notify() {} } };
  const call = args => tool.execute("test", { push: "off", dualChannel: false, ...args }, undefined, undefined, context);
  const ok = async args => {
    const result = await call(args);
    assert.ok(!result.isError, result.content[0]?.text);
    return result;
  };
  t.after(async () => {
    try {
      await call({ action: "stop" });
      await hooks.get("session_shutdown")();
    } finally {
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root, repo, app, git, call, ok,
    logs: join(agent, "logs", "xcodebug"),
    text: async args => (await ok(args)).content[0].text,
    capture: async () => (await ok({ action: "status" })).details.captures[0],
    flag: (name, value = "") => writeFile(join(root, name), value),
    count: name => readFile(join(root, name), "utf8").then(text => text.trim().split("\n").length, () => 0),
    built: { device: "test-device", project: join(repo, "Probe.xcodeproj"), scheme: "Probe" },
    prebuilt: { device: "test-device", appPath: app, bundleId: "test.probe" },
  };
}

async function until(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(50);
  }
}

test("launch reuses this session's build until the code or the product is no longer what was built", { timeout: 90_000 }, async t => {
  const s = await session(t);
  const first = await s.text({ action: "launch", ...s.built });
  assert.match(first, /build succeeded/);
  assert.doesNotMatch(first, /archive:/, "archiving is off, so there is nothing to report about it");
  assert.equal(await s.count("builds"), 1);

  const second = await s.text({ action: "launch", ...s.built });
  assert.match(second, /^reusing this session's build /);
  assert.doesNotMatch(second, /already running/, "replacing its own previous instance is not news");
  assert.equal(await s.count("builds"), 1);
  assert.equal(await s.count("launches"), 2, "a reused build is still installed and launched");
  assert.match(await s.text({ action: "changes", ...s.built }), /\nrebuild needed: no\n/);
  assert.match(await s.text({ action: "changes", ...s.built, scheme: "Other" }), /\nrebuild needed: yes\n/);
  assert.match(await s.text({ action: "changes", ...s.built, force: true }), /\nrebuild needed: yes\n/);
  assert.match(await s.text({ action: "build", ...s.built }), /^build skipped: nothing changed since /);

  // A commit leaves the tree as clean as it was, with other code in it.
  await writeFile(join(s.repo, "A.swift"), "// two, and committed\n");
  s.git("commit", "-q", "-am", "two");
  assert.match(await s.text({ action: "changes", ...s.built }), /\nrebuild needed: yes\n/);
  assert.match(await s.text({ action: "launch", ...s.built }), /build succeeded/);
  assert.equal(await s.count("builds"), 2);
  assert.match(await s.text({ action: "launch", ...s.built }), /^reusing this session's build /);

  // Xcode, or an xcodebuild in another terminal, writes the same product path.
  await writeFile(join(s.app, "Probe"), "rebuilt by someone else");
  assert.match(await s.text({ action: "changes", ...s.built }), /\nrebuild needed: yes\n/);
  assert.match(await s.text({ action: "launch", ...s.built }), /build succeeded/);
  assert.equal(await s.count("builds"), 3);

  const prebuilt = await s.text({ action: "launch", ...s.prebuilt });
  assert.doesNotMatch(prebuilt, /reusing|build succeeded/, "an app the caller named was neither built nor reused");
  assert.equal(await s.count("builds"), 3);
  assert.match(await s.text({ action: "launch", ...s.built, force: true }), /build succeeded/);
  assert.equal(await s.count("builds"), 4);

  // Whether an edit made during a build is in its product cannot be known.
  await s.flag("edit-during-build");
  await writeFile(join(s.repo, "A.swift"), "// three\n");
  assert.match(await s.text({ action: "launch", ...s.built }),
    /build succeeded.*\nnote: the working tree changed while this was building, so the next run builds again/s);
  assert.equal(await s.count("builds"), 5);
  assert.match(await s.text({ action: "launch", ...s.built }), /build succeeded/);
  assert.equal(await s.count("builds"), 6);
  assert.match(await s.text({ action: "launch", ...s.built }), /^reusing this session's build /);
  // The tree still differs from the last commit, and is what was built.
  assert.match(await s.text({ action: "changes", ...s.built }), /^1 build-relevant change\(s\)\n.*\nrebuild needed: no\n/s);
});

test("a line the buffer has dropped is still found, and the reply says where it looked", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const captureId = (await s.ok({ action: "syslog", device: "test-device", processName: "Burst" })).details.capture.id;
  await until(async () => (await s.capture()).lineCount === 30_001, "the burst to be captured");
  const searched = /\nnote: 10001 line\(s\) no longer in memory were searched in \S+\.log$/;

  const waited = await s.text({ action: "wait", captureId, match: "EARLY_MARKER", timeoutSeconds: 5 });
  assert.match(waited, /^matched 1 line\(s\) · cursor 30001\n +1 EARLY_MARKER /);
  assert.match(waited, searched);
  assert.match(await s.text({ action: "logs", captureId, grep: "EARLY_MARKER" }), /^1 line\(s\) · cursor 30001\n +1 EARLY_MARKER /);
  assert.match(await s.text({ action: "logs", captureId, grep: "EARLY_MARKER", times: true }), /\n +1 \d\d:\d\d:\d\d\.\d{3} EARLY_MARKER /);
  const absent = await s.text({ action: "logs", captureId, grep: "NEVER_LOGGED" });
  assert.match(absent, /^\(no line matching "NEVER_LOGGED" since 0; capture cursor is 30001\)/);
  assert.match(absent, searched, "nothing found has to mean the whole log was read");

  const tail = await s.text({ action: "logs", captureId, limit: 3 });
  assert.match(tail, /^3 line\(s\) \(29998 older omitted\) · cursor 30001\n/);
  assert.match(tail, /\nnote: 10001 older line\(s\) are no longer in memory; read them from \S+\.log$/);
  assert.doesNotMatch(await s.text({ action: "logs", captureId, since: 29_990 }), /note:/);

  // One wait for either outcome of a step, which a substring cannot express.
  assert.match(await s.text({ action: "wait", captureId, match: "^EARLY_(MARKER|FAILURE) ", regex: true, timeoutSeconds: 5 }), /^matched 1 line/);
  const literal = await s.call({ action: "wait", captureId, match: "^EARLY_(MARKER|FAILURE) ", timeoutSeconds: 1 });
  assert.match(literal.content[0].text, /^timed out after 1s waiting for "\^EARLY_\(MARKER\|FAILURE\) "/);
  await assert.rejects(s.call({ action: "wait", captureId, match: "EARLY_(", regex: true }), /is not a valid regular expression/);
});

test("an app that dies under a capture ends it with the reason and its crash report", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const launched = await s.ok({ action: "launch", ...s.prebuilt });
  const captureId = launched.details.capture.id;
  const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED", timeoutSeconds: 30 });
  await delay(200);
  await s.flag("crash-pid", "4001");
  await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
  await s.flag("die");
  const waited = await waiting;
  assert.equal(waited.isError, true);
  assert.match(waited.content[0].text, /^capture ended before "NEVER_LOGGED" appeared \(cursor \d+\) · last line: "App terminated due to signal 9\."/);

  const ended = await until(async () => {
    const capture = await s.capture();
    return capture.endReason && capture.crashReport ? capture : undefined;
  }, "the capture to end and its crash report to arrive", 20_000);
  assert.equal(ended.running, false);
  assert.equal(ended.endReason, 'the app exited; last line before the bridge ended: "App terminated due to signal 9."');
  // This instance's report: not the resource diagnostic dated beside it, and not
  // the crash from 2020, which was of a process that had the same pid.
  assert.match(ended.crashReport, /\/crash-[^/]+-Probe-2026-11-19-101010\.ips$/);
  assert.match(await readFile(ended.crashReport, "utf8"), /"pid" : 4001,/);
  assert.equal((await readdir(s.logs)).filter(name => name.startsWith("crash-")).length, 1);
  assert.equal(await s.count("launches"), 1, "an app that is gone is not relaunched");

  assert.match(await s.text({ action: "status" }), / exited code=1 · the app exited; .+ · crash report: \S+crash-[^/]+-Probe-2026-11-19-101010\.ips · \d+ lines · /);
  const filtered = await s.text({ action: "logs", captureId, grep: "matches no line" });
  assert.match(filtered, /\n\[this capture ended on its own · the app exited; /);
  assert.match(filtered, /\n\[crash report: \S+crash-[^/]+-Probe-2026-11-19-101010\.ips\]$/);
  const onDisk = await readFile(ended.logFile, "utf8");
  assert.match(onDisk, / \[xcodebug\] the app exited; .+; stopping capture\n/, "why a log stops is part of the log");
  assert.match(onDisk, / \[xcodebug\] crash report: /);
});

test("a console reattach is reported as the relaunch it is", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  // The bridge drops while the app keeps running, and the command outlasts the reattach.
  const ran = await s.ok({ action: "await", captureId, command: `: > '${join(s.root, "drop")}'; sleep 4` });
  assert.match(ran.content[0].text, new RegExp(`\\nstopped ${captureId} · `));
  assert.match(ran.content[0].text, /\nwarning: a console reattach relaunched the app 1 time\(s\) during this run; /);
  assert.equal(await s.count("launches"), 2);
  const capture = await s.capture();
  assert.equal(capture.relaunches, 1);
  assert.equal(capture.appPid, 4002, "the instance the reattach started, not the one it terminated");
  assert.match(await s.text({ action: "status" }), / · app relaunched 1× · /);
  assert.match(await s.text({ action: "logs", captureId, grep: "relaunched the app" }),
    /\[xcodebug\] console bridge reattached - this relaunched the app \(relaunch 1\), so the state it had is gone/);
});

test("a capture whose app someone else relaunched ends, and leaves that instance alone", { timeout: 60_000 }, async t => {
  const s = await session(t);
  // Started from the home screen, or by another session.
  await s.flag("pid", "777\n");
  await s.flag("linger");
  const launched = await s.text({ action: "launch", ...s.prebuilt });
  assert.match(launched, /^note: Probe was already running \(pid 777\), not started by this session; this launch terminated it\n/);
  assert.match(launched, /\nlaunched test\.probe on Test \(pid 4001\)\n/, "not the instance that was on its way out");

  // Another session now does the same to this one: the instance is replaced and the bridge goes.
  // Its instance then crashes, which leaves a report that is not about this capture's.
  await s.flag("pid", "9999\n");
  await s.flag("crash-pid", "9999");
  await s.flag("crash-name", "Probe-2026-11-19-121212.ips");
  await s.flag("drop");
  const ended = await until(async () => {
    const capture = await s.capture();
    return capture.endReason ? capture : undefined;
  }, "the capture to end");
  assert.match(ended.endReason, /^the app was restarted outside this capture \(pid 4001 -> 9999\) and is left running; /);
  // Past the next backoff, and past the first look for a crash report: a reattach
  // would have launched again, and killed pid 9999 doing it.
  await delay(2_000);
  assert.equal(await s.count("launches"), 1);
  const capture = await s.capture();
  assert.equal(capture.running, false);
  assert.equal(capture.crashReport, undefined, "a report about another instance of the app is not this capture's");
  assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith("crash-")), [], "nor is it left beside this run's log");
});

test("a stop that lands while a dropped bridge is being looked into is not answered with a relaunch", { timeout: 60_000 }, async t => {
  const s = await session(t);
  await s.ok({ action: "launch", ...s.prebuilt, dualChannel: false });
  await s.flag("slow-table");
  await s.flag("drop");
  // One second of backoff, then the process table is asked; the stop arrives mid-answer.
  await delay(1_600);
  assert.match(await s.text({ action: "stop" }), /^stopped 1 capture/);
  await delay(2_500);
  assert.equal(await s.count("launches"), 1);
  assert.equal((await s.capture()).running, false);
});

test("a config file that does not parse is an error, not an absent config", { timeout: 30_000 }, async t => {
  const s = await session(t);
  await writeFile(join(s.repo, ".xcodebug.json"), '{ "scheme": "Other", }');
  assert.match(await s.text({ action: "doctor" }), /\nconfig: \S+\.xcodebug\.json is not valid JSON: /);
  await assert.rejects(s.call({ action: "launch", ...s.built }), /\.xcodebug\.json is not valid JSON: /);
  assert.equal(await s.count("builds"), 0, "the scheme it would have overridden was not built");
  // Reading and stopping a capture use nothing from the file.
  assert.equal(await s.text({ action: "status" }), "no captures in this session");
  assert.match(await s.text({ action: "stop" }), /^nothing to stop/);
});

test("the first run of a session clears the logs nothing has written to for a month", { timeout: 30_000 }, async t => {
  const s = await session(t);
  await mkdir(s.logs, { recursive: true });
  const stale = [
    "build-Probe-2026-01-01_00-00-00-000.log",
    "console-test.probe-2026-01-01_00-00-00-000.log.1",
    "crash-Probe-2026-01-01-000000.ips",
  ];
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const name of [...stale, "notes.txt"]) {
    await writeFile(join(s.logs, name), "x");
    await utimes(join(s.logs, name), old, old);
  }
  await writeFile(join(s.logs, "build-Probe-2026-11-18_00-00-00-000.log"), "recent");
  await s.ok({ action: "status" });
  assert.equal((await readdir(s.logs)).length, 5, "reading state is not a run");

  await s.ok({ action: "syslog", device: "test-device", processName: "Quiet" });
  const left = await readdir(s.logs);
  for (const name of stale) assert.ok(!left.includes(name), `${name} should be gone`);
  assert.ok(left.includes("notes.txt"), "a file xcodebug did not name is not its to delete");
  assert.ok(left.includes("build-Probe-2026-11-18_00-00-00-000.log"));
});
