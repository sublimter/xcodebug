import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import xcodebug from "../index.ts";
import { pullCrashReport } from "../devices.ts";

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
//   delayed-table-snapshot  hold a launch query before it reads the current process table
//   no-launch-result  the bridge exits without writing its native command result
//   launch-result  override the native result with malformed/untrusted metadata
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
  *" list devices "*)
    echo queried >> "$root/device-queries"
    if [ -f "$root/hold-devices" ]; then
      echo $$ > "$root/device-query.pid"
      exec /bin/sleep 120
    fi
    printf '%s\\n' '${JSON.stringify({ result: { devices: [DEVICE] } })}' ;;
  *" device install app "*)
    echo installed >> "$root/installs"
    if [ -f "$root/hold-install" ]; then
      echo $$ > "$root/install.pid"
      exec /bin/sleep 120
    fi
    exit 0 ;;
  *" device info processes "*)
    if [ -f "$root/bad-table" ]; then echo invalid-json; exit 0; fi
    if [ -f "$root/stale-table" ] || { [ -f "$root/late-table" ] && [ -f "$root/launches" ]; }; then
      if [ -f "$root/late-table" ]; then
        while [ ! -s "$root/pid" ]; do /bin/sleep 0.01; done
      fi
      echo $$ > "$root/table-pid"
      : > "$root/table-started"
      if [ -f "$root/delayed-table-snapshot" ]; then
        while [ ! -f "$root/table-snapshot-release" ]; do /bin/sleep 0.01; done
      fi
      saved=$(/bin/cat "$root/pid")
      : > "$root/table-snapshotted"
      while [ ! -f "$root/table-release" ]; do /bin/sleep 0.01; done
      printf '{"result":{"runningProcesses":[{"executable":"file:///private/X/Probe.app/Probe","processIdentifier":%s}]}}\\n' "$saved"
      exit 0
    fi
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
    if [ -f "$root/crash-content" ]; then
      /bin/cat "$root/crash-content" > "$destination"
    else
      printf '{"bug_type":"309"}\n{\n  "pid" : %s,\n  "procName" : "Probe",\n  "termination": {"namespace":"FRONTBOARD","code":2343432205,"reasons":["scene-create watchdog transgression"]}\n}\n' "$pid" > "$destination"
    fi ;;
  *" device process launch "*)
    result_file=''
    while [ $# -gt 1 ]; do
      [ "$1" = "--json-output" ] && result_file="$2"
      shift
    done
    echo launched >> "$root/launches"
    n=$(/usr/bin/wc -l < "$root/launches" | /usr/bin/tr -d ' ')
    # The instance being replaced stays in the process table for a moment.
    if [ -f "$root/linger" ]; then /bin/sleep 0.4; fi
    launch_pid=$((4000 + n))
    echo "$launch_pid" > "$root/pid"
    write_launch_result() {
      [ -n "$result_file" ] && [ ! -f "$root/no-launch-result" ] || return 0
      if [ -f "$root/launch-result" ]; then
        /bin/cat "$root/launch-result" > "$result_file"
      else
        printf '{"info":{"commandType":"devicectl.device.process.launch","outcome":"success"},"result":{"process":{"processIdentifier":%s,"executable":"/private/X/Probe.app/Probe"}}}\\n' "$launch_pid" > "$result_file"
      fi
    }
    printf 'Launched application with test.probe bundle identifier.\\n'
    printf 'instance %s logging\\n' "$n" >&2
    trap '/bin/rm -f "$root/pid"; write_launch_result; exit 0' TERM
    while :; do
      if [ "$n" = 1 ] && [ -f "$root/drop" ]; then write_launch_result; exit 1; fi
      if [ -f "$root/die" ]; then
        /bin/rm -f "$root/pid"
        printf 'App terminated due to signal 9.\\n'
        write_launch_result
        if [ -f "$root/hold-pipes" ]; then
          (while [ -d "$root" ] && [ ! -f "$root/drain-release" ]; do /bin/sleep 0.01; done) &
        fi
        exit 1
      fi
      /bin/sleep 0.05
    done ;;
  *) exit 1 ;;
esac`);
  await script("xcodebuild", `case " $* " in
  *" -version "*) echo "Xcode fake" ;;
  *" -showBuildSettings "*) printf '%s\\n' '${JSON.stringify([{ buildSettings: {
    PRODUCT_TYPE: "com.apple.product-type.application", PLATFORM_NAME: "iphoneos",
    TARGET_BUILD_DIR: join(root, "out"), WRAPPER_NAME: "Probe.app", PRODUCT_BUNDLE_IDENTIFIER: "test.probe" } }])}' ;;
  *)
    /bin/pwd -P >> "$root/builds"
    if [ -f "$root/hold-build" ]; then
      echo $$ > "$root/build.pid"
      printf "CompileC probe.o (in target 'Probe' from project 'Probe')\\n"
      exec /bin/sleep 120
    fi
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
echo $$ > "$root/syslog.pid"
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
  let command;
  const hooks = new Map();
  const messages = [];
  xcodebug({ cwd: repo, registerTool(value) { tool = value; }, on(name, fn) { hooks.set(name, fn); },
    registerCommand(_name, value) { command = value; }, sendMessage(message) { messages.push(message); } });
  const notifications = [];
  const uiState = {};
  const context = { cwd: repo, agentDir: agent, hasUI: true, ui: {
    setStatus(_name, value) { uiState.status = value; }, setWidget(_name, value) { uiState.widget = value; },
    notify(message, level) { notifications.push({ message, level }); },
  } };
  const call = (args, signal) => tool.execute("test", { push: "off", dualChannel: false, ...args }, signal, undefined, context);
  const ok = async args => {
    const result = await call(args);
    assert.ok(!result.isError, result.content[0]?.text);
    return result;
  };
  t.after(async () => {
    try {
      await Promise.all(["drain-release", "table-release", "table-snapshot-release"].map(name => writeFile(join(root, name), "")));
      await call({ action: "stop" });
      await hooks.get("session_shutdown")();
    } finally {
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root, repo, app, git, call, ok, notifications, messages, context, uiState, tool,
    native: args => command.handler(args, context),
    shutdown: () => hooks.get("session_shutdown")(),
    logs: join(agent, "logs", "xcodebug"),
    text: async args => (await ok(args)).content[0].text,
    capture: async () => (await ok({ action: "status" })).details.captures[0],
    flag: (name, value = "") => writeFile(join(root, name), value),
    count: name => readFile(join(root, name), "utf8").then(text => text.trim().split("\n").length, () => 0),
    built: { device: "test-device", project: join(repo, "Probe.xcodeproj"), scheme: "Probe" },
    prebuilt: { device: "test-device", appPath: app, bundleId: "test.probe" },
  };
}

test("restart uses the original directory for config, build and the replayed command", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const other = join(s.root, "other");
  const commands = join(s.root, "command-cwds");
  const original = fs.realpathSync(s.repo);
  await mkdir(other);
  await writeFile(join(other, ".xcodebug.json"), "invalid JSON");
  await s.ok({ action: "launch", ...s.built, command: `/bin/pwd -P >> '${commands}'` });
  s.context.cwd = other;
  await s.ok({ action: "restart" });
  for (const trace of [join(s.root, "builds"), commands]) {
    assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n"), [original, original]);
  }
});

test("each workspace regenerates its Pods project for the same new source file", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const installs = join(s.root, "pod-installs");
  await writeFile(join(s.root, "bin", "pod"), `#!/bin/sh\n/bin/pwd -P >> '${installs}'\n`, { mode: 0o755 });
  await writeFile(join(s.repo, "Probe.podspec"), 's.name = "Probe"\ns.source_files = "Classes/**/*"\n');
  await mkdir(join(s.repo, "Classes"));
  await writeFile(join(s.repo, "Classes", "New.swift"), "// new source\n");

  const workspaces = ["First", "Second"].map(name => join(s.repo, name));
  for (const dir of workspaces) {
    await mkdir(join(dir, "Pods"), { recursive: true });
    await mkdir(join(dir, "Probe.xcworkspace"));
    for (const name of ["Podfile", "Podfile.lock", "Pods/Manifest.lock"]) {
      await writeFile(join(dir, name), "synced\n");
    }
  }
  for (const dir of [...workspaces, workspaces[0]]) {
    await s.ok({ action: "build", workspace: join(dir, "Probe.xcworkspace"), scheme: "Probe", device: "test-device" });
  }
  assert.deepEqual((await readFile(installs, "utf8")).trim().split("\n"), workspaces.map(dir => fs.realpathSync(dir)));
});

test("stop cancels an executing command even when no capture exists", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const caller = new AbortController();
  const pidFile = join(s.root, "stop-command.pid");
  const running = s.call({ action: "await", command: `echo $$ > '${pidFile}'; exec /bin/sleep 120` }, caller.signal);
  try {
    const pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "command to start");
    assert.match(s.uiState.status, /command:/);
    const stopped = await s.ok({ action: "stop" });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "stop must end the owned command before replying");
    assert.equal((await running).isError, true);
    assert.doesNotMatch(stopped.content[0].text, /nothing to stop/);
    assert.equal(caller.signal.aborted, false, "stop must not abort its caller's controller");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0, "settlement removes caller cancellation listeners");
    assert.equal(s.uiState.status, undefined);
    assert.equal(s.uiState.widget, undefined);
    await s.ok({ action: "await", command: ":" });
  } finally {
    caller.abort();
    await running.catch(() => {});
  }
});

test("stop cancels installation before launch or syslog startup", { timeout: 20_000 }, async t => {
  const s = await session(t);
  await s.flag("hold-install");
  const launching = s.native(`launch device="${s.prebuilt.device}" appPath="${s.prebuilt.appPath}" bundleId="${s.prebuilt.bundleId}" dualChannel=true push=off`);
  const pid = await until(() => readFile(join(s.root, "install.pid"), "utf8").then(Number, () => undefined), "installation to start");
  const stopped = await s.ok({ action: "stop" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await launching;
  assert.match(stopped.content[0].text, /cancelled/);
  assert.equal(await s.count("installs"), 1);
  assert.equal(await s.count("launches"), 0);
  assert.equal(await s.count("syslog.pid"), 0);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
});

test("native stop cancels a no-capture build and already-admitted tool and native work", { timeout: 20_000 }, async t => {
  const s = await session(t);
  await s.flag("hold-build");
  const building = s.native(`build device="${s.built.device}" project="${s.built.project}" scheme="${s.built.scheme}"`);
  const pid = await until(() => readFile(join(s.root, "build.pid"), "utf8").then(Number, () => undefined), "native build to start");
  const queries = await s.count("device-queries");
  const marker = join(s.root, "queued-command");
  const queuedTool = s.call({ action: "status", command: `: > '${marker}'` });
  const queuedNative = s.native("devices");
  await Promise.all([s.native("stop"), s.ok({ action: "stop" })]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await queuedTool).isError, true);
  await Promise.all([building, queuedNative]);
  assert.equal(await s.count("queued-command"), 0, "an admitted command must not start after stop");
  assert.equal(await s.count("device-queries"), queries, "an admitted native discovery must not start after stop");
  assert.equal(await s.count("builds"), 1);
  const stop = s.messages.find(message => message.details?.action === "stop");
  assert.match(stop.content, /cancelled \d+ operation/);
  assert.doesNotMatch(stop.content, /nothing to stop/);
  assert.equal(s.messages.find(message => message.details?.action === "devices").details.isError, true);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
  await s.native("devices");
  assert.equal(s.messages.at(-1).details.isError, false, "calls after the stop boundary remain usable");
});

test("registered stop cancels native discovery before any install or capture startup", { timeout: 20_000 }, async t => {
  const s = await session(t);
  await s.flag("hold-devices");
  const launching = s.native(`launch device="${s.prebuilt.device}" appPath="${s.prebuilt.appPath}" bundleId="${s.prebuilt.bundleId}" dualChannel=true push=off`);
  const pid = await until(() => readFile(join(s.root, "device-query.pid"), "utf8").then(Number, () => undefined), "device discovery to start");
  assert.match(s.uiState.status, /resolving/);
  const stopped = await s.ok({ action: "stop" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await launching;
  assert.doesNotMatch(stopped.content[0].text, /nothing to stop/);
  assert.equal(await s.count("installs"), 0);
  assert.equal(await s.count("launches"), 0);
  assert.equal(await s.count("syslog.pid"), 0);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
  await rm(join(s.root, "hold-devices"));
  await s.ok({ action: "devices" });
});

test("native stop cancels a pod install without starting the build or appended command", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const pidFile = join(s.root, "pod.pid");
  await writeFile(join(s.root, "bin", "pod"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 120\n`, { mode: 0o755 });
  await writeFile(join(s.repo, "Probe.podspec"), 's.name = "Probe"\ns.source_files = "Classes/**/*"\n');
  await mkdir(join(s.repo, "Classes"));
  await writeFile(join(s.repo, "Classes", "New.swift"), "// new source\n");
  await mkdir(join(s.repo, "Pods"));
  await mkdir(join(s.repo, "Probe.xcworkspace"));
  for (const name of ["Podfile", "Podfile.lock", "Pods/Manifest.lock"]) await writeFile(join(s.repo, name), "synced\n");
  const building = s.call({ action: "build", workspace: join(s.repo, "Probe.xcworkspace"), scheme: "Probe",
    device: "test-device", command: `: > '${join(s.root, "after-pods")}'` });
  const pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "pod install to start");
  await s.native("stop");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await building).isError, true);
  assert.equal(await s.count("builds"), 0);
  assert.equal(await s.count("after-pods"), 0);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
});

test("scoped stop and invalid controls preserve an unrelated build and its UI owner", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const id = (await s.ok({ action: "syslog", device: "test-device", processName: "Other" })).details.capture.id;
  await s.flag("hold-build");
  let settled = false;
  const building = s.native(`build device="${s.built.device}" project="${s.built.project}" scheme="${s.built.scheme}"`).then(() => { settled = true; });
  const pid = await until(() => readFile(join(s.root, "build.pid"), "utf8").then(Number, () => undefined), "unrelated build to start");
  const controlCtx = { ...s.context, ui: { setStatus() {}, setWidget() {}, notify() {} } };
  const control = params => s.tool.execute("control", params, undefined, undefined, controlCtx);
  await control({ action: "status" });
  await assert.rejects(control({ action: "stop", keepApp: "invalid" }), /keepApp/);
  await assert.rejects(control({ action: "stop", captureId: "" }), /capture/i);
  await s.native("stop keepApp=invalid");
  assert.equal(s.messages.at(-1).details.isError, true);
  assert.match(s.uiState.status, /^🔨 xcodebug/);
  assert.ok(s.uiState.widget);
  const stopped = await control({ action: "stop", captureId: id });
  assert.ok(!stopped.isError, stopped.content[0].text);
  assert.doesNotThrow(() => process.kill(pid, 0), "capture selection must not cancel an unrelated execution");
  assert.equal(settled, false);
  assert.match(s.uiState.status, /^🔨 xcodebug/);
  assert.ok(s.uiState.widget);
  const appendedMarker = join(s.root, "scoped-stop-command");
  const appended = s.call({ action: "stop", captureId: id, command: `: > '${appendedMarker}'` });
  await delay(20);
  assert.equal(fs.existsSync(appendedMarker), false, "a scoped stop's command must remain behind the unrelated build");
  assert.match(s.uiState.status, /^🔨 xcodebug/);
  assert.ok(s.uiState.widget);
  await control({ action: "stop" });
  await building;
  assert.equal((await appended).isError, true, "bare stop must cancel the scoped stop's preparing command");
  assert.equal(fs.existsSync(appendedMarker), false);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(s.uiState.status, undefined, "completion must clear the original build context, not the control context");
  assert.equal(s.uiState.widget, undefined);
});

test("stop keepApp=false still terminates the app when cancelling a command", { timeout: 30_000 }, async t => {
  for (const appended of [false, true]) await t.test(appended ? "appended" : "existing capture", async t => {
    const s = await session(t);
    const pidFile = join(s.root, "terminating-command.pid");
    const command = `echo $$ > '${pidFile}'; exec /bin/sleep 120`;
    const id = appended ? undefined : (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
    const running = appended ? s.call({ action: "launch", ...s.prebuilt, command }) : s.call({ action: "await", captureId: id, command });
    const pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "command to start before terminating");
    await s.ok({ action: "stop", keepApp: false });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal((await running).isError, true);
    assert.equal(await s.count("pid"), 0, "cancellation must not downgrade requested app termination to a keep-app capture kill");
  });
});

test("a later stop cancels a command appended to stop without deadlocking cleanup", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const pidFile = join(s.root, "stop-appended-command.pid");
  const running = s.native(`stop command="echo $$ > '${pidFile}'; exec /bin/sleep 120"`);
  const pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "stop's appended command to start");
  const stopped = await s.ok({ action: "stop" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await running;
  assert.match(stopped.content[0].text, /cancelled/);
  assert.doesNotMatch(stopped.content[0].text, /nothing to stop/);
  assert.equal(s.messages.at(-1).details.isError, true);
  await s.ok({ action: "await", command: ":" });
});

test("stop suppresses a pending reconnect while an executing command is settling", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const id = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  const pidFile = join(s.root, "slow-cancellation.pid");
  const running = s.call({ action: "await", captureId: id,
    command: `trap '' INT; echo $$ > '${pidFile}'; exec /bin/sleep 120` });
  const pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "SIGINT-resistant command to start");
  await s.flag("drop");
  await s.ok({ action: "stop" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await running).isError, true);
  await delay(1_200);
  assert.equal(await s.count("launches"), 1, "the stop boundary must suppress reconnect startup, not merely kill its eventual bridge");
  assert.equal(Number(await readFile(join(s.root, "pid"), "utf8")), 4001);
});


test("stop cancels appended and replayed commands while leaving the app running by default", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const pidFile = join(s.root, "appended-command.pid");
  const launching = s.call({ action: "launch", ...s.prebuilt, ...s.built,
    command: `echo $$ > '${pidFile}'; exec /bin/sleep 120` });
  let pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "appended command to start");
  await s.native("stop");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await launching).isError, true);
  assert.equal(Number(await readFile(join(s.root, "pid"), "utf8")), 4001, "keepApp defaults to true");
  assert.equal((await s.ok({ action: "status" })).details.captures.some(capture => capture.running), false);
  await rm(pidFile);
  const replaying = s.native("restart push=off dualChannel=false");
  pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "replayed command to start");
  await s.ok({ action: "stop" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await replaying;
  assert.equal(s.messages.at(-1).details.isError, true);
  assert.equal(Number(await readFile(join(s.root, "pid"), "utf8")), 4002);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
  await s.ok({ action: "await", command: ":" });
});

test("scoped stop does not cancel another capture's wait but bare stop does", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const first = (await s.ok({ action: "syslog", device: "test-device", processName: "First" })).details.capture.id;
  const second = (await s.ok({ action: "syslog", device: "test-device", processName: "Second" })).details.capture.id;
  let settled = false;
  const waiting = s.call({ action: "wait", captureId: first, match: "NEVER_LOGGED", timeoutSeconds: 120 });
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  await delay(0);
  await s.ok({ action: "stop", captureId: second });
  assert.equal(settled, false);
  assert.equal((await s.ok({ action: "status" })).details.captures.find(capture => capture.id === first).running, true);
  await s.native("stop");
  const result = await waiting;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled/);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
});

test("caller cancellation reaches discovery and releases its forwarding listener", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const caller = new AbortController();
  await s.flag("hold-devices");
  const discovering = s.call({ action: "devices" }, caller.signal);
  const pid = await until(() => readFile(join(s.root, "device-query.pid"), "utf8").then(Number, () => undefined), "cancellable discovery to start");
  caller.abort();
  assert.equal((await discovering).isError, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  await rm(join(s.root, "hold-devices"));
  await s.ok({ action: "devices" });
});

test("session teardown cancels active and queued execution without late startup", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const pidFile = join(s.root, "shutdown-command.pid");
  const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
  const running = outcome(s.call({ action: "await", command: `echo $$ > '${pidFile}'; exec /bin/sleep 120` }));
  const pid = await until(() => readFile(pidFile, "utf8").then(Number, () => undefined), "command owned by the session to start");
  const queuedTool = outcome(s.call({ action: "build", ...s.built }));
  const queuedNative = s.native("syslog device=test-device processName=Late push=off");
  await s.shutdown();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.match((await running).error?.message ?? "", /session is shutting down/);
  assert.match((await queuedTool).error?.message ?? "", /session is shutting down/);
  await queuedNative;
  assert.equal(await s.count("builds"), 0);
  assert.equal(await s.count("launches"), 0);
  assert.equal(await s.count("syslog.pid"), 0);
  assert.equal(s.uiState.status, undefined);
  assert.equal(s.uiState.widget, undefined);
  await assert.rejects(s.call({ action: "build", ...s.built }), /session is shutting down/);
});

async function until(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(50);
  }
}

function holdLaunchResult(root) {
  const originalReadFile = fs.promises.readFile;
  let entered = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  fs.promises.readFile = async (path, ...args) => {
    const content = await originalReadFile(path, ...args);
    if (String(path).startsWith(`${root}/`) && /"commandType"\s*:\s*"devicectl\.device\.process\.launch"/.test(String(content))) {
      entered = true;
      await pending;
    }
    return content;
  };
  syncBuiltinESMExports();
  return { entered: () => entered, release, restore() {
    release();
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
  } };
}
function holdCaptureStartup(logs, method) {
  const original = fs.promises[method];
  let entered = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  fs.promises[method] = async (path, ...args) => {
    const result = await original(path, ...args);
    const owned = method === "mkdir" ? String(path) === logs
      : method === "mkdtemp" ? String(path).startsWith(join(logs, ".xcodebug-launch-"))
        : String(path).startsWith(join(logs, ".xcodebug-launch-")) && String(path).endsWith("/owner.json");
    if (owned && !entered) {
      entered = true;
      await pending;
    }
    return result;
  };
  syncBuiltinESMExports();
  return { entered: () => entered, release, restore() {
    release();
    fs.promises[method] = original;
    syncBuiltinESMExports();
  } };
}

for (const method of ["mkdir", "mkdtemp", "writeFile"]) {
  test(`stop bounds held capture startup ${method} and keeps later work ordered`, { timeout: 25_000 }, async t => {
    const s = await session(t);
    const runningId = (await s.ok({ action: "syslog", device: "test-device", processName: "Other" })).details.capture.id;
    const bridgePid = await until(() => readFile(join(s.root, "syslog.pid"), "utf8").then(Number, () => undefined), "the existing syslog bridge to start");
    const startup = holdCaptureStartup(s.logs, method);
    const launching = s.native(`launch device="${s.prebuilt.device}" appPath="${s.prebuilt.appPath}" bundleId="${s.prebuilt.bundleId}" push=off dualChannel=false command=": > '${join(s.root, "late-launch-command")}'"`);
    const marker = join(s.root, "late-stop-command");
    let queued;
    let later;
    try {
      await until(startup.entered, "startup filesystem operation to be held");
      queued = s.call({ action: "status", command: `: > '${join(s.root, "queued-before-stop")}'` });
      const startedAt = Date.now();
      const stopping = s.call({ action: "stop", command: `: > '${marker}'` });
      await until(() => {
        try { process.kill(bridgePid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      }, "an unrelated running capture to stop before the startup join", 1_500);
      const stopped = await Promise.race([stopping, delay(6_500).then(() => { assert.fail("stop exceeded its cleanup budget"); })]);
      assert.ok(Date.now() - startedAt < 6_500);
      assert.equal(stopped.isError, true);
      assert.equal(stopped.details.cleanupPending, true);
      assert.match(stopped.content[0].text, /cleanup.*pending|cleanup incomplete/i);
      assert.doesNotMatch(stopped.content[0].text, /nothing to stop/);
      assert.match(s.uiState.status, /stopping|cleanup.*pending/i);
      assert.ok(s.uiState.widget);
      assert.equal((await s.ok({ action: "status" })).details.captures.find(capture => capture.id === runningId).running, false);
      assert.equal(await s.count("late-stop-command"), 0);
      let laterSettled = false;
      later = s.call({ action: "status", command: `: > '${join(s.root, "after-stop")}'` });
      void later.then(() => { laterSettled = true; });
      await delay(20);
      assert.equal(laterSettled, false, "ordinary work must stay behind unresolved startup resources");
      const repeated = await Promise.race([s.call({ action: "stop" }), delay(6_500).then(() => { assert.fail("a subsequent stop hung on pending cleanup"); })]);
      assert.equal(repeated.details.cleanupPending, true);
      assert.equal(repeated.isError, true);
      startup.release();
      await launching;
      assert.equal((await queued).isError, true);
      assert.equal((await later).isError, true, "the subsequent stop cancels the preparing ordinary request");
      assert.equal(await s.count("launches"), 0);
      for (const name of ["late-launch-command", "late-stop-command", "queued-before-stop", "after-stop"]) assert.equal(await s.count(name), 0);
      assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")), []);
      await until(() => s.uiState.status === undefined, "final cleanup to clear the pending UI");
      assert.equal(s.uiState.widget, undefined);
      await s.ok({ action: "await", command: ":" });
    } finally {
      startup.restore();
      await Promise.allSettled([launching, queued, later]);
    }
  });

  test(`shutdown bounds held capture startup ${method} without a late bridge`, { timeout: 15_000 }, async t => {
    const s = await session(t);
    await s.ok({ action: "syslog", device: "test-device", processName: "Other" });
    const bridgePid = await until(() => readFile(join(s.root, "syslog.pid"), "utf8").then(Number, () => undefined), "the existing syslog bridge to start before shutdown");
    const startup = holdCaptureStartup(s.logs, method);
    const launching = s.call({ action: "launch", ...s.prebuilt, command: `: > '${join(s.root, "shutdown-late-command")}'` }).then(value => ({ value }), error => ({ error }));
    const stderr = [];
    t.mock.method(console, "error", (...args) => { stderr.push(args.map(String).join(" ")); });
    try {
      await until(startup.entered, "startup filesystem operation to be held at shutdown");
      const queued = s.native("devices");
      const queries = await s.count("device-queries");
      const startedAt = Date.now();
      const closing = s.shutdown();
      await until(() => {
        try { process.kill(bridgePid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      }, "a running capture to stop before the shutdown join", 1_500);
      await Promise.race([closing, delay(4_500).then(() => { assert.fail("shutdown exceeded its cleanup budget"); })]);
      assert.ok(Date.now() - startedAt < 4_500);
      assert.ok(s.notifications.some(({ message, level }) => level === "warning" && /shutdown cleanup incomplete/.test(message)));
      assert.ok(stderr.some(message => /shutdown cleanup incomplete/.test(message)));
      assert.match(s.uiState.status, /stopping|cleanup.*pending/i);
      assert.ok(s.uiState.widget);
      startup.release();
      assert.match((await launching).error?.message ?? "", /session is shutting down/);
      await queued;
      assert.equal(await s.count("device-queries"), queries);
      assert.equal(await s.count("launches"), 0);
      assert.equal(await s.count("shutdown-late-command"), 0);
      assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")), []);
      await until(() => s.uiState.status === undefined, "late shutdown cleanup to clear pending UI");
      assert.equal(s.uiState.widget, undefined);
    } finally {
      startup.restore();
      await launching;
    }
  });
}

test("native stop reports pending cleanup when another stop cancels its preparing command", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const startup = holdCaptureStartup(s.logs, "mkdtemp");
  const launching = s.call({ action: "launch", ...s.prebuilt });
  let stopping;
  try {
    await until(startup.entered, "startup to remain held while native stop prepares");
    stopping = s.native(`stop command=": > '${join(s.root, "cancelled-native-stop-command")}'"`);
    await delay(20);
    const repeated = s.call({ action: "stop" });
    await Promise.race([stopping, delay(6_500).then(() => { assert.fail("native preparing stop exceeded its cleanup budget"); })]);
    const message = s.messages.find(message => message.details?.action === "stop");
    assert.equal(message.details.isError, true);
    assert.equal(message.details.cleanupPending, true);
    assert.match(message.content, /cleanup.*pending|cleanup incomplete/i);
    const result = await repeated;
    assert.equal(result.details.cleanupPending, true);
    assert.match(result.content[0].text, /cancelled 1 operation/);
    assert.match(s.uiState.status, /stopping|cleanup.*pending/i);
    startup.release();
    assert.equal((await launching).isError, true);
    assert.equal(await s.count("cancelled-native-stop-command"), 0);
    assert.equal(await s.count("launches"), 0);
    assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")), []);
    await until(() => s.uiState.status === undefined, "cancelled preparing stop cleanup to finish");
  } finally {
    startup.restore();
    await Promise.allSettled([launching, stopping]);
  }
});



test("unknown arguments and invalid types are rejected before any device work", async t => {
  const s = await session(t);
  await assert.rejects(s.call({ action: "status", typo: true }), /unknown.*typo/i);
  await assert.rejects(s.call({ action: "status", since: "3" }), /since/);
  await assert.rejects(s.call({ action: "launch", ...s.prebuilt, unexpected: 1 }), /unknown.*unexpected/i);
  assert.equal(await s.count("launches"), 0);
});

test("a second wait uses the delivered cursor and explicit since=0 can replay old evidence", { timeout: 15000 }, async t => {
  const s = await session(t);
  const id = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  const first = await s.ok({ action: "wait", captureId: id, match: "instance 1 logging", timeoutSeconds: 1 });
  assert.equal(first.details.matched, 1);
  const second = await s.call({ action: "wait", captureId: id, match: "instance 1 logging", timeoutSeconds: 1 });
  assert.equal(second.isError, true, second.content[0].text);
  assert.match(second.content[0].text, /timed out/);
  const replay = await s.ok({ action: "wait", captureId: id, match: "instance 1 logging", since: 0 });
  assert.match(replay.content[0].text, /predates this wait/);
});

test("absence assertion passes only a complete live interval and fails on a forbidden line", { timeout: 15000 }, async t => {
  const s = await session(t);
  const id = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  const passed = await s.ok({ action: "wait", captureId: id, match: "NEVER_LOGGED", absent: true, timeoutSeconds: 1 });
  assert.equal(passed.details.assertion, "absent");
  assert.match(passed.content[0].text, /no matching line observed/);
  const forbidden = await s.call({ action: "wait", captureId: id, match: "instance 1 logging", absent: true, since: 0, timeoutSeconds: 1 });
  assert.equal(forbidden.isError, true);
  assert.match(forbidden.content[0].text, /forbidden/);
  await s.ok({ action: "stop", captureId: id });
  const incomplete = await s.call({ action: "wait", captureId: id, match: "NEVER_LOGGED", absent: true, timeoutSeconds: 1 });
  assert.equal(incomplete.isError, true);
  assert.match(incomplete.content[0].text, /inconclusive/);
});

test("run records survive a new server session and bind command, build and capture identity", { timeout: 20000 }, async t => {
  const s = await session(t);
  const started = await s.ok({ action: "launch", ...s.built });
  const id = started.details.capture.id;
  const run = await s.call({ action: "await", captureId: id, command: "exit 7 # private-run-argument" });
  assert.equal(run.details.exitCode, 7);
  await assert.rejects(s.call({ action: "history", captureId: id, command: "exit 0" }), /read-only/);
  const first = await s.call({ action: "history", captureId: id });
  assert.ok(!first.isError, first.content[0].text);
  assert.equal(first.details.runs[0].captureId, id);
  assert.equal(first.details.runs[0].command.exitCode, 7);
  assert.ok(first.details.runs[0].gitHead);
  assert.ok(first.details.runs[0].fingerprint);
  assert.equal(first.details.runs[0].build.source, "built");
  assert.match(first.details.runs[0].build.logFile, /build-.*\.log$/);
  assert.equal(first.details.runs[0].command.label, "exit");
  assert.match(first.details.runs[0].command.sha256, /^[a-f0-9]{64}$/);
  const stored = await readFile(join(s.logs, "runs", `${id}.json`), "utf8");
  assert.doesNotMatch(stored, /private-run-argument/);
  assert.equal(first.details.runs[0].running, false);
  await s.shutdown();
  let tool;
  const hooks = new Map();
  xcodebug({ cwd: s.repo, registerTool(value) { tool = value; }, on(name, fn) { hooks.set(name, fn); }, registerCommand() {}, sendMessage() {} });
  const context = { cwd: s.repo, agentDir: join(s.root, "agent"), hasUI: false, ui: { setStatus() {}, setWidget() {}, notify() {} } };
  try {
    const result = await tool.execute("history", { action: "history", captureId: id }, undefined, undefined, context);
    assert.equal(result.details.runs[0].captureId, id);
    assert.equal(result.details.runs[0].command.exitCode, 7);
    assert.equal(result.details.runs[0].logFile, started.details.capture.logFile);
  } finally { await hooks.get("session_shutdown")(); }
});

test("session shutdown removes an owned launch result without waiting for its held read", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const metadata = holdLaunchResult(s.root);
  try {
    await s.ok({ action: "launch", ...s.prebuilt });
    await s.flag("die");
    await until(metadata.entered, "the owned launch-result read to be held");
    assert.equal((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")).length, 1);

    await s.shutdown();
    assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")), []);
    await assert.rejects(s.call({ action: "logs" }), /No active capture/);
    assert.equal(await s.count("launches"), 1, "shutdown must not restart the app to finish diagnostics");
  } finally {
    metadata.restore();
  }
});

test("session shutdown cleans pending results after their capture leaves visible history", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const metadata = holdLaunchResult(s.root);
  try {
    const first = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
    await s.flag("die");
    await until(metadata.entered, "the first capture's owned result read to be held");
    await s.ok({ action: "stop", captureId: first });
    for (let index = 0; index < 11; index++) {
      const cycled = (await s.ok({ action: "syslog", device: "test-device", processName: "Cycle" })).details.capture.id;
      await s.ok({ action: "stop", captureId: cycled });
    }
    const visible = (await s.ok({ action: "status" })).details.captures;
    assert.equal(visible.some(capture => capture.id === first), false, "the old capture must actually be evicted");
    assert.equal((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")).length, 1);

    await s.shutdown();
    assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")), []);
    assert.equal(await s.count("launches"), 1);
  } finally {
    metadata.restore();
  }
});

test("session shutdown reports failed result deletion even after history eviction", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const original = fs.promises.unlink;
  t.mock.method(fs.promises, "unlink", async (path, ...args) => {
    if (String(path).startsWith(join(s.logs, ".xcodebug-launch-")) && String(path).endsWith("/launch.json")) {
      throw Object.assign(new Error("owned result removal denied"), { code: "EACCES" });
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  const stderr = [];
  t.mock.method(console, "error", (...args) => { stderr.push(args.map(String).join(" ")); });
  try {
    const first = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
    await s.flag("die");
    await until(async () => (await s.capture()).error?.includes("owned result removal denied"), "owned result deletion to fail");
    await s.ok({ action: "stop", captureId: first });
    const [resultDirectory] = (await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-"));
    const path = join(s.logs, resultDirectory);
    const raw = await readFile(join(path, "launch.json"), "utf8");
    for (let index = 0; index < 11; index++) {
      const cycled = (await s.ok({ action: "syslog", device: "test-device", processName: "Cycle" })).details.capture.id;
      await s.ok({ action: "stop", captureId: cycled });
    }
    assert.equal((await s.ok({ action: "status" })).details.captures.some(capture => capture.id === first), false);

    await s.shutdown();
    assert.equal(await readFile(join(path, "launch.json"), "utf8"), raw);
    assert.deepEqual((await readdir(path)).sort(), ["launch.json", "owner.json"], "failed deletion must retain ownership proof");
    const warning = s.notifications.find(notification => notification.level === "warning" && notification.message.includes(first));
    assert.ok(warning, "session exit must report the evicted capture's failed deletion");
    assert.ok(warning.message.includes(path));
    assert.match(warning.message, /cleanup incomplete:.*owned result removal denied/);
    assert.ok(stderr.some(message => message === warning.message), "headless hosts must receive the same cleanup warning");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("session shutdown joins an unregistered launch startup and prevents a late bridge", { timeout: 20_000 }, async t => {
  const s = await session(t);
  const original = fs.promises.mkdtemp;
  let directoryCreated;
  const created = new Promise(resolve => { directoryCreated = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  fs.promises.mkdtemp = async (...args) => {
    const path = await original(...args);
    if (String(args[0]).startsWith(join(s.logs, ".xcodebug-launch-"))) {
      directoryCreated(path);
      await pending;
    }
    return path;
  };
  syncBuiltinESMExports();
  const launching = s.call({ action: "launch", ...s.prebuilt }).then(value => ({ value }), error => ({ error }));
  try {
    await created;
    await assert.rejects(s.call({ action: "logs" }), /No active capture/);
    let closed = false;
    const closing = s.shutdown().then(() => { closed = true; });
    await delay(20);
    assert.equal(closed, false, "shutdown must join directory creation before claiming cleanup is complete");
    release();
    await closing;
    assert.match((await launching).error?.message ?? "", /session is shutting down/);
    assert.equal(await s.count("launches"), 0, "the pending launch must never spawn after shutdown");
    assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith(".xcodebug-launch-")), []);
    await assert.rejects(s.call({ action: "logs" }), /No active capture/);
  } finally {
    release();
    await launching;
    fs.promises.mkdtemp = original;
    syncBuiltinESMExports();
  }
});

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

  // Replay the original interval to compare regex and substring matching.
  assert.match(await s.text({ action: "wait", captureId, since: 0, match: "^EARLY_(MARKER|FAILURE) ", regex: true, timeoutSeconds: 5 }), /^matched 1 line/);
  const literal = await s.call({ action: "wait", captureId, since: 0, match: "^EARLY_(MARKER|FAILURE) ", timeoutSeconds: 1 });
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
  assert.match(waited.content[0].text, /capture ended before "NEVER_LOGGED" appeared/);
  assert.match(waited.content[0].text, /system termination: FRONTBOARD 0x8BADF00D: scene-create watchdog transgression/);
  assert.match(waited.content[0].text, /crash report: \S+Probe-2026-11-19-101010\.ips/);
  assert.equal(waited.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");

  const ended = await s.capture();
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

test("an interrupted command returns the system cause and report before replying", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  await s.flag("crash-pid", "4001");
  await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
  const result = await s.call({ action: "await", captureId,
    command: `: > '${join(s.root, "die")}'; sleep 1.5; exit 7` });
  assert.equal(result.isError, true);
  assert.equal(result.details.exitCode, 7);
  assert.match(result.content[0].text, /system termination: FRONTBOARD 0x8BADF00D: scene-create watchdog transgression/);
  assert.match(result.content[0].text, /crash report: \S+Probe-2026-11-19-101010\.ips/);
  assert.equal(result.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
});

test("command completion stops pending reattach before collecting crash evidence", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const launched = await s.ok({ action: "launch", ...s.prebuilt });
  const result = await s.call({ action: "await", captureId: launched.details.capture.id,
    command: `: > '${join(s.root, "drop")}'; while kill -0 ${launched.details.capture.pid} 2>/dev/null; do sleep 0.01; done; exit 7` });
  assert.equal(result.isError, true);
  assert.equal(result.details.exitCode, 7);
  assert.equal(result.details.terminationReason, "unavailable: the device returned no matching crash report");
  assert.equal(result.details.crashReport, undefined);
  assert.equal(await s.count("launches"), 1, "the finished command must not restart the app while waiting for reports");
  assert.equal(Number(await readFile(join(s.root, "pid"), "utf8")), launched.details.capture.appPid);
  assert.doesNotMatch(result.content[0].text, /relaunched the app/);
  assert.equal((await s.capture()).running, false);
});

test("a late process-table snapshot of a foreign instance cannot bind its crash report", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const metadata = holdLaunchResult(s.root);
  try {
    await s.flag("late-table");
    await s.flag("delayed-table-snapshot");
    const launching = s.call({ action: "launch", ...s.prebuilt });
    await until(() => readFile(join(s.root, "table-started")).then(() => true, () => false), "the launch PID query to be held before its snapshot");
    const captureId = (await s.capture()).id;
    await s.flag("pid", "9999\n");
    await s.flag("crash-pid", "9999");
    await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
    await s.flag("table-snapshot-release");
    await until(() => readFile(join(s.root, "table-snapshotted")).then(() => true, () => false), "the foreign process snapshot to be saved");
    const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED" });
    await s.flag("drop");
    await until(metadata.entered, "the original launch result read to remain pending after bridge exit");
    await s.flag("table-release");
    await launching;
    metadata.release();
    const result = await waiting;
    assert.equal(result.details.crashReport, undefined);
    assert.doesNotMatch(result.content[0].text, /FRONTBOARD|crash report: /);
    const ended = await s.capture();
    assert.equal(ended.appPid, 4001, "owned launch metadata identifies the original instance, not the late table snapshot");
    assert.equal(ended.crashReport, undefined);
    assert.equal(Number(await readFile(join(s.root, "pid"), "utf8")), 9999, "the foreign instance is left alone");
    assert.equal(await s.count("launches"), 1);
    assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith("crash-")), []);
  } finally {
    metadata.restore();
  }
});

test("an already waiting command joins pending launch identity and its matching report", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const metadata = holdLaunchResult(s.root);
  await s.flag("bad-table");
  try {
    const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
    await s.flag("crash-pid", "4001");
    await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
    let settled = false;
    const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED" });
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await s.flag("die");
    await until(metadata.entered, "the genuine launch result I/O completion to be held");
    await until(async () => !(await s.capture()).running, "the console drain to finish while launch identity is pending");
    await delay(0);
    assert.equal(settled, false, "wait must not reply while exit identity is still unresolved");
    metadata.release();
    const result = await waiting;
    assert.equal(result.isError, true);
    assert.equal(result.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
    assert.match(await readFile(result.details.crashReport, "utf8"), /"pid" : 4001,/);
    assert.equal((await s.capture()).appPid, 4001);
    assert.doesNotMatch(result.content[0].text, /identity.*not verified|unavailable:/);
  } finally {
    metadata.restore();
  }
});

test("caller cancellation interrupts pending launch identity without discarding the exit diagnosis", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const metadata = holdLaunchResult(s.root);
  const controller = new AbortController();
  try {
    await s.flag("bad-table");
    const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
    await s.flag("crash-pid", "4001");
    await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
    const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED" }, controller.signal);
    await s.flag("die");
    await until(metadata.entered, "launch identity I/O to remain pending");
    await until(async () => !(await s.capture()).running, "the console drain to finish");
    controller.abort();
    const cancelled = await waiting;
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.content[0].text, /cancelled while waiting/);
    metadata.release();
    const ended = await until(async () => {
      const capture = await s.capture();
      return capture.crashReport ? capture : undefined;
    }, "the independently owned diagnosis to finish after cancellation");
    assert.equal(ended.appPid, 4001);
    assert.equal(ended.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
    assert.match(await readFile(ended.crashReport, "utf8"), /"pid" : 4001,/);
  } finally {
    metadata.restore();
  }
});

test("wait deadline includes a pending native exit diagnosis without a caller signal", { timeout: 15000 }, async t => {
  const s = await session(t);
  const metadata = holdLaunchResult(s.root);
  let timer;
  try {
    await s.flag("bad-table");
    const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
    const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED", timeoutSeconds: 1 });
    await s.flag("die");
    await until(metadata.entered, "the exit diagnosis to wait for owned launch metadata");
    const result = await Promise.race([waiting, new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
    assert.ok(result, "the wait deadline must include pending exit diagnostics");
    assert.equal(result.isError, true);
    assert.equal(result.details.crashReport, undefined);
  } finally {
    clearTimeout(timer);
    metadata.restore();
  }
});

test("an exit report cancels an in-flight stale process query before it can relaunch", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  await s.flag("stale-table");
  await s.flag("drop");
  await until(async () => readFile(join(s.root, "table-started")).then(() => true, () => false), "the stale process query to start");
  await s.flag("crash-pid", "4001");
  await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
  await rm(join(s.root, "pid"));
  const result = await s.call({ action: "wait", captureId, match: "NEVER_LOGGED" });
  assert.equal(result.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
  const queryPid = Number(await readFile(join(s.root, "table-pid"), "utf8"));
  await until(() => {
    try { process.kill(queryPid, 0); return false; } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
  }, "the obsolete process query to be cancelled");
  await s.flag("table-release");
  assert.equal(await s.count("launches"), 1, "a confirmed exit must never restart the app");
  assert.equal((await s.capture()).terminationReason, result.details.terminationReason);
});

test("an immediately failing driver retains natural exit evidence while pipes drain", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const launched = await s.ok({ action: "launch", ...s.prebuilt });
  await s.flag("hold-pipes");
  await s.flag("crash-pid", "4001");
  await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
  const result = await s.call({ action: "await", captureId: launched.details.capture.id,
    command: `: > '${join(s.root, "die")}'; while kill -0 ${launched.details.capture.pid} 2>/dev/null; do sleep 0.01; done; exit 7` });
  await s.flag("drain-release");
  assert.equal(result.details.exitCode, 7);
  assert.equal(result.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
  assert.match(result.content[0].text, /system termination: FRONTBOARD 0x8BADF00D/);
  assert.match(await readFile(result.details.crashReport, "utf8"), /"pid" : 4001,/);
});

test("an unavailable process table does not hide the owned launch identity or its report", { timeout: 30_000 }, async t => {
  const s = await session(t);
  await s.flag("bad-table");
  const launched = await s.ok({ action: "launch", ...s.prebuilt });
  assert.equal(launched.details.capture.appPid, undefined);
  await s.flag("crash-pid", "4001");
  await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
  const waiting = s.call({ action: "wait", captureId: launched.details.capture.id, match: "NEVER_LOGGED" });
  await s.flag("die");
  const result = await waiting;
  assert.equal(result.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
  assert.match(await readFile(result.details.crashReport, "utf8"), /"pid" : 4001,/);
  assert.equal((await s.capture()).appPid, 4001);
});

test("missing or malformed native launch results never fall back to table PID or app name", { timeout: 60_000 }, async t => {
  const nativeResult = { info: { commandType: "devicectl.device.process.launch", outcome: "success" },
    result: { process: { processIdentifier: 4001, executable: "/private/X/Probe.app/Probe" } } };
  const cases = [
    { name: "missing result", missing: true },
    { name: "invalid JSON", content: '{"info":' },
    { name: "wrong command", content: JSON.stringify({ ...nativeResult, info: { ...nativeResult.info, commandType: "devicectl.device.info.processes" } }) },
    { name: "failed outcome", content: JSON.stringify({ ...nativeResult, info: { ...nativeResult.info, outcome: "failed" } }) },
    { name: "missing process", content: JSON.stringify({ ...nativeResult, result: {} }) },
    { name: "invalid PID", content: JSON.stringify({ ...nativeResult, result: { process: { ...nativeResult.result.process, processIdentifier: 0 } } }) },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const s = await session(t);
    if (entry.missing) await s.flag("no-launch-result");
    else await s.flag("launch-result", entry.content);
    const launched = await s.ok({ action: "launch", ...s.prebuilt });
    assert.equal(launched.details.capture.appPid, 4001, "the operational process-table PID is available before exit");
    await s.flag("crash-pid", "4001");
    await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
    const waiting = s.call({ action: "wait", captureId: launched.details.capture.id, match: "NEVER_LOGGED" });
    await s.flag("die");
    const result = await waiting;
    assert.match(result.details.terminationReason, /unavailable:.*identity.*not verified/);
    assert.equal(result.details.crashReport, undefined);
    assert.doesNotMatch(result.content[0].text, /FRONTBOARD|crash report: /);
    assert.deepEqual((await readdir(s.logs)).filter(name => name.startsWith("crash-")), []);
  });
});

test("an interrupted reattached app reports its own crash, not the previous bridge's search", { timeout: 60_000 }, async t => {
  const s = await session(t);
  const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  await s.flag("drop");
  await until(async () => {
    const capture = await s.capture();
    return capture.running && capture.relaunches === 1 && capture.appPid === 4002;
  }, "the reattached instance to start");
  const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED" });
  await s.flag("crash-pid", "4002");
  await s.flag("crash-name", "Probe-2026-11-19-111111.ips");
  await s.flag("die");
  const result = await waiting;
  assert.equal(result.details.terminationReason, "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression");
  assert.match(await readFile(result.details.crashReport, "utf8"), /"pid" : 4002,/);
});

test("crash evidence collection remains cancellable", { timeout: 30_000 }, async t => {
  const s = await session(t);
  const captureId = (await s.ok({ action: "launch", ...s.prebuilt })).details.capture.id;
  const controller = new AbortController();
  const waiting = s.call({ action: "wait", captureId, match: "NEVER_LOGGED" }, controller.signal);
  await s.flag("die");
  await until(async () => (await s.capture()).endReason, "app death to be confirmed");
  controller.abort();
  const result = await waiting;
  assert.match(result.content[0].text, /cancelled while waiting/);
});

test("stopping during launch PID discovery never opens a syslog companion", { timeout: 30_000 }, async t => {
  const s = await session(t);
  await s.flag("slow-table");
  await s.flag("crash-pid", "4001");
  await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
  const launching = s.call({ action: "launch", ...s.prebuilt, dualChannel: true }, new AbortController().signal);
  await until(async () => (await s.count("launches")) === 1, "the console launch to start");
  await s.ok({ action: "stop", keepApp: true });
  await launching;
  const status = await s.ok({ action: "status" });
  assert.equal(status.details.captures.some(capture => capture.running), false, "stop must leave no background log channel");
  assert.equal(status.details.captures.some(capture => capture.terminationReason || capture.crashReport), false,
    "a manually stopped bridge must not initiate a crash search even if a candidate report exists");
});

test("crash metadata uses the report PID and supports standalone and Apple JSON", { timeout: 30_000 }, async t => {
  const cases = [
    { name: "standalone JSON", content: JSON.stringify({ pid: 4001, termination: { namespace: "SIGNAL", code: 11, indicator: "Segmentation fault: 11" } }), expected: "SIGNAL 0xB: Segmentation fault: 11" },
    { name: "empty reasons with indicator", content: JSON.stringify({ pid: 4001, termination: { namespace: "SIGNAL", code: 6, reasons: [], indicator: "Abort trap: 6" } }), expected: "SIGNAL 0x6: Abort trap: 6" },
    { name: "Apple header", content: '{"bug_type":"309"}\n' + JSON.stringify({ pid: 4001, termination: { namespace: "FRONTBOARD", code: "0x8BADF00D", reasons: [null, "scene-create watchdog transgression"] } }), expected: "FRONTBOARD 0x8BADF00D: scene-create watchdog transgression" },
    { name: "missing termination", content: JSON.stringify({ pid: 4001 }), expected: undefined },
    { name: "malformed JSON", content: '{"pid":4001,', rejected: true },
    { name: "another process nested in the report", content: JSON.stringify({ pid: 9999, child: { pid: 4001 } }), rejected: true },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const s = await session(t);
    await mkdir(s.logs, { recursive: true });
    await s.flag("crash-name", "Probe-2026-11-19-101010.ips");
    await s.flag("crash-pid", "4001");
    await s.flag("crash-content", entry.content);
    const report = await pullCrashReport({ id: "test-device" }, "Probe", { since: Date.now() - 5000, pid: 4001, directory: s.logs });
    if (entry.rejected) assert.equal(report, undefined);
    else {
      assert.equal(report.terminationReason, entry.expected);
      assert.equal(await readFile(report.path, "utf8"), entry.content);
    }
  });
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
