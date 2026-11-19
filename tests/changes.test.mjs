import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectChanges, directorySignature } from "../changes.ts";

// A fingerprint is path, time and size, so every rewrite here changes the size.
async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-changes-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q");
  const write = (path, text) => writeFile(join(root, path), text);
  const fingerprint = async container => (await detectChanges(root, container)).fingerprint;
  const changed = async () => (await detectChanges(root)).changed.map(file => file.path);
  return { root, git, write, fingerprint, changed };
}

test("committed code is part of the fingerprint, so a clean tree is not always the same tree", async t => {
  const { git, write, fingerprint } = await repository(t);
  await write("A.swift", "// one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const first = await fingerprint();
  assert.equal(await fingerprint(), first);

  await write("A.swift", "// two, and longer\n");
  const edited = await fingerprint();
  assert.notEqual(edited, first);
  git("add", "A.swift");
  assert.equal(await fingerprint(), edited, "staging a change does not alter what gets built");
  git("commit", "-q", "-m", "two");
  const second = await fingerprint();
  assert.notEqual(second, first, "a clean tree at another commit holds other code");

  git("commit", "-q", "--amend", "-m", "two, reworded");
  assert.equal(await fingerprint(), second, "the same tree under another commit is the same code");
});

test("a change of any type counts, tracked or not, except the types no build reads", async t => {
  const { root, git, write, fingerprint, changed } = await repository(t);
  await mkdir(join(root, "Classes"));
  await write("Podfile.rb", "pod 'A'\n");
  await write("notes.md", "notes\n");
  await write("X.podspec", "Pod::Spec.new do |s|\n  s.name = 'X'\n  s.source_files = 'Classes/**/*'\nend\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = await fingerprint();

  // Build inputs of types no list of source extensions names.
  await write("Podfile.rb", "pod 'A'\npod 'B'\n");
  assert.deepEqual(await changed(), ["Podfile.rb"]);
  assert.notEqual(await fingerprint(), base);
  git("checkout", "-q", "--", "Podfile.rb");
  await write("Icon.png", "dropped into a folder the project takes whole");
  assert.deepEqual(await changed(), ["Icon.png"]);
  assert.notEqual(await fingerprint(), base);
  await rm(join(root, "Icon.png"));

  await write("notes.md", "notes, rewritten by every session\n");
  await write("run.log", "left behind by a run\n");
  await write("crash.IPS", "{}\n");
  await write("fix.patch", "--- a\n+++ b\n");
  git("add", "run.log");
  assert.deepEqual(await changed(), []);
  assert.equal(await fingerprint(), base);

  // A new file of a type the Pods project does not compile needs no pod install.
  await write("Classes/readme.txt", "not compiled\n");
  await write("Classes/New.swift", "// new\n");
  const report = await detectChanges(root);
  assert.deepEqual(report.changed.map(file => file.path).sort(), ["Classes/New.swift", "Classes/readme.txt"]);
  assert.deepEqual(report.podsNeedingInstall, ["X"]);
  assert.deepEqual(report.newComponentFiles.map(file => file.path), ["Classes/New.swift"]);
});

test("a pod installed from outside the repository is part of the target's fingerprint", async t => {
  const { root, git, write, fingerprint } = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "xcodebug-outside-pod-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "Kit.swift"), "// kit\n");
  await mkdir(join(root, "App"));
  await write("App/Podfile.lock", [
    "DEPENDENCIES:", "  - Kit (from `" + outside + "`)", "  - Local (from `../`)", "",
    "EXTERNAL SOURCES:", "  Kit:", `    :path: "${outside}"`, "  Local:", '    :path: "../"', "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const container = join(root, "App", "App.xcworkspace");
  const before = await fingerprint(container);
  const blind = await fingerprint();

  await writeFile(join(outside, "Kit.swift"), "// kit, edited where git status cannot see\n");
  assert.notEqual(await fingerprint(container), before);
  assert.equal(await fingerprint(), blind, "without a target there is no lock file to read pods from");

  const edited = await fingerprint(container);
  await rm(outside, { recursive: true });
  assert.notEqual(await fingerprint(container), edited);
});

test("relative containers locate external pods from the project cwd, not the process cwd", async t => {
  const { root, git, write } = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "xcodebug-relative-pod-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "Kit.swift"), "// original\n");
  await mkdir(join(root, "App"));
  await write("App/Podfile.lock", `EXTERNAL SOURCES:\n  Kit:\n    :path: "${outside}"\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const cwd = join(root, "App");
  const fingerprint = async container => (await detectChanges(cwd, container)).fingerprint;
  const before = await fingerprint("App.xcworkspace");
  assert.equal(before, await fingerprint(join(cwd, "App.xcworkspace")));

  await mkdir(join(outside, "build"));
  await writeFile(join(outside, "build", "generated.swift"), "// ignored build output\n");
  assert.equal(await fingerprint("App.xcworkspace"), before, "external source scans still ignore build directories");

  await writeFile(join(outside, "Kit.swift"), "// edited outside git\n");
  assert.notEqual(await fingerprint("App.xcworkspace"), before);
  assert.equal(await fingerprint("App.xcodeproj"), await fingerprint(join(cwd, "App.xcodeproj")));
});

test("a directory's signature follows its files, and there is none for one that cannot be read", async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-signature-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Frameworks"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "Frameworks", "Kit"), "binary");
  await writeFile(join(root, ".git", "HEAD"), "ref");
  // A link to nothing is an entry like any other, not a reason to give up.
  await symlink(join(root, "missing"), join(root, "dangling"));
  const first = await directorySignature(root, "source");
  assert.equal(typeof first, "string");
  assert.equal(await directorySignature(root, "source"), first);

  await writeFile(join(root, ".git", "HEAD"), "ref: moved");
  assert.equal(await directorySignature(root, "source"), first, "a repository's own bookkeeping is not its sources");
  await writeFile(join(root, "Frameworks", "Kit"), "binary, rebuilt");
  const rebuilt = await directorySignature(root, "source");
  assert.notEqual(rebuilt, first);
  await writeFile(join(root, "Frameworks", "Extra"), "new");
  assert.notEqual(await directorySignature(root, "source"), rebuilt);

  assert.equal(await directorySignature(join(root, "gone")), undefined);
});

test("product signatures include directories that source scans ignore", async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-product-signature-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["Pods", "build", ".build", "DerivedData", "Carthage", ".git"]) {
    await mkdir(join(root, dir));
    const before = await directorySignature(root);
    await writeFile(join(root, dir, "resource"), "bundled app resource");
    assert.notEqual(await directorySignature(root), before, `${dir} is part of the installed product`);
    const withResource = await directorySignature(root);
    await writeFile(join(root, dir, "resource"), "bundled app resource, changed");
    assert.notEqual(await directorySignature(root), withResource, `${dir} edits invalidate the product`);
  }
});
