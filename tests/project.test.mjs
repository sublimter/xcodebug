import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { detectContainer, readConfig, resolveProjectDirectory, withContainer } from "../project.ts";

async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-project-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    if (content === null) await mkdir(path, { recursive: true });
    else await writeFile(path, content);
  }
  return root;
}

test("a single plain project is found from a source subdirectory", async (t) => {
  const root = await fixture(t, { "App.xcodeproj": null, "Sources/UI": null });
  assert.deepEqual(await detectContainer(join(root, "Sources/UI")), {
    project: join(root, "App.xcodeproj"), cocoaPods: false,
  });
});
test("a project is found above a source directory without Git metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-no-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "App.xcodeproj"));
  const source = join(root, "Sources/UI");
  await mkdir(source, { recursive: true });
  assert.deepEqual(await detectContainer(source), { project: join(root, "App.xcodeproj"), cocoaPods: false });
});

test("a nested demo is found from the repository root and a sibling component", async (t) => {
  const root = await fixture(t, {
    "Examples/iOS/Demo.xcodeproj": null, "Components/Core": null,
    "Pods/Dependency.xcodeproj": null, "node_modules/Other.xcodeproj": null,
    "build/Stale.xcodeproj": null,
  });
  for (const cwd of [root, join(root, "Components/Core")]) {
    assert.equal((await detectContainer(cwd)).project, join(root, "Examples/iOS/Demo.xcodeproj"));
  }
});

test("nearest config resolves paths against its own directory inside a worktree", async (t) => {
  const root = await fixture(t, {
    ".xcodebug.json": JSON.stringify({ scheme: "Root" }),
    "Feature/.xcodebug.json": JSON.stringify({
      workspace: "../App.xcworkspace", derivedDataPath: "cache", scheme: "Feature", xcodebuildArgs: ["SETTING=YES"],
    }),
    "Feature/Sources": null,
  });
  await rm(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git"), "gitdir: /tmp/worktree-metadata\n");
  assert.equal(await resolveProjectDirectory(join(root, "Feature/Sources")), root);
  assert.deepEqual(await readConfig(join(root, "Feature/Sources")), {
    workspace: join(root, "App.xcworkspace"), derivedDataPath: join(root, "Feature/cache"),
    scheme: "Feature", xcodebuildArgs: ["SETTING=YES"],
  });
});

async function xcodebuildFixture(t, root, responses) {
  const bin = join(root, ".tools");
  await mkdir(bin);
  const calls = join(bin, "calls.jsonl");
  const executable = join(bin, "xcodebuild");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const responses = ${JSON.stringify(responses)};
const scheme = args[args.indexOf('-scheme') + 1];
const value = args.includes('-list') ? responses.list : responses[scheme];
if (value === undefined) { process.stderr.write('No fixture response'); process.exit(42); }
const respond = () => {
  process.stdout.write(value.raw ?? JSON.stringify(value));
  process.exit(value.code ?? 0);
};
if (value.delayMs) setTimeout(respond, value.delayMs);
else respond();
`);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  return async () => (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

function applicationSettings(target, extra = {}) {
  return { target, buildSettings: {
    TARGET_NAME: target, PRODUCT_TYPE: "com.apple.product-type.application", WRAPPER_EXTENSION: "app",
    SUPPORTED_PLATFORMS: "iphoneos iphonesimulator", ...extra,
  } };
}

function appScheme(product, extra = "") {
  return `<Scheme>${extra}<LaunchAction><BuildableProductRunnable><BuildableReference BuildableName="${product}.app" BlueprintName="${product}" /></BuildableProductRunnable></LaunchAction></Scheme>`;
}

function schemeManagementPath(container, username = userInfo().username) {
  return `${container}/xcuserdata/${username}.xcuserdatad/xcschemes/xcschememanagement.plist`;
}

function schemeManagement(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>SchemeUserState</key><dict>${
    Object.entries(entries).map(([name, shown], index) => `<key>${name}.xcscheme_^#shared#^_</key><dict><key>orderHint</key><integer>${index}</integer>${
      shown === undefined ? "" : `<key>isShown</key><${shown ? "true" : "false"}/>`
    }</dict>`).join("")
  }</dict></dict></plist>`;
}

function probedSchemes(calls) {
  return calls.filter((args) => args.includes("-showBuildSettings")).map((args) => args[args.indexOf("-scheme") + 1]);
}

test("a non-pod workspace follows differently named referenced projects and ignores test-only app references", async (t) => {
  const root = await fixture(t, {
    "Suite.xcworkspace/contents.xcworkspacedata": '<Workspace><Group location="group:Apps"><FileRef location="group:Host.xcodeproj" /></Group></Workspace>',
    "Apps/Host.xcodeproj/xcshareddata/xcschemes/Run.xcscheme": appScheme("Host"),
    "Apps/Host.xcodeproj/xcshareddata/xcschemes/Tests.xcscheme": '<Scheme><TestAction><BuildableReference BuildableName="Wrong.app" /></TestAction></Scheme>',
    "Apps/Host.xcodeproj/project.xcworkspace": null,
  });
  await xcodebuildFixture(t, root, { list: { workspace: { schemes: ["Run", "Tests"] } },
    Run: [applicationSettings("Host")], Tests: [{ target: "Tests", buildSettings: { PRODUCT_TYPE: "com.apple.product-type.bundle.unit-test" } }] });
  const target = await withContainer(root, {}, {});
  assert.equal(target.workspace, join(root, "Suite.xcworkspace"));
  assert.equal(target.project, undefined);
  assert.equal(target.scheme, "Run");
});

test("autocreated schemes are verified as iOS applications rather than guessed from container names", async (t) => {
  const root = await fixture(t, { "Library.xcodeproj": null });
  const calls = await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Library", "Runner", "RunnerTests", "Watch", "Clip"] } },
    Library: [{ target: "Library", buildSettings: { PRODUCT_TYPE: "com.apple.product-type.framework" } }, applicationSettings("Dependency")],
    Runner: [applicationSettings("Runner")],
    RunnerTests: [{ target: "RunnerTests", buildSettings: { PRODUCT_TYPE: "com.apple.product-type.bundle.unit-test", WRAPPER_EXTENSION: "xctest" } }],
    Watch: [applicationSettings("Watch", { SUPPORTED_PLATFORMS: "watchos watchsimulator", PRODUCT_TYPE: "com.apple.product-type.application.watchapp2" })],
    Clip: [applicationSettings("Clip", { PRODUCT_TYPE: "com.apple.product-type.application.on-demand-install-capable" })],
  });
  const target = await withContainer(root, {}, {});
  assert.equal(target.scheme, "Runner");
  assert.deepEqual(target.extraArgs, undefined, "no implicit package-validation bypasses");
  const invocations = await calls();
  assert.equal(invocations.filter((args) => args.includes("-list")).length, 1);
  assert.equal(invocations.filter((args) => args.includes("-showBuildSettings")).length, 5);
  assert.ok(invocations.every((args) => !args.some((arg) => /skip.*Validation/i.test(arg))));
});
test("automatic scheme discovery skips a probe failure and checks later schemes", async (t) => {
  const root = await fixture(t, { "App.xcodeproj": null });
  await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Broken", "Runner"] } },
    Broken: { code: 74, raw: "xcodebuild: error: unavailable\n" },
    Runner: [applicationSettings("Runner")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "Runner");
});

test("a pure Swift package requires a host iOS app but a host may use SPM", async (t) => {
  const root = await fixture(t, { "Package.swift": "// swift-tools-version: 6.0", "Sources/Kit": null });
  await assert.rejects(withContainer(join(root, "Sources/Kit"), {}, { scheme: "Kit" }), /Package\.swift.*requires.*host iOS app/i);
  await mkdir(join(root, "Host.xcodeproj/xcshareddata/xcschemes"), { recursive: true });
  await writeFile(join(root, "Host.xcodeproj/xcshareddata/xcschemes/Host.xcscheme"), appScheme("Host"));
  await xcodebuildFixture(t, root, { list: { project: { schemes: ["Host"] } }, Host: [applicationSettings("Host")] });
  assert.equal((await withContainer(root, {}, {})).scheme, "Host");
});

test("automatic discovery ignores a hosted test scheme for the same app", async (t) => {
  const root = await fixture(t, {
    "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": appScheme("App"),
    "App.xcodeproj/xcshareddata/xcschemes/AppTests.xcscheme": appScheme("App"),
  });
  await xcodebuildFixture(t, root, { list: { project: { schemes: ["App", "AppTests"] } },
    App: [applicationSettings("App")],
    AppTests: [{ target: "AppTests", buildSettings: { PRODUCT_TYPE: "com.apple.product-type.bundle.unit-test", WRAPPER_EXTENSION: "xctest" } }, applicationSettings("App")] });
  assert.equal((await withContainer(root, {}, {})).scheme, "App");
});

test("explicit container selection replaces the other config kind and bypasses detection ambiguity", async (t) => {
  const root = await fixture(t, { "A.xcworkspace": null, "B.xcworkspace": null });
  const target = await withContainer(root, { workspace: "Configured.xcworkspace", xcodebuildArgs: ["CONFIG=YES"] }, {
    project: "Probe.xcodeproj", scheme: "Probe", xcodebuildArgs: ["PARAM=YES"],
  });
  assert.equal(target.project, join(root, "Probe.xcodeproj"));
  assert.equal(target.workspace, undefined);
  assert.equal(target.scheme, "Probe");
  assert.deepEqual(target.extraArgs, ["PARAM=YES"]);
  assert.match(target.source, /explicit project/);
  const workspace = await withContainer(root, { project: "Old.xcodeproj" }, {
    workspace: "Chosen.xcworkspace", scheme: "Chosen",
  });
  assert.equal(workspace.workspace, join(root, "Chosen.xcworkspace"));
  assert.equal(workspace.project, undefined);
  await assert.rejects(withContainer(root, {}, { workspace: "A.xcworkspace", project: "B.xcodeproj" }),
    /workspace.*project.*mutually exclusive/i);
});

test("Show filtering excludes hundreds of hidden and unrecorded dependency schemes before the probe limit", async (t) => {
  const dependencies = Array.from({ length: 700 }, (_, index) => `Dependency${index}`);
  const root = await fixture(t, {
    "Suite.xcworkspace/contents.xcworkspacedata": '<Workspace><FileRef location="group:Host.xcodeproj" /><FileRef location="group:Pods/Pods.xcodeproj" /></Workspace>',
    [schemeManagementPath("Host.xcodeproj")]: schemeManagement({ Run: true, Watch: true }),
    [schemeManagementPath("Pods/Pods.xcodeproj")]: schemeManagement(Object.fromEntries(dependencies.slice(0, 350).map((name) => [name, false]))),
    "Host.xcodeproj/xcshareddata/xcschemes/Run.xcscheme": appScheme("Run"),
    "Pods/Pods.xcodeproj/xcshareddata/xcschemes/Dependency0.xcscheme": appScheme("Dependency0"),
    "Pods/Pods.xcodeproj/xcshareddata/xcschemes/Dependency699.xcscheme": appScheme("Dependency699"),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { workspace: { schemes: [...dependencies, "Watch", "Run"] } },
    ...Object.fromEntries(dependencies.map((name) => [name, [applicationSettings(name)]])),
    Watch: [applicationSettings("Watch", { SUPPORTED_PLATFORMS: "watchos watchsimulator", PRODUCT_TYPE: "com.apple.product-type.application.watchapp2" })],
    Run: [applicationSettings("Run")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "Run");
  const probes = probedSchemes(await calls());
  assert.ok(probes.includes("Run"));
  assert.ok(probes.every((scheme) => scheme === "Run" || scheme === "Watch"), `unexpected dependency probes: ${probes}`);
});

test("a shown owning-project-name iOS app wins before probing other shown workspace apps", async (t) => {
  const otherApps = Array.from({ length: 20 }, (_, index) => `OtherApp${index}`);
  const root = await fixture(t, {
    "Suite.xcworkspace/contents.xcworkspacedata": '<Workspace><Group location="group:Apps"><FileRef location="group:ZeppDevice.xcodeproj" /></Group><Group location="container:Components"><FileRef location="group:Other.xcodeproj" /></Group></Workspace>',
    [schemeManagementPath("Apps/ZeppDevice.xcodeproj")]: schemeManagement({ ZeppDevice: true }),
    [schemeManagementPath("Components/Other.xcodeproj")]: schemeManagement(Object.fromEntries(otherApps.map((name) => [name, true]))),
    "Apps/ZeppDevice.xcodeproj/xcshareddata/xcschemes/ZeppDevice.xcscheme": appScheme("ZeppDevice"),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { workspace: { schemes: [...otherApps, "ZeppDevice"] } },
    ...Object.fromEntries(otherApps.map((name) => [name, [applicationSettings(name)]])),
    ZeppDevice: [applicationSettings("ZeppDevice")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "ZeppDevice");
  assert.deepEqual(probedSchemes(await calls()), ["ZeppDevice"]);
});

test("a hidden project-name app cannot win automatic scheme preference", async (t) => {
  const root = await fixture(t, {
    [schemeManagementPath("Host.xcodeproj")]: schemeManagement({ Host: false, Run: true }),
    "Host.xcodeproj/xcshareddata/xcschemes/Host.xcscheme": appScheme("Host"),
    "Host.xcodeproj/xcshareddata/xcschemes/Run.xcscheme": appScheme("Run"),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Host", "Run"] } },
    Host: [applicationSettings("Host")], Run: [applicationSettings("Run")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "Run");
  assert.deepEqual(probedSchemes(await calls()), ["Run"]);
});

test("a SchemeUserState entry without isShown is shown by default", async (t) => {
  const root = await fixture(t, {
    [schemeManagementPath("Host.xcodeproj")]: schemeManagement({ Run: undefined, Hidden: false }),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Hidden", "Run", "Unrecorded"] } },
    Hidden: [applicationSettings("Hidden")], Run: [applicationSettings("Run")], Unrecorded: [applicationSettings("Unrecorded")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "Run");
  assert.deepEqual(probedSchemes(await calls()), ["Run"]);
});

test("scheme visibility uses current-user metadata rather than another user's choices", async (t) => {
  const root = await fixture(t, {
    [schemeManagementPath("Host.xcodeproj")]: schemeManagement({ Host: false, Run: true, Other: false }),
    [schemeManagementPath("Host.xcodeproj", `other-${userInfo().username}`)]: schemeManagement({ Host: true, Run: false, Other: true }),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Host", "Other", "Run"] } },
    Host: [applicationSettings("Host")], Other: [applicationSettings("Other")], Run: [applicationSettings("Run")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "Run");
  assert.deepEqual(probedSchemes(await calls()), ["Run"]);
});

test("other-user-only metadata does not suppress Xcode's default-visible fallback", async (t) => {
  const root = await fixture(t, {
    [schemeManagementPath("Host.xcodeproj", `other-${userInfo().username}`)]: schemeManagement({ Run: false }),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Run"] } }, Run: [applicationSettings("Run")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "Run");
  assert.deepEqual(probedSchemes(await calls()), ["Run"]);
});

test("workspace management overrides matching project visibility in both directions", async (t) => {
  const root = await fixture(t, {
    "Suite.xcworkspace/contents.xcworkspacedata": '<Workspace><FileRef location="group:Host.xcodeproj" /></Workspace>',
    [schemeManagementPath("Host.xcodeproj")]: schemeManagement({ ProjectShown: true, WorkspaceShown: false }),
    [schemeManagementPath("Suite.xcworkspace")]: schemeManagement({ ProjectShown: false, WorkspaceShown: true }),
    "Host.xcodeproj/xcshareddata/xcschemes/ProjectShown.xcscheme": appScheme("ProjectShown"),
    "Host.xcodeproj/xcshareddata/xcschemes/WorkspaceShown.xcscheme": appScheme("WorkspaceShown"),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { workspace: { schemes: ["ProjectShown", "WorkspaceShown"] } },
    ProjectShown: [applicationSettings("ProjectShown")], WorkspaceShown: [applicationSettings("WorkspaceShown")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "WorkspaceShown");
  assert.deepEqual(probedSchemes(await calls()), ["WorkspaceShown"]);
});

test("MiFit selects MiDong when two shown schemes launch its Zepp target", async (t) => {
  const root = await fixture(t, {
    "MiFit.xcworkspace/contents.xcworkspacedata": '<Workspace><FileRef location="group:MiFit.xcodeproj" /><FileRef location="group:Pods/Pods.xcodeproj" /></Workspace>',
    [schemeManagementPath("MiFit.xcodeproj")]: schemeManagement({ MiFit: false, MiDong: true, MiFitWatch: true }),
    [schemeManagementPath("MiFit.xcworkspace")]: schemeManagement({ "Generate Project": true }),
    [schemeManagementPath("Pods/Pods.xcodeproj")]: schemeManagement({ Dependency: false }),
    "MiFit.xcodeproj/xcshareddata/xcschemes/MiDong.xcscheme": appScheme("MiDong"),
    "MiFit.xcodeproj/xcshareddata/xcschemes/MiFitWatch.xcscheme": appScheme("MiDong"),
  });
  const zepp = [applicationSettings("MiDong", { PROJECT_FILE_PATH: join(root, "MiFit.xcodeproj"),
    FULL_PRODUCT_NAME: "Zepp.app", PRODUCT_BUNDLE_IDENTIFIER: "test.zepp" })];
  const calls = await xcodebuildFixture(t, root, {
    list: { workspace: { schemes: ["MiFit", "MiFitWatch", "Generate Project", "Dependency", "MiDong", "Unrecorded"] } },
    MiFit: [applicationSettings("MiFit")],
    MiFitWatch: zepp,
    "Generate Project": [{ target: "Generate Project", buildSettings: { PRODUCT_TYPE: "com.apple.product-type.framework", WRAPPER_EXTENSION: "framework" } }, applicationSettings("DependencyApp")],
    Dependency: [applicationSettings("Dependency")], MiDong: zepp, Unrecorded: [applicationSettings("Unrecorded")],
  });
  assert.equal((await withContainer(root, {}, {})).scheme, "MiDong");
  const probes = probedSchemes(await calls());
  assert.ok(probes.includes("MiDong"));
  assert.ok(probes.every((scheme) => ["MiDong", "MiFitWatch", "Generate Project"].includes(scheme)), `unexpected hidden probes: ${probes}`);
});

test("a scheme named after a different workspace project has no preference", async (t) => {
  const root = await fixture(t, {
    "Suite.xcworkspace/contents.xcworkspacedata": '<Workspace><FileRef location="group:A.xcodeproj"/><FileRef location="group:B.xcodeproj"/></Workspace>',
    [schemeManagementPath("A.xcodeproj")]: schemeManagement({ B: true, Run: true }),
    "B.xcodeproj": null,
  });
  await xcodebuildFixture(t, root, { list: { workspace: { schemes: ["B", "Run"] } },
    B: [applicationSettings("B")], Run: [applicationSettings("Run")] });
  await assert.rejects(withContainer(root, {}, {}), /Several main app schemes.*B, Run/);
});

test("two shown iOS apps without a project-name preference remain genuinely ambiguous", async (t) => {
  const root = await fixture(t, {
    [schemeManagementPath("Host.xcodeproj")]: schemeManagement({ First: true, Second: true, Hidden: false }),
  });
  const calls = await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["Hidden", "First", "Second"] } },
    Hidden: [applicationSettings("Hidden")], First: [applicationSettings("First")], Second: [applicationSettings("Second")],
  });
  await assert.rejects(withContainer(root, {}, {}), (error) => {
    assert.match(error.message, /Several main app schemes/);
    assert.match(error.message, /First/);
    assert.match(error.message, /Second/);
    assert.match(error.message, /pass scheme=/);
    return true;
  });
  assert.deepEqual(probedSchemes(await calls()).sort(), ["First", "Second"]);
});

test("automatic discovery honors the caller's query budget and can finish with a sufficient budget", async (t) => {
  const root = await fixture(t, { "App.xcodeproj": null });
  await xcodebuildFixture(t, root, {
    list: { project: { schemes: ["App"] }, delayMs: 200 },
    App: [applicationSettings("App")],
  });
  await assert.rejects(withContainer(root, {}, { timeoutSeconds: 0 }), /timeoutSeconds must be a positive finite number/);
  await assert.rejects(withContainer(root, {}, { timeoutSeconds: 0.05 }), /xcodebuild -list timed out after 0\.05s/);
  assert.equal((await withContainer(root, {}, { timeoutSeconds: 3 })).scheme, "App");
});
