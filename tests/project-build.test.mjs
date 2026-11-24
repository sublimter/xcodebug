import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import xcodebug from "../index.ts";

const device = { identifier: "fixture-device", properties: {
  hardware: { udid: "fixture-udid", reality: "physical" },
  connection: { state: "connected", transportType: "wired" }, state: { name: "Fixture" },
} };

async function session(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcodebug-project-actions-")));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const out = join(root, "products");
  for (const dir of [repo, bin, join(out, "Host.app")]) await mkdir(dir, { recursive: true });
  const write = async (path, text) => {
    const file = join(repo, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const cli = (name, body) => writeFile(join(bin, name), `#!/usr/bin/env node\nconst fs = require('node:fs');\n` +
    `const args = process.argv.slice(2); const root = ${JSON.stringify(root)};\n` +
    `fs.appendFileSync(root + '/calls', JSON.stringify({name: ${JSON.stringify(name)}, args, cwd: process.cwd()}) + '\\n');\n` + body,
  { mode: 0o755 });
  await cli("xcrun", `if (args.includes('devices')) console.log(${JSON.stringify(JSON.stringify({ result: { devices: [device] } }))});
else if (args.includes('launch')) setInterval(() => {}, 60000);
else if (args.includes('processes')) console.log('{"result":{"runningProcesses":[]}}');`);
  const settings = [{ target: "Host", buildSettings: {
    PRODUCT_TYPE: "com.apple.product-type.application", PLATFORM_NAME: "iphoneos", WRAPPER_NAME: "Host.app",
    TARGET_BUILD_DIR: out, PRODUCT_BUNDLE_IDENTIFIER: "test.host", EXECUTABLE_NAME: "Host",
  } }];
  const setSettings = (rows) => writeFile(join(root, "settings.json"), JSON.stringify(rows));
  await setSettings(settings);
  await cli("xcodebuild", `if (args.includes('-list')) console.log('{"project":{"schemes":["Host"]}}');
else if (args.includes('-showBuildSettings')) process.stdout.write(fs.readFileSync(root + '/settings.json'));
else if (args.includes('-version')) console.log('Xcode fixture');
else if (args.includes('build')) console.log('** BUILD SUCCEEDED **');
else process.exit(2);`);
  await cli("idevicesyslog", `if (args.includes('--version')) console.log('fixture');`);
  await cli("pod", "process.exit(1);");
  execFileSync("git", ["init", "-q", repo]);
  await write("Client/Sources/Feature.swift", "// fixture\n");
  const cwd = join(repo, "Client/Sources");
  const previous = process.env.PATH;
  await symlink(process.execPath, join(bin, "node"));
  await symlink(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  process.env.PATH = bin;
  let tool;
  const hooks = new Map();
  xcodebug({ cwd: repo, registerTool(value) { tool = value; }, registerCommand() {}, sendMessage() {},
    on(name, handler) { hooks.set(name, handler); } });
  const invoke = (action, options = {}, at = cwd) => tool.execute("fixture", { action, push: "off", dualChannel: false, ...options },
    undefined, undefined, { cwd: at, agentDir: join(root, "agent"), hasUI: false, ui: { setStatus() {}, setWidget() {} } });
  const ok = async (...args) => {
    const reply = await invoke(...args);
    assert.ok(!reply.isError, reply.content[0].text);
    return reply;
  };
  const calls = async () => (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
  t.after(async () => {
    try { await invoke("stop"); await hooks.get("session_shutdown")(); }
    finally { process.env.PATH = previous; await rm(root, { recursive: true, force: true }); }
  });
  return { root, repo, cwd, write, cli, invoke, ok, calls, settings, setSettings };
}

test("build resolves the installable iOS app among a scheme's frameworks, extensions, watch and simulator products", async t => {
  const s = await session(t);
  const host = s.settings[0].buildSettings;
  const row = (target, WRAPPER_NAME, overrides) => ({ target, buildSettings: { ...host, WRAPPER_NAME, ...overrides } });
  const others = [
    row("Kit", "Kit.framework", { PRODUCT_TYPE: "com.apple.product-type.framework" }),
    row("Widget", "Widget.appex", { PRODUCT_TYPE: "com.apple.product-type.app-extension" }),
    row("Watch", "Watch.app", { PLATFORM_NAME: "watchos" }),
    row("Simulator", "Simulator.app", { PLATFORM_NAME: "iphonesimulator", SUPPORTED_PLATFORMS: "iphoneos iphonesimulator" }),
    row("Clip", "Clip.app", { PRODUCT_TYPE: "com.apple.product-type.application.on-demand-install-capable" }),
  ];
  const options = { project: "Fixture.xcodeproj", scheme: "Suite", force: true };
  await s.setSettings([...others, ...s.settings]);
  assert.equal((await s.ok("build", options)).details.appPath, join(s.root, "products/Host.app"));
  for (const [rows, error] of [[others, /no installable iOS app/i],
    [[...s.settings, row("Other", "Other.app", {})], /several.*(Host.*Other|Other.*Host)/is]]) {
    await s.setSettings(rows);
    const result = await s.invoke("build", options);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, error);
    assert.equal(result.details.appPath, undefined);
  }
});

test("autocreated scheme probes, builds and changes use the same ordered build arguments and working directory", async t => {
  const s = await session(t);
  await s.write("Client/Host.xcodeproj/project.pbxproj", "{}");
  const flags = ["-xcconfig", "Overrides.xcconfig", "FIRST=one two", "SECOND=1"];
  await s.write("Client/.xcodebug.json", JSON.stringify({ xcodebuildArgs: flags }));
  const first = await s.ok("build");
  assert.equal(first.details.appPath, join(s.root, "products/Host.app"));
  const calls = (await s.calls()).filter(call => call.name === "xcodebuild");
  assert.ok(calls.some(call => call.args.includes("-list")));
  assert.equal(calls.filter(call => call.args.includes("-showBuildSettings")).length, 2);
  for (const call of calls) {
    assert.equal(call.cwd, s.cwd);
    assert.deepEqual(call.args.slice(call.args.indexOf("-xcconfig"), call.args.indexOf("-xcconfig") + flags.length), flags);
  }
  const preview = async (options, at) => (await s.ok("changes", options, at)).content[0].text;
  assert.match(await preview({ extraArgs: flags }), /rebuild needed: no/);
  assert.match(await preview({ xcodebuildArgs: flags.toReversed() }), /rebuild needed: yes/);
  assert.match(await preview({ xcodebuildArgs: [] }), /rebuild needed: yes/);
  assert.match(await preview({}, join(s.repo, "Client")), /rebuild needed: yes/);
  assert.equal((await s.ok("build", { xcodebuildArgs: flags })).details.skipped, true);
});

test("build uses the invocation's nearest config and an explicit project replaces its workspace", async t => {
  const s = await session(t);
  await s.write(".xcodebug.json", JSON.stringify({ scheme: "WrongRoot" }));
  await s.write("Client/.xcodebug.json", JSON.stringify({ workspace: "Suite.xcworkspace", scheme: "Host",
    configuration: "Release", derivedDataPath: "build/cache", xcodebuildArgs: ["SETTING=two words"] }));
  await s.write("Client/Suite.xcworkspace/contents.xcworkspacedata", "<Workspace/>");
  await s.write("Other.xcodeproj/project.pbxproj", "{}");
  await s.ok("build", { project: "../../Other.xcodeproj" });
  const xcode = (await s.calls()).filter(call => call.name === "xcodebuild");
  assert.equal(xcode.length, 2);
  for (const { cwd, args } of xcode) {
    assert.equal(cwd, s.cwd);
    assert.deepEqual(args.slice(0, 9), ["-project", join(s.repo, "Other.xcodeproj"), "-scheme", "Host",
      "-configuration", "Release", "-derivedDataPath", join(s.repo, "Client/build/cache"), "SETTING=two words"]);
  }
});
