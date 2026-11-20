import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { join } from "node:path";

const exec = promisify(execFile);
const setup = new URL("../bin/xcodebug-setup-codex.mjs", import.meta.url).pathname;

async function runSetup(root, cwd = root) {
  return exec(process.execPath, [setup], {
    cwd,
    env: { ...process.env, CODEX_HOME: join(root, "home") },
    maxBuffer: 100_000,
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-setup-codex-test-"));
  await mkdir(join(root, "home"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("setup registers a missing server and writes the default timeout", async t => {
  const root = await fixture(t);
  const result = await runSetup(root);
  assert.match(result.stdout, /Configured xcodebug MCP timeout: 4200s/);
  const config = await readFile(join(root, "home", "config.toml"), "utf8");
  assert.match(config, /tool_timeout_sec = 4200/);
  assert.match(config, /mcp_servers\.xcodebug/);
});

test("setup preserves an existing timeout and warns about project overrides", async t => {
  const root = await fixture(t);
  const project = join(root, "project");
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(join(root, "home", "config.toml"), `[mcp_servers.xcodebug]\ncommand = "custom-bun"\nargs = ["custom.ts"]\ntool_timeout_sec = 9000\n`);
  const projectConfig = join(project, ".codex", "config.toml");
  await writeFile(projectConfig, `[mcp_servers.xcodebug]\ncommand = "project-bun"\nargs = ["project.ts"]\n`);

  const result = await runSetup(root, project);
  assert.match(result.stdout, /Existing Codex xcodebug tool timeout preserved/);
  assert.match(result.stderr, /project Codex config may override xcodebug: .*\/project\/\.codex\/config\.toml/);
  assert.match(result.stderr, /existing xcodebug registration points elsewhere/);
  assert.match(await readFile(join(root, "home", "config.toml"), "utf8"), /tool_timeout_sec = 9000/);
});
