import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import xcodebug from "../index.ts";
import { parseCommandArgs, parameters, validateParameters } from "../parameters.ts";
import { runtimeVersion } from "../version.ts";

test("slash arguments preserve quoted shell commands, typed JSON and explicit actions", () => {
  assert.deepEqual({ ...parseCommandArgs(`action=build --force false xcodebuildArgs='["-quiet","A=B C"]'`) }, {
    action: "build", force: false, xcodebuildArgs: ["-quiet", "A=B C"],
  });
  assert.equal(parseCommandArgs(`await command="printf '%s' 'two words'"`).command, "printf '%s' 'two words'");
  assert.deepEqual(parseCommandArgs(`launch environment='{"MODE":"a b"}'`).environment, { MODE: "a b" });
  assert.equal(parseCommandArgs("验证启动日志").goal, "验证启动日志");
  assert.equal(parseCommandArgs("history --limit 2").limit, 2);
  assert.equal(parseCommandArgs("wait match=ok --absent").absent, true);
});

test("malformed slash arguments reach the user before an action starts", async () => {
  let slash;
  const sent = [];
  xcodebug({ registerTool() {}, registerCommand(_, command) { slash = command.handler; },
    on() {}, sendMessage(message) { sent.push(message); } });
  const ctx = { ui: { notify() {}, setStatus() {}, setWidget() {} } };
  for (const [input, reason] of [
    ["status typo=1", /unknown.*typo/i], ["status since=no", /since/],
    ["status force=maybe", /force/], ["status context=-1", /context/],
    ["launch context=0", /context requires action=logs with grep/],
    ["status args='{}'", /args/], ["status environment='{'", /environment/],
    ['status grep="unterminated', /quote/i], ["await command=cd /missing", /quoted/i],
  ]) {
    await slash(input, ctx);
    const message = sent.at(-1);
    assert.equal(message.details.isError, true, input);
    assert.match(message.content, reason, input);
    assert.ok(message.content.startsWith(`xcodebug ${runtimeVersion.identity.version}: invalid arguments (no action started):`),
      message.content);
  }
});
test("zero context is rejected unless it is a filtered logs request", () => {
  assert.throws(() => validateParameters({ action: "launch", context: 0 }),
    /invalid arguments \(no action started\): context requires action=logs with grep/);
  assert.throws(() => validateParameters({ action: "status", context: 0 }), /context requires action=logs with grep/);
  assert.throws(() => validateParameters({ action: "logs", context: 0 }), /context requires action=logs with grep/);
  assert.doesNotThrow(() => validateParameters({ action: "logs", grep: "x", context: 0 }));
});

test("timeoutSeconds rejects values beyond the Node timer limit", () => {
  assert.throws(() => validateParameters({ action: "status", timeoutSeconds: 2_147_483.648 }), /timeoutSeconds/);
  assert.doesNotThrow(() => validateParameters({ action: "status", timeoutSeconds: 2_147_483.647 }));
});

test("the tool advertises the same shape the native handler validates", async () => {
  let tool;
  xcodebug({ registerTool(value) { tool = value; }, registerCommand() {}, on() {} });
  assert.equal(tool.parameters.additionalProperties, false);
  for (const value of [null, [], "status", { action: "status", since: -1 }, { action: "status", limit: 0 }]) {
    await assert.rejects(tool.execute("test", value, undefined, undefined, {}), error => {
      assert.ok(error.message.includes(runtimeVersion.identity.version), error.message);
      return true;
    });
  }
});

test("native IR constructors project typed arguments and strict validation to JSON Schema", () => {
  const moduleUrl = new URL("../parameters.ts", import.meta.url).href;
  const facade = `import { Type as original } from ${JSON.stringify(import.meta.resolve("typebox"))};
    export const Type = { ...original, Object(...args) {
      const json = original.Object(...args);
      return { ir: {}, get json() { return { domain: "object", required: [] }; },
        toJsonSchema(options) {
          if (options.target !== "draft-07") throw new Error("unexpected schema target");
          return json;
        } };
    } };`;
  const facadeUrl = `data:text/javascript,${encodeURIComponent(facade)}`;
  const loader = `export function resolve(specifier, context, next) {
    if (specifier === "typebox" && context.parentURL === ${JSON.stringify(moduleUrl)})
      return { url: ${JSON.stringify(facadeUrl)}, shortCircuit: true };
    return next(specifier, context);
  }`;
  execFileSync(process.execPath, ["--no-warnings", "--loader", `data:text/javascript,${encodeURIComponent(loader)}`,
    "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const { parseCommandArgs, validateParameters } = await import(${JSON.stringify(moduleUrl)});
      assert.deepEqual({ ...parseCommandArgs("launch device=test-device timeoutSeconds=3600 push=off force=false") },
        { action: "launch", device: "test-device", timeoutSeconds: 3600, push: "off", force: false });
      assert.throws(() => parseCommandArgs("status typo=1"), /unknown parameter/);
      assert.throws(() => validateParameters({ action: "launch", context: 0 }), /context requires action=logs with grep/);
    `], { stdio: "pipe" });
});
