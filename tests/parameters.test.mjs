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
  assert.deepEqual({ ...parseCommandArgs("--scheme feedback --action launch feedback screen") },
    { action: "launch", scheme: "feedback", goal: "feedback screen" });
  assert.deepEqual({ ...parseCommandArgs('scheme=MiDong "status"') }, { action: "status", scheme: "MiDong" });
});

test("feedback descriptions become issue titles without stealing explicit launch goals", () => {
  assert.deepEqual({ ...parseCommandArgs("feedback 读取日志时超时") }, { action: "feedback", title: "读取日志时超时" });
  assert.deepEqual({ ...parseCommandArgs('feedback title="Log failed" body="line one\nline two"') },
    { action: "feedback", title: "Log failed", body: "line one\nline two" });
  assert.deepEqual({ ...parseCommandArgs("action=launch feedback screen") }, { action: "launch", goal: "feedback screen" });
  for (const args of ["feedback", 'feedback title=" "', 'feedback description title="Title"',
    'feedback title="Title" command="exit 0"']) assert.throws(() => parseCommandArgs(args), /invalid arguments \(no action started\)/);
});

test("feedback descriptions preserve configuration and error fragments as literal text", () => {
  for (const prefix of ["feedback", '"feedback"', "'feedback'", "action=feedback", "--action feedback", "--action=feedback"]) {
    for (const description of ["scheme=MiDong 运行失败", "foo=bar --force 读取失败", '"scheme=MiDong 运行失败"']) {
      assert.deepEqual({ ...parseCommandArgs(`${prefix} ${description}`) },
        { action: "feedback", title: description.replace(/^"|"$/g, "") });
    }
  }
  assert.deepEqual({ ...parseCommandArgs('feedback --title "Log failed" --body "scheme=MiDong"') },
    { action: "feedback", title: "Log failed", body: "scheme=MiDong" });
  assert.deepEqual({ ...parseCommandArgs('feedback body="Steps" title="Log failed" timeoutSeconds=5') },
    { action: "feedback", body: "Steps", title: "Log failed", timeoutSeconds: 5 });
});

test("feedback descriptions keep control names used as flag values", () => {
  for (const description of ["查询失败 --grep title=missing scheme=MiDong", "查询失败 --grep title=missing foo=bar",
    "查询失败 --grep action=launch foo=bar", "查询失败 --grep body=missing foo=bar",
    "查询失败 --grep timeoutSeconds=5 foo=bar", "查询失败 --force false --grep title=missing foo=bar"]) {
    assert.deepEqual({ ...parseCommandArgs(`feedback ${description}`) }, { action: "feedback", title: description });
  }
  assert.deepEqual({ ...parseCommandArgs("feedback --body title=missing --title action=launch") },
    { action: "feedback", body: "title=missing", title: "action=launch" });
});

test("feedback parameter mode requires an explicit title and rejects free descriptions", () => {
  for (const input of ['feedback 读取失败 body="Steps" timeoutSeconds=5', 'feedback 读取失败 --body "Steps"',
    "feedback 读取失败 timeoutSeconds=5", 'feedback body="Steps"', "feedback --timeoutSeconds 5",
    'feedback --grep title=missing title="Report" 查询失败']) {
    assert.throws(() => parseCommandArgs(input), /invalid arguments \(no action started\)/, input);
  }
  assert.deepEqual({ ...parseCommandArgs('feedback title="读取失败" body="Steps" timeoutSeconds=5') },
    { action: "feedback", title: "读取失败", body: "Steps", timeoutSeconds: 5 });
  assert.deepEqual({ ...parseCommandArgs(`feedback '读取失败 body="Steps" timeoutSeconds=5'`) },
    { action: "feedback", title: '读取失败 body="Steps" timeoutSeconds=5' });
});

test("declared actions cannot be overridden by later action parameters", () => {
  for (const input of ["feedback 读取日志失败 action=launch", "feedback 读取日志失败 --action launch",
    '"feedback" 读取日志失败 action=launch', "'feedback' 读取日志失败 --action launch",
    'timeoutSeconds=5 "feedback" 读取日志失败 action=launch', "--scheme MiDong feedback --action=launch",
    "scheme=MiDong status action=launch", "goal text action=feedback action=launch",
    'feedback title="Log failed" --action=launch', "status action=launch", "action=feedback action=launch"]) {
    assert.throws(() => parseCommandArgs(input), /conflicting action declarations/, input);
  }
});

test("feedback fields are action-specific and reject text that cannot be passed to a command", () => {
  assert.throws(() => validateParameters({ action: "status", title: "Report" }), /title and body require action=feedback/);
  assert.throws(() => validateParameters({ action: "launch", body: "Report" }), /title and body require action=feedback/);
  assert.throws(() => validateParameters({ action: "feedback", title: "Report", body: "bad\0text" }), /cannot contain NUL/);
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
    ["feedback 读取日志失败 action=launch", /conflicting action declarations/],
    ['feedback description title="Title"', /use either a feedback description or title=/],
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
