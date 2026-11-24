import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRuntimeVersion } from "../version.ts";

test("running identity is fixed while a same-version source update requires restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "mcp"));
  await writeFile(join(root, "package.json"), '{"version":"1.2.4"}');
  await writeFile(join(root, "index.ts"), "// original");
  const runtime = createRuntimeVersion(root);
  assert.equal(runtime.identity.version, "1.2.4");
  assert.equal(runtime.warning(), undefined);
  await writeFile(join(root, "index.ts"), "// changed without bumping version");
  assert.match(runtime.warning(), /restart/i);
  assert.equal(runtime.identity.version, "1.2.4");
  const fresh = createRuntimeVersion(root);
  assert.equal(fresh.warning(), undefined);
  assert.notEqual(fresh.identity.sourceDigest, runtime.identity.sourceDigest);
  await writeFile(join(root, "package.json"), '{"version":"1.3.0"}');
  assert.match(fresh.warning(), /1.3.0/);
});
