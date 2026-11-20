import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { join } from "node:path";

const exec = promisify(execFile);
const setup = new URL("../bin/xcodebug-setup-codex.mjs", import.meta.url).pathname;

async function runSetup(root, cwd = root, env = {}) {
  return exec(process.execPath, [setup], {
    cwd,
    env: { ...process.env, CODEX_HOME: join(root, "home"), ...env },
    maxBuffer: 100_000,
  });
}

async function readConfig(root) {
  const { stdout } = await exec("bun", [
    "-e", "console.log(JSON.stringify(Bun.TOML.parse(await Bun.file(process.argv[1]).text())))",
    join(root, "home", "config.toml"),
  ]);
  return JSON.parse(stdout);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "xcodebug-setup-codex-test-"));
  await mkdir(join(root, "home"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function daemonFixture(t, output, status = 0, { providerRace = false, cliVersion = "0.171.0", cliExit = 0 } = {}) {
  const root = await fixture(t);
  const shim = join(root, "codex.mjs");
  await writeFile(join(root, "home", "config.toml"), `[mcp_servers.xcodebug]\ncommand = "custom-bun"\nargs = ["custom.ts"]\ntool_timeout_sec = 9000\n`);
  await writeFile(shim, `#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(${JSON.stringify(`codex-cli ${cliVersion}`)});
  process.exitCode = ${cliExit};
} else if (args.join(" ") === "app-server daemon version") {
  process.stdout.write(${JSON.stringify(output)});
  process.exitCode = ${status};
} else if (args[0] === "app-server" && args[1] === "daemon") {
  throw new Error("setup must not modify the daemon");
} else if (${providerRace} && args[0] === "app-server") {
  const child = spawn("codex", args, { stdio: ["pipe", "pipe", "inherit"] });
  const input = createInterface({ input: process.stdin });
  const replies = createInterface({ input: child.stdout });
  let readId;
  input.on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "config/read") readId = request.id;
    child.stdin.write(line + "\\n");
  });
  input.on("close", () => child.stdin.end());
  replies.on("line", line => {
    const response = JSON.parse(line);
    if (readId !== undefined && response.id === readId && response.result?.config) {
      appendFileSync(join(process.env.CODEX_HOME, "config.toml"), '\\n[tui]\\nstatus_line_provider = { server = "work", tool = "footer" }\\n');
      readId = undefined;
    }
    process.stdout.write(line + "\\n");
  });
  child.on("error", error => { throw error; });
  child.on("exit", code => { process.exitCode = code ?? 1; input.close(); });
} else {
  const result = spawnSync("codex", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
`);
  await chmod(shim, 0o755);
  return { root, shim };
}

test("setup configures xcodebug and selects its statusline provider on first install", async t => {
  const root = await fixture(t);
  const result = await runSetup(root);
  assert.match(result.stdout, /Configured xcodebug MCP timeout: 4200s/);
  const config = await readFile(join(root, "home", "config.toml"), "utf8");
  assert.match(config, /tool_timeout_sec = 4200/);
  assert.match(config, /tui_extensions_statusline = true/);
  assert.match(config, /mcp_servers\.xcodebug/);
  const saved = await readConfig(root);
  assert.deepEqual(saved.tui?.status_line_provider, { server: "xcodebug", tool: "xcodebug_ui" });
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

test("setup warns when the running app server is older than the statusline minimum", async t => {
  const { root, shim } = await daemonFixture(t, JSON.stringify({
    status: "running", cliVersion: "0.171.0", managedCodexVersion: "0.171.0", appServerVersion: "0.168.0",
  }));
  const result = await runSetup(root, root, { CODEX_BIN: shim });
  assert.match(result.stderr, /running Codex app-server 0\.168\.0 is older than 0\.171\.0/);
  assert.match(result.stderr, /codex app-server daemon update --from-cli --yes/);
  assert.match(result.stderr, /codex app-server daemon restart/);
  const config = await readFile(join(root, "home", "config.toml"), "utf8");
  assert.match(config, /tool_timeout_sec = 9000/);
  assert.match(config, /tui_extensions_statusline = true/);
});

test("setup accepts a supported running app server", async t => {
  const { root, shim } = await daemonFixture(t, JSON.stringify({
    status: "running", cliVersion: "0.171.0", appServerVersion: "0.171.0",
  }));
  const result = await runSetup(root, root, { CODEX_BIN: shim });
  assert.match(result.stdout, /Running Codex app-server version: 0\.171\.0/);
  assert.doesNotMatch(result.stderr, /running Codex app-server .* is older|version could not be verified/);
});

test("setup preserves configuration when the daemon version cannot be verified", async t => {
  for (const [name, output, status] of [
    ["unavailable daemon", "", 1],
    ["malformed response", "not JSON", 0],
    ["missing version", JSON.stringify({ status: "running" }), 0],
  ]) {
    await t.test(name, async child => {
      const { root, shim } = await daemonFixture(child, output, status);
      const result = await runSetup(root, root, { CODEX_BIN: shim });
      assert.match(result.stderr, /running Codex app-server version could not be verified/);
      assert.doesNotMatch(result.stdout, /Running Codex app-server version:/);
      const config = await readFile(join(root, "home", "config.toml"), "utf8");
      assert.match(config, /tool_timeout_sec = 9000/);
      assert.match(config, /tui_extensions_statusline = true/);
    });
  }
});

test("setup replaces an explicit default provider without losing other TUI settings", async t => {
  const { root, shim } = await daemonFixture(t, JSON.stringify({ status: "running", appServerVersion: "0.171.0" }));
  await appendFile(join(root, "home", "config.toml"), '\n[tui]\ntheme = "nord"\nstatus_line_provider = "default"\n');
  await runSetup(root, root, { CODEX_BIN: shim });
  const saved = await readConfig(root);
  assert.deepEqual(saved.tui.status_line_provider, { server: "xcodebug", tool: "xcodebug_ui" });
  assert.equal(saved.tui.theme, "nord");
  assert.equal(saved.mcp_servers.xcodebug.tool_timeout_sec, 9000);
});

test("setup preserves an existing custom provider and explains how to change it", async t => {
  const { root, shim } = await daemonFixture(t, JSON.stringify({ status: "running", appServerVersion: "0.171.0" }));
  await appendFile(join(root, "home", "config.toml"), '\n[tui]\nstatus_line_provider = { server = "work", tool = "footer" }\n');
  const result = await runSetup(root, root, { CODEX_BIN: shim });
  const saved = await readConfig(root);
  assert.deepEqual(saved.tui.status_line_provider, { server: "work", tool: "footer" });
  assert.match(result.stderr, /existing custom Codex statusline provider preserved/);
  assert.equal(saved.features.tui_extensions_statusline, true);
});

test("setup does not overwrite a custom provider selected after its config read", async t => {
  const { root, shim } = await daemonFixture(t, JSON.stringify({ status: "running", appServerVersion: "0.171.0" }), 0, { providerRace: true });
  await runSetup(root, root, { CODEX_BIN: shim }).catch(() => null);
  const saved = await readConfig(root);
  assert.deepEqual(saved.tui.status_line_provider, { server: "work", tool: "footer" });
  assert.equal(saved.mcp_servers.xcodebug.tool_timeout_sec, 9000);
});

test("setup does not enable or select a statusline provider on an older CLI", async t => {
  const { root, shim } = await daemonFixture(t, "", 1, { cliVersion: "0.170.0" });
  await writeFile(join(root, "home", "config.toml"), '[mcp_servers.xcodebug]\ncommand = "custom-bun"\nargs = ["custom.ts"]\n\n[features]\ntui_extensions_statusline = false\n\n[tui]\nstatus_line_provider = "default"\n');
  await runSetup(root, root, { CODEX_BIN: shim });
  const saved = await readConfig(root);
  assert.equal(saved.features.tui_extensions_statusline, false);
  assert.equal(saved.tui.status_line_provider, "default");
  assert.equal(saved.mcp_servers.xcodebug.tool_timeout_sec, 4200);
});

test("setup preserves statusline choices when the CLI version command fails", async t => {
  const { root, shim } = await daemonFixture(t, "", 1, { cliExit: 1 });
  await appendFile(join(root, "home", "config.toml"), '\n[features]\ntui_extensions_statusline = false\n\n[tui]\nstatus_line_provider = "default"\n');
  await runSetup(root, root, { CODEX_BIN: shim });
  const saved = await readConfig(root);
  assert.equal(saved.features.tui_extensions_statusline, false);
  assert.equal(saved.tui.status_line_provider, "default");
});
