#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TOOL_TIMEOUT_SECONDS = 4_200;
const STATUSLINE_MIN_CODEX_VERSION = [0, 171, 0];
const STATUSLINE_FEATURE = "features.tui_extensions_statusline";
const MARKETPLACE = "sublimter-xcodebug";
const MARKETPLACE_SERVER = "xcodebug_marketplace";
const PROVIDER_KEY = "tui.status_line_provider";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(packageRoot, "mcp", "server.ts");
const codex = process.env.CODEX_BIN ?? "codex";
const runtime = process.env.XCODEBUG_MCP_RUNTIME ?? "bun";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return result;
}

function getRegistration() {
  return run(codex, ["mcp", "get", "xcodebug"]);
}

function ensureServerRegistration() {
  const existing = getRegistration();
  if (existing.status === 0) return existing;

  const runtimeCheck = run(runtime, ["--version"]);
  if (runtimeCheck.status !== 0) {
    throw new Error(`xcodebug is not registered and ${runtime} is unavailable; install Bun or set XCODEBUG_MCP_RUNTIME`);
  }
  const added = run(codex, ["mcp", "add", "xcodebug", "--", runtime, serverPath]);
  if (added.status !== 0) {
    throw new Error((added.stderr || added.stdout || "codex mcp add failed").trim());
  }
  const registered = getRegistration();
  if (registered.status !== 0) {
    throw new Error((registered.stderr || registered.stdout || "could not read the new xcodebug registration").trim());
  }
  return registered;
}

function projectOverrides() {
  const configs = [];
  for (let dir = process.cwd();; dir = dirname(dir)) {
    const path = join(dir, ".codex", "config.toml");
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (/^\s*\[mcp_servers\.xcodebug\]\s*$/m.test(text) || (/^\s*\[mcp_servers\]\s*$/m.test(text) && /^\s*xcodebug\s*=/m.test(text))) configs.push(path);
      }
    } catch {
      // A config that cannot be read is reported by Codex itself; setup must not edit it.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  return configs;
}

function reportWarnings(registration) {
  for (const path of projectOverrides()) {
    console.error(`Warning: project Codex config may override xcodebug: ${path}`);
  }
  if (registration.stdout && !registration.stdout.includes(serverPath)) {
    console.error(`Warning: existing xcodebug registration points elsewhere; setup kept it: ${serverPath}`);
  }
}

function hasTimeout(registration) {
  return /^\s*tool_timeout_sec\s*:/m.test(registration.stdout);
}

function parseVersion(text) {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : undefined;
}

function codexVersion() {
  const result = run(codex, ["--version"]);
  if (result.status !== 0) return undefined;
  return parseVersion(result.stdout);
}

function versionSupportsStatusline(version) {
  return version[0] > STATUSLINE_MIN_CODEX_VERSION[0] ||
    (version[0] === STATUSLINE_MIN_CODEX_VERSION[0] && (version[1] > STATUSLINE_MIN_CODEX_VERSION[1] ||
      (version[1] === STATUSLINE_MIN_CODEX_VERSION[1] && version[2] >= STATUSLINE_MIN_CODEX_VERSION[2])));
}

function supportsStatusline() {
  const version = codexVersion();
  if (!version) {
    console.error("Warning: could not determine Codex version; statusline feature was not enabled");
    return false;
  }
  const supported = versionSupportsStatusline(version);
  if (!supported) {
    console.error(`Warning: Codex ${version.join(".")} is older than 0.171.0; statusline feature was not enabled`);
  }
  return supported;
}

function checkAppServerVersion() {
  try {
    const result = run(codex, ["app-server", "daemon", "version"]);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "daemon version query failed").trim());
    const report = JSON.parse(result.stdout);
    if (report?.status !== "running" || typeof report.appServerVersion !== "string") {
      throw new Error("no running app-server version was reported");
    }
    const version = parseVersion(report.appServerVersion);
    if (!version) throw new Error(`unrecognized app-server version: ${report.appServerVersion}`);
    console.log(`Running Codex app-server version: ${report.appServerVersion}`);
    if (!versionSupportsStatusline(version)) {
      console.error(`Warning: running Codex app-server ${report.appServerVersion} is older than 0.171.0; saving the feature setting does not upgrade the server.`);
      console.error("Finish active Codex tasks and captures before running:");
      console.error("  codex app-server daemon update --from-cli --yes");
      console.error("  codex app-server daemon restart");
    }
  } catch (error) {
    console.error(`Warning: running Codex app-server version could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    console.error("If you use the shared daemon, start Codex and check with codex app-server daemon version.");
  }
}

function requireMarketplaceServer(globalConfig) {
  if (globalConfig?.plugins?.[`xcodebug@${MARKETPLACE}`]?.enabled !== true) {
    throw new Error("Install and enable xcodebug@sublimter-xcodebug at the user level in Codex first.");
  }
  const plugins = run(codex, ["plugin", "list", "--marketplace", MARKETPLACE, "--json"]);
  const installed = plugins.status === 0 && JSON.parse(plugins.stdout).installed;
  if (!installed || !installed.some(plugin => plugin.pluginId === `xcodebug@${MARKETPLACE}` && plugin.enabled === true)) {
    throw new Error("Install and enable xcodebug@sublimter-xcodebug in Codex first.");
  }
  const server = run(codex, ["mcp", "get", MARKETPLACE_SERVER, "--json"]);
  if (server.status !== 0 || JSON.parse(server.stdout).enabled !== true) {
    throw new Error(`Enable the bundled ${MARKETPLACE_SERVER} MCP server first.`);
  }
}

function isManualProvider(provider) {
  return provider?.server === "xcodebug" && provider.tool === "xcodebug_ui";
}

async function writeConfig(values, migrateMarketplace = false) {
  const app = startAppServer();
  try {
    await app.request("initialize", { clientInfo: { name: "xcodebug-setup-codex", version: "1" } });
    app.child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
    const edits = [];
    for (const keyPath of Object.keys(values)) {
      edits.push({ keyPath, value: values[keyPath], mergeStrategy: "upsert" });
    }
    let providerSelected = false;
    let filePath;
    let expectedVersion;
    if (migrateMarketplace || values[STATUSLINE_FEATURE] === true) {
      const response = await app.request("config/read", { includeLayers: true });
      const userLayer = Array.isArray(response?.layers)
        ? response.layers.find(layer => layer.name?.type === "user" && layer.name.profile === null && !layer.disabledReason)
        : undefined;
      if (!userLayer || typeof userLayer.name.file !== "string" || typeof userLayer.version !== "string" ||
          !userLayer.config || typeof userLayer.config !== "object" || Array.isArray(userLayer.config)) {
        throw new Error("Codex did not return user configuration metadata; statusline provider was not changed");
      }
      filePath = userLayer.name.file;
      expectedVersion = userLayer.version;
      const provider = userLayer.config.tui?.status_line_provider;
      if (migrateMarketplace) {
        // Capture the user version before preflight so plugin changes invalidate the write.
        requireMarketplaceServer(response.config);
        const scoped = await app.request("config/read", { includeLayers: true, cwd: process.cwd() });
        const userIndex = Array.isArray(scoped?.layers)
          ? scoped.layers.findIndex(layer => layer.name?.type === "user" && layer.name.profile === null &&
              layer.name.file === filePath && !layer.disabledReason)
          : -1;
        if (userIndex < 0) {
          throw new Error("Codex did not return project configuration metadata; no user settings changed.");
        }
        // The merged config can omit project fields; inspect the raw layers too.
        if (Object.hasOwn(response.config?.mcp_servers ?? {}, MARKETPLACE_SERVER) ||
            scoped.layers.some(layer => !layer.disabledReason &&
              Object.hasOwn(layer.config?.mcp_servers ?? {}, MARKETPLACE_SERVER))) {
          throw new Error(`${MARKETPLACE_SERVER} is overridden in Codex config; resolve the override before migrating.`);
        }
        if (!isManualProvider(provider)) {
          console.log("No matching user-level xcodebug statusline selection changed.");
          return;
        }
        if (scoped.layers.some((layer, index) => index < userIndex && !layer.disabledReason &&
            Object.hasOwn(layer.config?.tui ?? {}, "status_line_provider"))) {
          throw new Error("A project or profile defines a statusline provider; review that setting before migrating the user selection.");
        }
        if (!isManualProvider(response.config?.tui?.status_line_provider)) {
          console.log("Effective provider selection differs; no user settings changed.");
          return;
        }
        edits.push({ keyPath: PROVIDER_KEY, value: { ...provider, server: MARKETPLACE_SERVER }, mergeStrategy: "replace" });
      } else if (provider === undefined || provider === null || provider === "default") {
        edits.push({ keyPath: PROVIDER_KEY, value: { server: "xcodebug", tool: "xcodebug_ui" }, mergeStrategy: "upsert" });
        providerSelected = true;
      } else if (provider.server !== "xcodebug" || provider.tool !== "xcodebug_ui") {
        console.error("Warning: existing custom Codex statusline provider preserved; choose xcodebug_ui under /statusline or set tui.status_line_provider explicitly.");
      }
    }
    // Codex 0.171.0 returns a non-reusable version after numeric writes; batch the edits.
    const result = await app.request("config/batchWrite", { edits, filePath, expectedVersion });
    if (result?.status !== "ok") throw new Error(`Codex rejected the config write: ${JSON.stringify(result)}`);
    if (providerSelected) console.log("Configured Codex statusline provider: xcodebug / xcodebug_ui");
    if (migrateMarketplace) console.log(`Migrated Codex statusline provider to ${MARKETPLACE_SERVER} / xcodebug_ui.`);
  } finally {
    await app.close();
  }
}

async function configureCodex(registration) {
  const values = {};
  if (!hasTimeout(registration)) values["mcp_servers.xcodebug.tool_timeout_sec"] = TOOL_TIMEOUT_SECONDS;
  if (supportsStatusline()) values[STATUSLINE_FEATURE] = true;
  if (Object.keys(values).length > 0) await writeConfig(values);
  if (hasTimeout(registration)) console.log("Existing Codex xcodebug tool timeout preserved");
  else console.log(`Configured xcodebug MCP timeout: ${TOOL_TIMEOUT_SECONDS}s`);
  if (values[STATUSLINE_FEATURE] === true) {
    console.log("Enabled Codex xcodebug statusline feature in configuration");
    checkAppServerVersion();
  }
}

function startAppServer() {
  const child = spawn(codex, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pending = new Map();
  let nextId = 0;
  const input = createInterface({ input: child.stdout });
  input.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex app-server timed out during ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const close = async () => {
    for (const { timer } of pending.values()) clearTimeout(timer);
    input.close();
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  return { child, request, close, get stderr() { return stderr; } };

}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--migrate-marketplace") {
    await writeConfig({}, true);
  } else if (args.length === 0) {
    const registration = ensureServerRegistration();
    reportWarnings(registration);
    await configureCodex(registration);
  } else {
    throw new Error("Usage: xcodebug-setup-codex [--migrate-marketplace]");
  }
} catch (error) {
  console.error(`xcodebug setup-codex failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
