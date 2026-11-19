import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BuildDiagnostics, buildForDevice } from "../xcode.ts";

// Recorded from Xcode building a Swift package with two type errors, and again
// with an undefined symbol. Only the multi-kilobyte command lines are shortened.
const COMPILE_ERRORS = [
  "/tmp/xcprobe-buildfail/Sources/Probe/main.swift:1:18: error: cannot convert value of type 'String' to specified type 'Int'",
  "/tmp/xcprobe-buildfail/Sources/Probe/main.swift:2:7: error: cannot find 'undefinedName' in scope",
];
const COMPILE = [
  "SwiftCompile normal arm64 (in target 'Probe-product' from project 'Probe')",
  "    cd /tmp/xcprobe-buildfail/.swiftpm/xcode",
  "    ",
  "",
  COMPILE_ERRORS[0],
  '1 | let count: Int = "not a number"',
  "  |                  `- error: cannot convert value of type 'String' to specified type 'Int'",
  "2 | print(undefinedName)",
  "3 | ",
  "",
  COMPILE_ERRORS[1],
  '1 | let count: Int = "not a number"',
  "2 | print(undefinedName)",
  "  |       `- error: cannot find 'undefinedName' in scope",
  "3 | ",
  "Failed frontend command:",
  "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -emit-module",
  "SwiftCompile normal arm64 /tmp/xcprobe-buildfail/Sources/Probe/main.swift (in target 'Probe-product' from project 'Probe')",
  "    cd /tmp/xcprobe-buildfail/.swiftpm/xcode",
  "    builtin-SwiftPerFileCompile main.swift",
  "",
  COMPILE_ERRORS[0],
  '1 | let count: Int = "not a number"',
  "  |                  `- error: cannot convert value of type 'String' to specified type 'Int'",
  "2 | print(undefinedName)",
  "3 | ",
  "",
].join("\n");
const LINK = [
  "Ld /tmp/xcprobe-buildfail/dd/Build/Products/Debug/Probe normal (in target 'Probe-product' from project 'Probe')",
  "    cd /tmp/xcprobe-buildfail",
  "    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc -Xlinker -reproducible",
  "Undefined symbols for architecture arm64:",
  '  "_probe_missing_function", referenced from:',
  "      _main in main.o",
  "ld: symbol(s) not found for architecture arm64",
  "/tmp/xcprobe-buildfail/Package.swift: Probe-product: clang: error: linker command failed with exit code 1 (use -v to see invocation)",
  "",
  "PruneExplicitPrecompiledModules /tmp/xcprobe-buildfail/dd/Build/Intermediates.noindex/SwiftExplicitPrecompiledModules",
  "",
].join("\n");
const VERDICT = [
  "** BUILD FAILED **",
  "",
  "",
  "The following build commands failed:",
  "\tSwiftCompile normal arm64 (in target 'Probe-product' from project 'Probe')",
  "\tBuilding workspace Probe with scheme Probe",
  "(2 failures)",
  "",
].join("\n");

function diagnose(text, chunk = text.length) {
  const diagnostics = new BuildDiagnostics();
  for (let at = 0; at < text.length; at += chunk) diagnostics.update(text.slice(at, at + chunk));
  return diagnostics.result();
}

test("a compiler error is reported once, without the source the compiler draws under it", () => {
  assert.deepEqual(diagnose(COMPILE), { lines: COMPILE_ERRORS, omitted: 0 });
});

test("a linker failure keeps the symbols it names, and nothing of the command above it", () => {
  assert.deepEqual(diagnose(LINK).lines, [
    "Undefined symbols for architecture arm64:",
    '  "_probe_missing_function", referenced from:',
    "      _main in main.o",
    "ld: symbol(s) not found for architecture arm64",
    "/tmp/xcprobe-buildfail/Package.swift: Probe-product: clang: error: linker command failed with exit code 1 (use -v to see invocation)",
  ]);
});

test("duplicate-symbol diagnostics keep each symbol and the conflicting object paths", () => {
  const lines = [
    "duplicate symbol '_probe_shared' in:",
    "    /tmp/build/First.o",
    "    /tmp/build/libKit.a(Second.o)",
    "duplicate symbol '_probe_other' in:",
    "    /tmp/build/Third.o",
    "    /tmp/build/libKit.a(Fourth.o)",
    "ld: 2 duplicate symbols for architecture arm64",
    "clang: error: linker command failed with exit code 1 (use -v to see invocation)",
  ];
  const output = [...lines, "", "    /usr/bin/clang unrelated build command", ""].join("\n");
  for (const chunk of [1, 7, output.length]) {
    assert.deepEqual(diagnose(output, chunk), { lines, omitted: 0 });
  }
});

test("duplicate-symbol context respects the symbol and diagnostic limits", () => {
  const output = Array.from({ length: 15 }, (_, i) => [
    `duplicate symbol '_probe_${i}' in:`,
    ...Array.from({ length: 8 }, (_, j) => `    /tmp/build/Object${i}_${j}.o`),
  ].join("\n")).join("\n");
  const result = diagnose(output);
  assert.equal(result.lines.length, 12 * 7, "each kept diagnostic has at most six context lines");
  assert.equal(result.omitted, 3);
  assert.equal(result.lines.at(-1), "    /tmp/build/Object11_5.o");
});

test("warnings, and commands that merely mention an error, are not failures", () => {
  const output = [
    "ld: warning: object file (Pods/libA.a) was built for newer 'iOS' version (18.0) than being linked (15.0)",
    "/tmp/a.swift:3:5: warning: variable 'error' was never used",
    "    /usr/bin/clang -Werror=return-type -DMESSAGE=error: \\ fatal -c a.m",
    "ld: framework 'Missing' not found",
    "",
  ].join("\n");
  assert.deepEqual(diagnose(output).lines, ["ld: framework 'Missing' not found"]);
});

test("output is read the same however it is cut into chunks", () => {
  for (const size of [1, 7, 64]) {
    assert.deepEqual(diagnose(COMPILE + LINK, size), diagnose(COMPILE + LINK));
  }
});

test("past the first dozen, errors are counted instead of listed", () => {
  const output = Array.from({ length: 15 }, (_, i) => `/tmp/a.swift:${i + 1}:1: error: failure ${i + 1}\n`).join("");
  const result = diagnose(output);
  assert.equal(result.lines.length, 12);
  assert.equal(result.lines.at(-1), "/tmp/a.swift:12:1: error: failure 12");
  assert.equal(result.omitted, 3);
});

test("a failed build reports its errors, not the build commands its output ends with", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-build-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  // What a real build goes on to print after the error: one command after another.
  const commands = Array.from({ length: 200 }, (_, i) =>
    `CompileC /tmp/Build/Other${i}.o /tmp/Other${i}.m normal arm64 (in target 'Pods' from project 'Pods')\n    cd /tmp/Pods\n    /usr/bin/clang -x objective-c filler ${i}\n\n`).join("");
  await writeFile(join(root, "stdout"), COMPILE + commands);
  await writeFile(join(root, "stderr"), VERDICT);
  await writeFile(join(bin, "xcodebuild"), `#!/bin/sh\n/bin/cat '${root}/stdout'\n/bin/cat '${root}/stderr' >&2\nexit 65\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });

  const outcome = await buildForDevice(
    { scheme: "Probe", configuration: "Debug", project: join(root, "Probe.xcodeproj") },
    { id: "test-device", udid: "test-udid", name: "Test", state: "connected", physical: true },
    { logDir: join(root, "logs"), cwd: root, timeoutMs: 15_000 },
  );
  assert.equal(outcome.ok, false);
  const lines = outcome.summary.split("\n");
  assert.equal(lines[0], "build failed (exit 65)");
  assert.deepEqual(lines.slice(1, 3), COMPILE_ERRORS);
  assert.ok(lines.includes("** BUILD FAILED **"));
  assert.ok(lines.includes("\tSwiftCompile normal arm64 (in target 'Probe-product' from project 'Probe')"));
  assert.doesNotMatch(outcome.summary, /filler|CompileC/);
  assert.match(await readFile(outcome.logFile, "utf8"), /filler 199/, "the log still holds the whole build");
});
