import assert from "node:assert/strict";
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
    ["status args='{}'", /args/], ["status environment='{'", /environment/],
    ['status grep="unterminated', /quote/i], ["await command=cd /missing", /quoted/i],
  ]) {
    await slash(input, ctx);
    const message = sent.at(-1);
    assert.equal(message.details.isError, true, input);
    assert.match(message.content, reason, input);
    assert.ok(message.content.includes(runtimeVersion.identity.version), message.content);
  }
});
test("zero context is rejected unless it is a filtered logs request", () => {
  assert.throws(() => validateParameters({ action: "status", context: 0 }), /context requires action=logs with grep/);
  assert.throws(() => validateParameters({ action: "logs", context: 0 }), /context requires action=logs with grep/);
  assert.doesNotThrow(() => validateParameters({ action: "logs", grep: "x", context: 0 }));
});

test("the tool advertises the same shape the native handler validates", async () => {
  let tool;
  xcodebug({ registerTool(value) { tool = value; }, registerCommand() {}, on() {} });
  assert.equal(tool.parameters, parameters);
  assert.equal(tool.parameters.additionalProperties, false);
  for (const value of [null, [], "status", { action: "status", since: -1 }, { action: "status", limit: 0 }]) {
    await assert.rejects(tool.execute("test", value, undefined, undefined, {}), error => {
      assert.ok(error.message.includes(runtimeVersion.identity.version), error.message);
      return true;
    });
  }
});
