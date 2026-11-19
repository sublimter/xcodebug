# xcodebug

Drive a **physical iOS device** from the agent session: build/install/launch with
Xcode, then read the app's console output (stdout/stderr + os_log) inside the
session.

No jailbreak, no LLDB attach, no paid account. It uses the tooling Xcode itself
ships with:

| What Xcode's console shows | How xcodebug gets it |
|---|---|
| `print` / `NSLog` / `os_log` | `xcrun devicectl device process launch --console` |
| os_log in the console | `OS_ACTIVITY_DT_MODE=YES` on that launch |
| an app you don't want to restart | `idevicesyslog -p <ProcessName>` (optional) |
| build + install | `xcodebuild` + `xcrun devicectl device install app` |

`devicectl --console` needs the app to be launched *by* it, so `launch` restarts
the app. `syslog` attaches to an already-running process instead.

## Install

The extension is a directory with `index.ts` plus a `pi` manifest; either install
it as a package or drop the directory in place.

```bash
# from npm (writes to ~/.pi/agent/settings.json)
pi install npm:xcodebug
pi install npm:xcodebug -l      # project scope: .pi/settings.json

# explicitly select the latest release, or install from a checkout
pi install npm:xcodebug@latest
pi install /path/to/xcodebug
```

**Upgrading from `xcodebug-extension`:** the package was renamed, so both names
register the same `xcodebug` tool and the loader refuses to start the second one
(`Tool "xcodebug" conflicts with ...`). Remove the old package first:

```bash
pi remove npm:xcodebug-extension
pi install npm:xcodebug
```

Or copy the directory into the global extensions dir, which the engine discovers
on startup:

```text
<agentDir>/extensions/xcodebug/index.ts
```

`<agentDir>` is whatever the host resolves (`~/.omo/agent` under OmO,
`~/.omp/agent` under omp, `~/.senpi/agent` under senpi, `~/.pi/agent` under
upstream pi): xcodebug is a generic pi extension and names no brand.

**Restart the session** afterwards. Neither pi nor omp reloads an already-loaded
extension: pi has no reload command at all, and omp's `/reload-plugins` only
clears plugin discovery, not the imported module graph. Editing `index.ts` while
a session is running therefore has no effect on that session.

## Claude Code and Codex (MCP)

The shared actions reach both clients through MCP. `mcp/server.ts` loads
`index.ts` with a stub host and serves the tool it registers, so it exposes the
same actions and arguments as the pi extension rather than a parallel
implementation. Claude Code can also load the optional native display below.

### Set up (once per machine)

```bash
npm i -g xcodebug@latest   # installs the latest published release
codex  mcp add xcodebug -- bun "$(npm root -g)/xcodebug/mcp/server.ts"
claude mcp add --scope user xcodebug -- bun "$(npm root -g)/xcodebug/mcp/server.ts"
```

Working from a checkout instead? Point both at `mcp/server.ts` in the repo:

```bash
codex  mcp add xcodebug -- bun /path/to/xcodebug/mcp/server.ts
claude mcp add --scope user xcodebug -- bun /path/to/xcodebug/mcp/server.ts
```

Bun is required ([bun.sh](https://bun.sh)). The sources are TypeScript, and Node
refuses to strip types for files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) - which is exactly where npm
installs the package, so `node` cannot start an installed copy. Bun loads the
same file from either location, so one command covers both.

Check that the client picked it up:

```bash
codex  mcp list     # xcodebug  bun …
claude mcp list     # xcodebug: … ✔ Connected
```

Set Codex's MCP timeout high enough for the stages your calls use. For example,
4200 seconds leaves room for the default 15-minute pod install, 15-minute build
and 30-minute command budgets, plus device operations. Increase it if you pass
larger timeouts; the client can still cancel before xcodebug's own deadline.

```toml
[mcp_servers.xcodebug]
tool_timeout_sec = 4200
```

Claude Code needs no setting for this. Its default limit on a tool call is about
28 hours. It also ends a call to a stdio server that has sent neither a reply
nor a progress notification for 30 minutes; this server sends progress once a
second to a client that asks for it.

Cancelling an MCP request aborts that request. On SIGINT, SIGTERM or detected
stdout loss, the server stops accepting work, cancels admitted requests and
then cleans up captures. Closing only stdin lets admitted requests finish and
sends their replies; a silent lost reader cannot be distinguished from this
until stdout closes or a write fails.

To run `npm test` from a checkout, use Node.js 22.18 or later and put Bun on PATH
for the stdio integration tests.

### Install the manual entry point

Connecting MCP makes the tool available to the model; it does not register a
`/xcodebug` command in either client. The shared
[xcodebug skill](skills/xcodebug/SKILL.md) adds an explicit entry point:
`/xcodebug` in Claude Code, `$xcodebug` in Codex, or Codex's `/skills` picker.

Both clients can read the same skill directory through user-level symlinks:

```bash
XCODEBUG_DIR="/absolute/path/to/xcodebug"  # a checkout containing the skill
# For an npm package that includes the skill, use this instead:
# XCODEBUG_DIR="$(npm root -g)/xcodebug"

(
  source="$XCODEBUG_DIR/skills/xcodebug"
  test -f "$source/SKILL.md" || { printf 'Skill not found: %s\n' "$source/SKILL.md" >&2; exit 1; }
  for dest in "$HOME/.agents/skills/xcodebug" "$HOME/.claude/skills/xcodebug"; do
    if test -e "$dest" || test -L "$dest"; then
      if ! test -L "$dest" || ! test "$dest" -ef "$source"; then
        printf 'Existing skill path: %s; inspect it before installing.\n' "$dest" >&2
        exit 1
      fi
    fi
  done
  mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" || exit 1
  for dest in "$HOME/.agents/skills/xcodebug" "$HOME/.claude/skills/xcodebug"; do
    test -L "$dest" || ln -s "$source" "$dest" || exit 1
  done
)
```

If the installed package does not contain `skills/xcodebug/SKILL.md`, use a
checkout that contains it. The commands check both target paths before installing,
skip symlinks already pointing to this skill, and stop on other existing files,
directories or symlinks, including broken links.
Keep the checkout or npm package at the linked path. Updating that source updates
the shared skill for both clients.

Start a new Claude Code or Codex session after installing. The skill uses the
MCP connection already configured above; it does not start a separate server or
replace the native pi command. Both manual and model-selected invocation remain
available. See the clients' [Claude Code skill documentation](https://code.claude.com/docs/en/skills)
and [Codex skill documentation](https://learn.chatgpt.com/docs/build-skills).

### Use

Start the client **in the project directory**. The server inherits its cwd, and
that directory is the project root every action resolves against.

```bash
cd ~/myapp          # holds the .xcworkspace or .xcodeproj
codex               # or: claude
```

Enter these in the client's chat input, not in your shell, after installing the skill:

| Operation | Claude Code | Codex |
|---|---|---|
| Build, install and launch with defaults | `/xcodebug` | `$xcodebug` |
| Show capture status | `/xcodebug status` | `$xcodebug status` |
| Check the toolchain | `/xcodebug doctor` | `$xcodebug doctor` |
| List devices | `/xcodebug devices` | `$xcodebug devices` |
| Build, install and launch | `/xcodebug launch scheme=MyApp` | `$xcodebug launch scheme=MyApp` |
| Read filtered logs | `/xcodebug logs grep="Weather Sync" limit=100` | `$xcodebug logs grep="Weather Sync" limit=100` |
| Wait for an event | `/xcodebug wait match="sync complete" timeoutSeconds=30` | `$xcodebug wait match="sync complete" timeoutSeconds=30` |
| Rebuild and rerun the last launch | `/xcodebug restart` | `$xcodebug restart` |
| Stop capture, leave the app running | `/xcodebug stop` | `$xcodebug stop` |

A bare skill invocation calls `{"action":"launch"}`: it builds as needed, installs,
launches and starts capturing using the server's project/device defaults. Use
`status` to inspect captures without launching. An explicit action maps directly
to MCP arguments: `logs grep="Weather Sync" limit=100`
becomes `{"action":"logs","grep":"Weather Sync","limit":100}`. The skill keeps
quoted strings, numeric and boolean parameters, and JSON arrays/objects in their
tool-schema types. Add `captureId=...` to read or stop a specific capture.

The skill is a model instruction, not a direct RPC command: the model makes the
tool call and the client's permission rules still apply. It should execute the
requested action and report its result, rather than just explain how to do it.
Natural-language goals can also select the skill:

```text
Build and launch on my device, then show me the console.
```

The actions that matter in this mode:

```text
action=launch device=<udid>     build + install + launch; the capture starts
action=logs since=0             incremental read - the cursor is per capture
action=logs grep=Weather        narrow to one subsystem
action=wait match="..."         block until a line appears
action=status                   captures, line counts, log paths
action=stop                     close every running capture
```

If the entry point is missing, check the symlink and restart the client. If the
skill is found but the MCP tool is missing, check `claude mcp list` or Codex's
`/mcp`; installing the skill alone does not connect MCP. A `Called
xcodebug.xcodebug` line is a tool-call record, not a command to type.

Capture IDs, cursors and the last launch belong to one MCP server process.
Claude Code and Codex each start their own server, so a capture created in one
client cannot be read or stopped in the other. Stay in the same client session
for `launch` → `logs`/`wait` → `restart`/`stop`.

### Claude Code live display

The live band needs three separate components: the `xcodebug` MCP server runs
the actions, the [shared skill](#install-the-manual-entry-point) provides
`/xcodebug`, and the `xcodebug-live` Mod draws above the prompt. Connecting MCP
or installing the skill alone does **not** load the Mod.

#### Prerequisites

Use Claude Code **2.1.323 or later** in an interactive terminal. Choose a checkout
or installed package that contains both the Mod and the updated MCP adapter:

```bash
XCODEBUG_DIR=/path/to/xcodebug
# For an npm package containing this feature:
# XCODEBUG_DIR="$(npm root -g)/xcodebug"
claude --version
test -f "$XCODEBUG_DIR/claude/.claude-plugin/plugin.json"
test -f "$XCODEBUG_DIR/mcp/server.ts"
```

If either file check fails, use a checkout containing the Mod and its updated
MCP adapter. Keep the MCP registration named `xcodebug` and point it at
`mcp/server.ts` from this same
root, using Bun. Follow [Set up](#set-up-once-per-machine) to register it, or
inspect an existing registration with `claude mcp get xcodebug`.

#### Install once for ordinary Claude sessions

Claude loads personal skills-directory plugins on startup. The display plugin
uses its own path, separate from the `xcodebug` skill. Run this in your shell
after setting `XCODEBUG_DIR` above:

```bash
(
  source="$XCODEBUG_DIR/claude"
  dest="$HOME/.claude/skills/xcodebug-live"
  test -f "$source/.claude-plugin/plugin.json" || {
    printf 'Missing Mod manifest: %s\n' "$source" >&2
    exit 1
  }
  if test -e "$dest" || test -L "$dest"; then
    test -L "$dest" && test "$dest" -ef "$source" || {
      printf 'Existing plugin path: %s\n' "$dest" >&2
      exit 1
    }
  else
    mkdir -p "$(dirname "$dest")" && ln -s "$source" "$dest" || exit 1
  fi
)
```

This skips a correct existing link and refuses to overwrite another file,
directory, wrong link or broken link. Keep the source directory in place.
Check discovery, then start a new session normally:

```bash
claude plugin list     # xcodebug-live@skills-dir, enabled
claude
```

If this plugin was previously disabled, enable it with
`claude plugin enable xcodebug-live@skills-dir`. In the new session, `/plugin`
should list it and `/mcp` should show `xcodebug` connected. The official
[personal plugin loading rules](https://code.claude.com/docs/en/plugins/create#make-a-plugin-load-in-every-session)
describe this installation mechanism.

#### Use and expected display

From your app's working directory, use the installed skill in the same Claude
session:

```text
/xcodebug launch scheme=MyApp
/xcodebug status
/xcodebug logs limit=100
/xcodebug stop
```

During build, install, launch, and the rebuild within `restart`, the band shows
the current phase and elapsed time. An operation's phase takes priority over
an existing capture; capture continues in the background. When the operation
finishes, fails, or is cancelled, the band returns to the running capture's
line count and latest four log lines.

It refreshes every second, between turns too, from a build, install, launch,
restart, syslog or await call until no operation or capture is running, then
clears and stops reading. A session that starts or reloads the Mod reads once
and resumes a capture already running. Calls that only read or end something
(`doctor`, `devices`, `changes`, `status`, `logs`, `wait`, `stop`, `terminate`)
do not start it unless they carry a `command`, and an idle session makes no
reads. An empty band is normal in
that idle state. Build
percentages are estimates; installation shows elapsed time, not an installation
percentage. These lines are displayed to you without entering model context
or starting model turns; use `logs`/`wait` when Claude needs to analyze them.

The Mod calls the read-only `xcodebug_ui` tool on the existing connection once
when a display starts. That in-memory read bypasses the action queue, so a
build or `wait` cannot block it. A tool call runs the session's `PreToolUse`
and `PostToolUse` hooks, so the reads after it come from a file instead: the
server keeps the same snapshot in `~/.xcodebug/ui/<pid>.json`, names it in the
`xcodebug_ui` answer and removes it when it exits; one left by a server that
was killed is removed by the next server to start. Each call that starts a
display asks the server again, as does a file that is missing or stops
changing; with an older server that names no file the Mod calls the tool on
every read. After three failed reads in a row it
stops and clears the band until the next such call. Reading does not change the
active capture or log cursors, and request progress still stops when its
originating call returns. No second server is started. The Mod leaves an
existing statusLine alone;
Codex does not load this Claude-only Mod.

#### If the band is missing

1. Run `claude plugin list` and check `/plugin` in the affected session.
   `xcodebug-live` must be loaded; seeing the `/xcodebug` skill or a connected
   MCP server does not establish that. Check `/plugin`'s Errors tab if loading
   failed. Safe mode, disabled Mods/hooks or managed settings can prevent it.
2. Check `/mcp` for the server named exactly `xcodebug`. An unavailable band or
   unknown `xcodebug_ui` tool usually means a missing connection or an older
   adapter. Inspect `claude mcp get xcodebug` to check the path.
3. Use `/xcodebug status` to check that a capture is running in this session.
   Captures in another client/session cannot populate this band's snapshot.
   With no running capture or published phase, the band is intentionally empty.
4. After updating the package, changing the server path or installing the Mod,
   restart Claude so both components load together. `/reload-plugins` can reload
   the Mod's files but does not restart the existing MCP server. `-p` sessions
   do not draw the band.

To disable the persistent display, run
`claude plugin disable xcodebug-live@skills-dir` and restart Claude; enable it
again with the matching `enable` command. Capturing and the shared skill
remain available without the display.

### What differs from pi

| | pi / omp / omo | Claude Code / Codex |
|---|---|---|
| how the tool is exposed | registered in-process | MCP server process |
| manual entry point | native `/xcodebug` | shared skill: `/xcodebug` in Claude, `$xcodebug` in Codex |
| status line, widget | yes | Claude: optional live Mod above; otherwise request progress when rendered |
| `push` | mirrors new lines into the session | `off` only; `context` and `wake` refused |
| capture state | in the session | in the server process |
| lifetime | the session | the client process |

- **The adapter refuses `push=context` and `push=wake`.** It does not implement
  background log delivery into model context. Read with `action=logs` or
  `action=wait`; these pull reads are separate from the Claude Mod's user-visible
  display. Cursor reads exclude earlier indices, but a limited read can omit
  lines; see [Reading logs from a cursor](#reading-logs-from-a-cursor).
- **Captures end with the client.** The server is a child of Codex/Claude. When
  the client closes the connection, the server finishes the call in progress,
  stops its captures and exits. On SIGINT or SIGTERM it stops at once, a build
  still running included. Relaunch next session.

Logs land in `~/.xcodebug/logs/xcodebug/`, or under `XCODEBUG_AGENT_DIR` when set.
Every response also reports the exact path, so the model can read the file once a
run is over.

## Xcode's own MCP

Xcode 27.1 ships an MCP server of its own (`xcrun mcpbridge`) with 54 tools:
workspace and project editing, build/run/stop, tests, previews, the debugger,
build settings, String Catalogs, crash and performance reports, and device
interaction (tap, swipe, screenshot, UI hierarchy). One of those tools does the
same job as this extension, so pick deliberately rather than registering both by
habit:

```bash
claude mcp add --transport stdio xcode -- xcrun mcpbridge
codex  mcp add xcode -- xcrun mcpbridge
```

Xcode asks for permission the first time an agent opens a project;
`xcrun mcp-server status` reports what has been granted.

`GetConsoleOutput` is the one that overlaps, and it is not a substitute:

| | Xcode `GetConsoleOutput` | xcodebug |
|---|---|---|
| source | the launch session `RunProject` created | any capture this extension started |
| positioning | `tailLimit` only - the last N lines | a cursor per capture; `since` resumes exactly |
| already-running app | only apps Xcode launched | `syslog` attaches without a relaunch |

So: **Xcode for anything that drives the IDE or the screen, xcodebug for the log
stream.** `GetConsoleOutput` answers "what did the last 500 lines say"; this
extension answers "what arrived since cursor 1694" - including from an app that
nobody launched from Xcode.

`RunProject` and `DeviceInteractionInstallAndRun` also build, install and launch.
They target whatever run destination Xcode has selected; `launch` takes a udid
directly.

## Requirements

| Need | Why |
|---|---|
| macOS + Xcode (command-line tools) | `xcodebuild`, `xcrun devicectl` |
| `idevicesyslog` from libimobiledevice | optional; only `syslog` and the dual-channel safety net |
| git | change detection; without a repo every run rebuilds |
| CocoaPods | optional; only projects with a `Podfile` |
| Bun | only for the MCP clients (Claude Code, Codex); pi runs the extension itself |

`xcodebug action=doctor` reports the Xcode toolchain, the capture tools, the
active config and the log directory.

## Imports

The only engine import is a type import, erased at compile time:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
```

That is the official specifier; loaders also alias `@code-yeongyu/senpi` and the
`@mariozechner/*` names to the same module. `typebox` is the other dependency,
for tool parameter schemas. Everything else is `node:` built-ins.

The extension is written against the **published** types, and that is enforced:
it typechecks against `@earendil-works/pi-coding-agent@1.4.0`, whose
`ExtensionContext` carries only `cwd` and `sessionManager` and whose
`ExtensionAPI` has no `cwd`. Hosts that add more - `ctx.agentDir`, `pi.cwd`,
`argumentHint` on a command - are supported without depending on them:

```typescript
if ("agentDir" in ctx) { /* host supplies it */ }
```

So the same file runs unchanged on every distribution, and a host that omits
those fields loses nothing: the project root falls back to `ctx.cwd`, and the
agent directory to the session directory's parent (every brand stores sessions at
`<agentDir>/sessions/<encoded-cwd>`), then to a `*_CODING_AGENT_DIR` environment
override. If none of those exist the extension fails naming what was missing
rather than writing logs to a guessed path.

## Configure (optional)

`.xcodebug.json` in the project root:

```json
{
  "workspace": "MyApp.xcworkspace",
  "scheme": "MyApp",
  "configuration": "Debug",
  "bundleId": "com.example.myapp",
  "device": "My-iPhone",
  "args": [],
  "environment": {}
}
```

`device` may be a name, UDID, ECID or CoreDevice uuid. With one physical device
connected it can be omitted.

A file that is not valid JSON is an error, not an absent config: `doctor` reports
it, and every action that would read it refuses to run rather than use the
defaults the file was written to override. The actions that never read it -
`devices`, `logs`, `wait`, `status`, `stop` and `await` - still work.

## Change detection and pod install

Every `build` and `launch` first inspects the working tree with
`git status --porcelain -uall`:

1. **Any change git reports** forces a rebuild + relaunch, tracked or not and
   whatever its type (`Podfile.rb`, an `.xcconfig`, a new image): a build that
   is reused must not be older than what it was built from. The exceptions are
   the types no build reads - notes, logs, crash reports and patches (`.md`,
   `.log`, `.ips`, `.patch`, `.diff`) - so what a run leaves in the tree does
   not trigger a build. A run that writes files of other types into the
   repository, such as JSON results, does.
2. **A new file inside a pod** forces `pod install --no-repo-update` first,
   because the generated Pods project enumerates pod sources and will not
   compile a file it has never seen. Pod membership comes from the repo's own
   podspec `source_files` globs, so `Packages/FeatureX/Classes/**` maps to
   `FeatureX`, etc.
3. **`Podfile.lock` out of step with `Pods/Manifest.lock`** also forces
   `pod install`. That mismatch fails every target's "[CP] Check Pods
   Manifest.lock" phase with an error the user cannot act on from a build log.

`pod install` only ever runs in the directory that holds the container's own
`Podfile` (the workspace's parent). If there is none, the step is skipped and
the reason is reported - it never searches elsewhere, because that could
reinstall a different project's pods.
4. **No change** since this session last built the same scheme, configuration
   and device reuses that build, for `launch` as well as `build`, instead of
   rebuilding for minutes. The app is still installed and launched. Pass
   `force=true` to rebuild. "No change" means all of:
   - the same committed code and the same uncommitted changes. A commit, pull or
     checkout rebuilds even though `git status` is clean again; `git add` alone
     does not;
   - the same files in every pod the workspace installs from a path outside the
     repository (`:path` in `Podfile.lock`), which `git status` cannot see;
   - the built `.app` is as that build left it. Xcode, or an `xcodebuild` in
     another terminal, writes the same product path.

   A build during which the tree changed is not reused, and its reply says so.

Inspect the decision without building:
Use the same target and device options as the intended build. If the target
cannot be resolved, the report cannot identify a reusable build. If pod install
is needed, the preview assumes a rebuild until the updated tree is available.

```text
xcodebug action=changes
```

```text
2 build-relevant change(s)
   M Packages/FeatureX/Classes/Weather/AddCityController.swift
fingerprint: 963e92a4
last build for this target: (none)
rebuild needed: yes
pod install needed: no
```

`pod install` runs once per change set (tracked by fingerprint), not on every
run. Set `installPods=false` to skip it deliberately.

## One-shot: `/xcodebug <what to verify>`

```text
/xcodebug verify adding a city in Weather
```

Detects the workspace from the current directory (walking up, so a nested cwd
works), rebuilds when the tree changed, installs, launches, and starts capturing.
Native pi/omp can push logs into the conversation; Claude Code and Codex use
`logs`/`wait` pull reads through MCP. The optional Claude Mod displays a console
tail to the user, not to the model. The phrase is a goal, not a log filter.

- **CocoaPods vs plain project** is decided by `Podfile`/`Podfile.lock`: a
  CocoaPods project uses its `.xcworkspace`, a plain project its `.xcodeproj`.
- **The scheme** defaults to the container's own name (`MyApp.xcworkspace`
  -> `MyApp`). That guess is checked once with `xcodebuild -list`; when it
  does not exist, the scheme files are read for the one declaring
  `BuildableName = "*.app"` (a workspace usually keeps its schemes in the
  sibling `.xcodeproj`).
- **The outcome reaches the session**, including a failed build or install - not
  just a UI toast.

A leading action word is still honoured: `/xcodebug logs`, `/xcodebug stop`.

`/xcodebug restart` is the mid-run answer to "I just changed the code": it
rebuilds, reinstalls, relaunches and reattaches by replaying the last launch in
this session, so the phrase, device and scheme do not have to be retyped. It
forces the rebuild even though nothing about the invocation changed - the edited
code is the whole point - and it retires the previous capture for that app
through the same path as `launch`. The app identity parameters it remembers -
goal, bundleId, processName, device, scheme/workspace/project, configuration,
derivedDataPath, args, environment, push, match, dualChannel - are each
overridden by an explicit one (`/xcodebug restart device=My-iPhone`), so an
override is never silently ignored. `installPods` and `timeoutSeconds` are
per-invocation and always pass through. It remembers one launch - the most
recent - so after launching a second app, `restart` targets that second app.
The shell line a launch carried with `command=` is remembered too, and `restart`
runs it again after the relaunch - that is what closes the edit → restart → test
loop. Pass a new `command="..."` to override it, or `command=""` to clear it so
the next restart only rebuilds and relaunches.

## `command=`: run a shell line alongside a capture

`command=` is a general primitive, not a test-runner hook: **any** shell line,
run to completion after the app is up, with the capture recording the whole time.
When it exits, the capture is stopped and you get the exit code plus the
app-side log for exactly that window. xcodebug knows nothing about the command's
contents - it never parses it, never assumes a framework.

That makes it the way to *provoke* something on the device and watch what the app
does in response:

| You want to see... | `command=` runs |
|---|---|
| an automated case tapping through a flow | `cd /repo && npm run test:weather` |
| a backend event reaching the app | `curl -X POST .../push -d @event.json` |
| a file/dataset the app then consumes | `./scripts/import-fixtures.sh` |
| a CLI driving the phone (deep link, locale, permission) | `xcrun simctl ...` / `idevice* ...` |
| a codegen or asset step whose output the app reloads | `npm run codegen` |
| a benchmark, then the log of that run | `./bench.sh --iterations 100` |

The app must already be running for this to mean anything, so `command=` is a
**second phase appended to the main action** - `/xcodebug command="..."` on its
own still launches first. Use `action=await` when the app is already up.

### Worked case: the automation stands in for the user

The most common use is replacing a human's taps. A capture alone only records
what the app does while **a person** drives the phone: slow to reproduce and
never quite identical twice.

```text
/xcodebug analyze adding a city in Weather command="cd /repo && npm run test:weather"
```

| Without `command=` | With `command=` |
|---|---|
| a person opens the weather page and adds a city | the case taps the same path |
| the log records whatever they happened to do | the log records exactly that path, every run |
| the agent waits for a human, then reads | the agent reads as soon as the case exits |
| "it worked when I tried it" | exit code + app-side log for the same run |

So the shape of a verification run is: **goal** (what to prove) + **command**
(how to provoke it) + **capture** (what the app did). The exit code says whether
the UI reached the expected state; the log says what the app did to get there -
which is the part a test assertion cannot see.

### The mechanics

That single line does the whole linkage run:

1. build + install + launch the app, start the console capture;
2. run the shell line to completion (blocking);
3. stop the capture it was watching;
4. report the exit code, the app-side cursor, and the log path - with the
   phrase `analyze adding a city in Weather` attached as the goal the analysis must answer.

`command=` is a **second phase appended to the main action**, never an action of
its own. That ordering is the point: a command is only meaningful when the app is
already built, launched and being captured, so `/xcodebug command="..."` on its
own still launches first.

The two-step form remains available when the app is already up:

```text
/xcodebug launch scheme=MyApp
/xcodebug await command="cd /repo && npm run test:weather"
```

```text
# equivalent spellings
xcodebug action=launch command="cd /repo && npm run test:weather"
xcodebug action=await command="cd /repo && npm run test:weather"
/xcodebug await command="cd /repo && npm run test:weather" timeoutSeconds=900
```

A bare `/xcodebug` (or `/xcodebug analyze <scenario>`) has **no deadline**: it launches,
streams, and waits for you. Nothing stops it except `stop`, a new launch of the
same app, or the app exiting.

`command` is an opaque **shell line** handed to `/bin/sh -lc`; xcodebug knows
nothing about any test framework. Two consequences worth knowing:

- **Quote the whole line.** `command="cd /repo && npm run test"`. Unquoted, the
  slash command splits on whitespace before it reads the value and only `cd`
  reaches the shell, so the run "succeeds" having run nothing - xcodebug now
  refuses that shape outright rather than guess.
- **Write `cd /repo && npm run test`, never `cd /repo npm run test`.** `cd`
  treats the trailing words as extra arguments and returns 0 without running
  anything, so the run looks like a pass. This one is inside a correctly quoted
  line, so xcodebug cannot detect it for you.
- **Let the repo pick its own config.** A repo with several test configs will
  fail with "No tests found" (exit 1) when run against the wrong one, which reads
  exactly like a failing test. An npm script
  (`"test:weather": "myrunner test --config myrunner-weather.config.ts"`)
  pins the right config once, where the repo already declares it.

What it reports: exit code, elapsed time, how many new lines the capture gained,
the log path, and the `action=logs` call (with the right `since`) that returns
the app side of that run. A non-zero exit is surfaced as an error, not as a
successful "run finished". Two things about the capture are reported when they
happened, because either one changes what the log means: that it was no longer
capturing when the command finished (with the reason, or the last line logged),
and that a console reattach relaunched the app during the run.

### What the model does with it

The command's exit code answers "did the UI reach the expected state". The log
answers "what did the app actually do", which no assertion can see. The cursor in
the report is what makes the second half cheap:

```text
awaited cd /repo && npm test · exit 0 · 125s
stopped console-mvq1bclw · 5568 new line(s) · <agentDir>/logs/xcodebug/console-...log
next: xcodebug action=logs captureId=console-mvq1bclw since=12428
```

That `since=` starts exactly where the case began, so the next call returns only
this run's app-side lines, not the 12k from launch:

```text
xcodebug action=logs captureId=console-mvq1bclw since=12428 grep=Weather
```

```text
  14572 MySDK: Net | WeatherService pushCities(payload) count=4
  14588 MySDK: Net | WeatherService pushCurrent(city="...") ok
```

Which is how "the case tapped add-city" becomes "the app pushed four cities".
Two patterns that keep it small:

- `grep=` narrows to the subsystem under test (a class name, a log prefix).
- `wait match="..."` blocks until an expected line appears, for the case where
  the assertion passes but the app's own path is what you need to see.

If the case fails, the same cursor still returns the app side, so the failure can
be read from both ends: the assertion says where the UI stopped, the log says why.

Boundaries that keep it out of every other workflow:

- `await` only stops **the capture it targets** (`captureId` > the active
  capture). A second app under debug keeps streaming.
- It never terminates the app (`stop keepApp=true` semantics), so the screen
  stays where the run left it.
- It writes no capture state, so a later `launch`/`stop`/`logs` is unaffected.
- No timer or silence heuristic is involved: the process exiting is the only
  automatic finish. `timeoutSeconds` (default 1800) bounds the child process
  only; on timeout the child is killed and the capture is still stopped, and
  the result is reported as an error.
- With no capture running, `await` still runs the command and reports the exit
  code instead of failing.

**Prerequisite when the command drives the UI:** the runner must not relaunch the
app. Many UI-test fixtures terminate and relaunch the app before every test
unless `autoAppLaunch: false` is set, which kills the very launch xcodebug is
capturing. Set it in the config the run uses. When it happens anyway, the capture
ends there and says the app was restarted outside it; it does not relaunch over
the runner's instance. A command that does not touch the app (a curl, a fixture
import, a codegen step) has no such constraint.

### Run semantics

Verification is a loop: run, read the log, conclude, stop, edit the code, run
again. Each `launch` or `syslog` retires the previous cycle's capture for that same
app **before** the new bridge starts, avoiding duplicate capture streams for that
app; other apps' captures are preserved, so several apps can be debugged in one
session.

- **Stop once the log has answered the question.** Keeping a capture alive consumes
  resources; with native push enabled, it also keeps sending log batches.
- **Do not stop while the user has not acted yet.** Silence there means nothing
  has been tried, not that the run is over: say what to do on the phone and keep
  listening.
- A console capture ends when the app process is confirmed gone, and its syslog
  companion is stopped too. It records why - `the app exited`, with the last
  line logged, which is devicectl's own `App terminated due to signal 9.` when
  the app was killed - in the log file, in `status`, and under later `logs`
  reads. If the device wrote a crash report for the app, it is copied next to
  the log and its path is reported the same way. A standalone `syslog` capture
  is not bound to the app's lifetime and keeps reconnecting; stop it explicitly
  when finished.
- A dropped console bridge whose app is still running is reattached, retrying
  for as long as it takes. devicectl attaches a console only by launching, so
  with the default `terminateExisting` **a reattach restarts the app** and its
  state is gone: the log says so and `status` counts the relaunches. An
  inconclusive probe (USB unplugged, `devicectl` timeout) is retried without
  relaunching. If the current PID is known but capture ownership cannot be
  verified, a reattach that would terminate the running app is skipped.
- If the instance running is not the one this capture launched - another
  session, a test runner or the user relaunched the app - the capture ends and
  leaves that instance alone. Reattaching would terminate it. The session that
  did the relaunching is told as well: its `launch` reply notes that the app was
  already running and not started by it.
- `idevicesyslog` can go silent with its process still alive; a 30s watchdog kills
  it and the exit hook reattaches. Reattachment has exactly one owner, so the
  watchdog and the exit hook can never both assume the other is handling it.
- In native pi/omp push modes, after 60s with no new lines the run says so once
  and keeps capturing. MCP users use `logs`/`wait` to inspect quiet captures.
- In pi/omp, a footer line and a widget above the editor show the live state,
  e.g. `📖 xcodebug · capturing · 7895 lines · 42s · /xcodebug stop to end`, plus
  recent log lines and the number of streaming channels. Claude Code can instead
  load the [live display Mod](#claude-code-live-display).
- Native pushed log batches are **hidden from the transcript** (`display: false`)
  but delivered to the model, subject to the per-batch limit. MCP does not push
  batches; the Claude Mod's display does not add logs to model context.
- `/xcodebug stop` (or `action=stop`) without `captureId` closes **every running
  capture**. An ID scopes the stop to that target; a console primary's syslog
  companion is stopped too. Other apps' captures are unaffected by a targeted
  stop. `keepApp=false` also terminates the app.

## Usage

```text
xcodebug action=devices
xcodebug action=doctor
xcodebug action=changes
xcodebug action=changes force=true

# build + install + launch, then stream the console
xcodebug action=launch scheme=MyApp

# build only
xcodebug action=build scheme=MyApp

# install an already-built .app without rebuilding
xcodebug action=install appPath=/path/to/App.app

# already-running app, no restart
xcodebug action=syslog processName=MyApp

# incremental reads (cursor-based)
xcodebug action=logs limit=200
xcodebug action=logs grep=MySDK
xcodebug action=logs grep=MySDK times=true
xcodebug action=wait match="DataPacket" timeoutSeconds=30
xcodebug action=wait match="sync (done|failed)" regex=true timeoutSeconds=30

xcodebug action=status
xcodebug action=stop keepApp=true
xcodebug action=terminate

# force a rebuild even when the tree is unchanged
xcodebug action=launch force=true
# skip the automatic pod install deliberately
xcodebug action=launch installPods=false

# edited the code mid-run: rebuild + relaunch the same app, same device, same goal
xcodebug action=restart

# run any shell line to completion, then stop the capture and hand back the log
xcodebug action=await command="cd /repo && npm run test:weather"
/xcodebug await command="cd /repo && npm run test:weather"
```

### Reading logs from a cursor

Every `logs` read returns a cursor: the latest absolute line index in that
capture. Pass it as `since` to exclude lines at or before that index. Reads
return the newest matching lines up to `limit`; if the response says older
lines were omitted, advancing to its cursor skips those lines too.

```text
xcodebug action=logs since=0 limit=2
  2 line(s) (1692 older omitted) · cursor 1694

xcodebug action=logs since=1694
  (no new lines since 1694; capture cursor is 1694)

xcodebug action=logs since=1694 limit=3
  3 line(s) (6135 older omitted) · cursor 7832
```

Each capture retains at most 20k lines and 4 MiB of text in memory (counted as
UTF-16 bytes, excluding object overhead). A line larger than that text budget
is written to disk and delivered to live subscribers but not retained for
`logs`. The session keeps the most recent 10 ended captures; active captures
and captures reconnecting after a bridge failure are not evicted. Older capture
IDs leave `logs`/`status`, while their retained disk segments remain available.

A busy app fills that buffer in seconds, so a filtered read does not stop at it.
`logs grep=...` and `wait` also search for lines missing from memory, including
oversized lines between retained entries. They wait for writes through the
scan's cursor before reading disk; cancellation interrupts that work. The reply
reports how many lines were searched on disk and how many are unavailable.
An unfiltered `logs` returns the newest lines as before and
names the log file for the rest.

`regex=true` makes `grep` and `match` regular expressions, so one `wait` can
cover both outcomes of a step: `match="sync (done|failed)"`. `times=true`
prefixes each returned line with the host time it arrived, for lining the log
up with a test runner's own output.

### `syslog`: attach without relaunching

`launch` restarts the app because `devicectl --console` has to start it. When the
app is already running and the state you want to observe would not survive a
restart, attach instead:

```text
xcodebug action=syslog processName=MyApp
```

This runs `idevicesyslog -p <ProcessName>` and leaves the app running. It needs
`idevicesyslog` from libimobiledevice (`action=doctor` reports whether it is
present), and it reads the device log for that process - `print` output still
only comes from the console bridge, per the table at the top.

### Pushing logs into the conversation

In native pi/omp, `push` controls whether new lines are mirrored into the session.
The MCP adapter accepts only `off`; Claude Code and Codex use `logs`/`wait`.

- `context` (default) — new lines are queued for the next turn (does not start one).
- `off` — pull with `logs`/`wait` only.
- `wake` — new lines start a turn.

A device console is a firehose; the push carries at most 80 lines per tick and
reports how many older lines it dropped. Combine it with `match` to keep it
useful, e.g. `xcodebug action=launch match=MySDK push=wake`.

### Files

Every capture writes timestamped logs under
`<agentDir>/logs/xcodebug/<mode>-<bundleId>-<YYYY-MM-DD_HH-mm-ss-SSS>.log`.
It rotates through that base path plus `.1` and `.2`, replacing the oldest
segment after three segments. Each segment targets 50 MiB and keeps complete
lines (a single larger line may exceed that size). Logging continues after
rotation; it no longer stops at the first 50 MiB. Capture status details list
successfully opened paths in chronological order as `logFiles`; `logFile` stays
the stable base path. Reconnecting appends to the current segment.

Disk writes apply backpressure to both capture pipes, so a slow disk pauses
ingestion instead of accumulating an unlimited write queue. After the bridge
exits, capture shutdown allows up to two seconds for the pipes and pending file
writes to drain. If they remain blocked, it destroys the streams, reports a
drain-timeout error in capture status, and completes shutdown; pending logs may
be truncated.

The bundle id separates apps, and the timestamp includes milliseconds to
separate runs. Segment limits apply per capture. What xcodebug itself says while
a bridge is down - why the capture ended, each reattach - is appended to the same
file, so a log that stops also says why. A crash report copied from the device
lands beside the logs as `crash-<unique-id>-<name>.ips`. When the app PID is
known, a report without that PID is not retained.

Logs are kept for 30 days after their last write. The first `build`, `launch` or
`syslog` of a session deletes older `build-`, `console-`, `syslog-` and
`pod-install-` logs and `crash-*.ips` reports from this directory, and nothing
else in it.

A successful build clears `<agentDir>/logs/xcodebug/archive/` first, so snapshots
from a previous binary cannot be mistaken for the run that is starting.

### Device archiving is off

Pulling the device unified log on a timer is disabled. Measured on an 18-minute
run it cost ~208 MB per snapshot (each covers the whole previous hour) with no
reader, and it cannot serve its stated purpose: `log show --archive ... | grep
MySDK` returns nothing, because `NSLog`/`print` never enters the unified log.
Only framework records (RunningBoard, CFNetwork, WebKit) come back, so a dropped
console bridge is recovered by reconnecting, not by replaying an archive.
