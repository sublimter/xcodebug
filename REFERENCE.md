# xcodebug reference

For client setup and migration, see the [installation guide](README.md). For
examples of running a test and reading its logs, see the [practical guide](GUIDE.md).

## Host availability

Availability is checked on the xcodebug execution host, not the client. Shared
configurations may remain installed on Linux/Windows; a Windows/Linux client can
use a server running on a Mac. Native interactive sessions warn once per loaded
extension. MCP exposes the notice in the tool description, never as a stdout banner.

| Action | Non-macOS behavior |
|---|---|
| `devices`, `changes`, `build`, `install`, `launch`, `syslog`, `terminate`, `restart` | `unsupported_platform` before the execution queue, project/cwd checks or Xcode/device commands. `changes` currently resolves a device/target too. |
| `doctor` | Reports platform and shell capabilities without Xcode probes; project cwd is not required when omitted. Missing optional metadata, such as the log directory, is reported without losing the rest of the diagnosis. |
| `feedback`, `history`, `status`, `stop` | Remain available with their usual dependencies and session constraints. Feedback still needs authenticated `gh`; stop still cancels work and cleans up. |
| `logs`, `wait` | Still require a valid capture; no platform restriction is added to local capture queries. |
| `await` or `command=` | Requires executable `/bin/sh`. Windows returns `unsupported_shell`; Linux/POSIX hosts are not blanket-disabled. |

Availability failures return `isError=true` and a machine-readable code in `details`;
MCP also exposes the error metadata in `structuredContent`. Rejections do not wait
behind running work or cancel it. Use a Mac execution host for Xcode/device actions.
An explicit `stop command=...` finishes cancellation and cleanup before reporting
an unsupported shell; its unusable command does not require project cwd lookup.


## MCP runtime and cancellation

Cancelling an MCP request aborts that request. On SIGINT, SIGTERM, or detected
stdout loss, the server stops accepting work, cancels admitted requests, and
starts cleanup. Stdin EOF alone drains admitted requests and sends their replies
before cleanup. A lost reader is not detected until stdout closes or a write fails.

Bare `stop` cancels running and queued xcodebug actions in this session/server,
then stops its captures. It can interrupt a build, pod install, command, or
wait before any capture starts. MCP handles it outside the action queue.
`stop captureId=...` stops only that capture and its companion. `keepApp=true`
leaves the app running.

Native stop waits up to five seconds for cleanup; native session shutdown has
a three-second cleanup deadline. MCP also bounds its wait for preceding
requests. An error with `cleanupPending=true` means resources are still
settling. Native pending cleanup retains the stopping display until tracked
resources settle, and later ordinary work waits behind those resources. A
stopped request's appended command does not start after incomplete cleanup.
Do not automatically restart stopped work. An interrupted pod install can
leave generated files incomplete; rerun it before building.

To run `npm test` from a checkout, use Node.js 22.18 or later and put Bun on
`PATH` for the stdio integration tests.

## Install the manual entry point

Marketplace plugins already include the [xcodebug skill](mcp/skills/xcodebug/SKILL.md).
For manual MCP setup, link it to get `/xcodebug` in Claude Code or `xcodebug` in
the Codex `$` picker. The skill uses your existing MCP registration; it does
not start a server.

Set `XCODEBUG_DIR` to the absolute path of your checkout or to
`"$(npm root -g)/xcodebug"`. Set `dest` for the client you are setting up:

- Claude Code: `dest="$HOME/.claude/skills/xcodebug"`
- Codex: `dest="$HOME/.agents/skills/xcodebug"`

Run this in the same shell:

```bash
(
  : "${XCODEBUG_DIR:?Set XCODEBUG_DIR to the package or checkout root}"
  : "${dest:?Set dest for the selected client}"
  source="$XCODEBUG_DIR/mcp/skills/xcodebug"
  test -f "$source/SKILL.md" || { printf 'Skill not found: %s\n' "$source/SKILL.md" >&2; exit 1; }
  if test -L "$dest" && test "$dest" -ef "$source"; then
    exit 0
  fi
  if test -e "$dest" || test -L "$dest"; then
    printf 'Existing skill path: %s; inspect it before installing.\n' "$dest" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")" && ln -s "$source" "$dest"
)
```

If an old link points to `skills/xcodebug`, inspect it and move it aside before
rerunning the recipe. An npm upgrade does not move the link. If the package
lacks `mcp/skills/xcodebug/SKILL.md`, use a checkout that contains it. Keep the
linked source in place and open a new client session.

## Use

Start the client in the project directory or a source subdirectory. Enter
actions in the client's chat input, not in the shell. Use the entry point in
the [installation overview](README.md#overview) and see [project discovery](#one-shot-xcodebug-what-to-verify)
for how xcodebug chooses a workspace and scheme.

A bare skill invocation calls `{"action":"launch"}`: it builds as needed, installs,
launches and starts capturing using the server's project/device defaults. Use
`status` to inspect captures without launching. An explicit action maps directly
to MCP arguments: `logs grep="Weather Sync" limit=100`
becomes `{"action":"logs","grep":"Weather Sync","limit":100}`. The skill keeps
quoted strings, numeric and boolean parameters, and JSON arrays/objects in their
tool-schema types. Add `captureId=...` to read or stop a specific capture.
Native registered slash-command text uses `action key=value ...` syntax.
JSON parameter objects belong to structured tool/MCP calls, not stringified
native command text.

The skill is a model instruction, not a direct RPC command: the model makes the
tool call and the client's permission rules still apply. It should execute the
requested action and report its result, rather than just explain how to do it.

Only pass options applicable to the requested action; do not populate unrelated
optional fields with default-looking values. Argument rejection is marked
`xcodebug <version>: invalid arguments (no action started):`. The skill may correct
arguments it introduced and retry the same tool/action once after that rejection.
It must not change user-supplied arguments or repeat an operation that started.

MCP optional parameters accept `null` as an explicit unset value for strict tool
clients. The adapter removes only known optional nulls before dispatch; it does not
erase `0`, `false`, empty strings, unknown fields or an invalid required `action`.
Native parameters remain non-nullable. On MCP, `stop captureId=null` is a **bare
stop**, equivalent to omitting the selector; use a real capture ID for scoped cleanup.

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
action=stop                     cancel executing/queued actions and stop captures
```

If a Marketplace skill is missing, check that the plugin is enabled and open a
new session. For manual setup, check the skill link and MCP registration
separately. A `Called xcodebug.xcodebug` line records a tool call; it is not a
command to type.

Live captures, cursors and the last launch belong to one server process. Stay
in the same client session for `launch` → `logs`/`wait` → `restart`/`stop`.
`history` can look up earlier runs stored under the same log directory, but it
does not restore a live capture or cursor in another client.

## MCP logs and display

MCP accepts `push=off` only. Read logs with `logs` or `wait`; neither the
Claude live band nor the Codex footer sends logs into the model's context.
See [Reading logs from a cursor](#reading-logs-from-a-cursor) for what a limited
read may omit.

MCP logs default to `~/.xcodebug/logs/xcodebug/`. To change the base directory,
set `XCODEBUG_AGENT_DIR`. The tool reports the exact log path.

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

Optional `.xcodebug.json`: the nearest file from the invocation directory up to
the Git worktree root wins. Outside Git, only the invocation directory is checked.

```json
{
  "workspace": "MyApp.xcworkspace",
  "scheme": "MyApp",
  "configuration": "Debug",
  "bundleId": "com.example.myapp",
  "device": "My-iPhone",
  "derivedDataPath": "build/DerivedData",
  "xcodebuildArgs": [],
  "args": [],
  "environment": {}
}
```

`device` may be a name, UDID, ECID or CoreDevice uuid. With one physical device
connected it can be omitted.

Configured workspace, project and derived-data paths are relative to this file;
explicit paths and relative `xcodebuildArgs` are resolved by the invocation
directory and Xcode respectively. Arguments are ordered argv elements, not a
shell string. Explicit options take precedence over configuration.

Invalid JSON or invalid field types are errors, not absent config. `doctor`
reports the selected path or error. `devices`, `logs`, `wait`, `history`,
`status`, `stop`, `await` and `feedback` do not read the config and still work.
`doctor` also reports the loaded package version, source path and source digest
(and Git revision when available). If the installed source changes, replies
tell you to restart the client even when the package version did not change.

## Xcode stage timeouts

| Stage | Default budget |
|---|---|
| Automatic scheme list and iOS app probing | 120 seconds per Xcode query |
| Build | 900 seconds |

`timeoutSeconds` overrides these budgets per invocation, not for the whole launch.
The maximum is `2147483.647` seconds, matching Node's timer limit.
Pod install runs before compilation with a separate clock. Other stages, including
post-build product lookup and automatic app installation, have independent limits.
MCP client timeouts and promotion of long calls to background tasks are separate
from these backend deadlines. A background launch is pending until its original
task returns a capture ID; it is not evidence that log capture has started.

A build-timeout reply reports the effective budget and elapsed build time; its log
header also records the build budget. Build logs store stdout followed by stderr,
not one chronologically merged stream. A warning timestamp at the end of that file
does not necessarily mark the build's last activity.

## Feedback

`feedback` submits a **public GitHub issue** to `sublimter/xcodebug`, not the
current app's repository. It works without an Xcode project or connected device.
Install GitHub CLI (`gh`) and authenticate with `gh auth login --hostname github.com`.

```text
/xcodebug feedback Log read timed out
/xcodebug feedback title="Log read timed out" body="Steps and actual error"
```
In short-description mode, configuration fragments such as `scheme=MiDong`, unknown
`key=value` text and flags are kept in the issue title, not interpreted as options.
Actual `title`, `body` or `timeoutSeconds` options select parameter mode. It requires
an explicit title (`title=` or `--title`) and rejects free-text descriptions. These names
inside other flag values, such as `--grep title=missing`, do not select parameter mode.
Use `feedback title="..." body="..." timeoutSeconds=5` instead of combining a short
description with body or timeout options; mixed forms are rejected, not silently rewritten.
Quote the whole description to send these fragments as text, e.g. `feedback 'body="literal"'`.
The first declared action, including a quoted action word or one after leading options,
cannot be overwritten by a conflicting `action=` or `--action` parameter.

For MCP, pass `{"action":"feedback","title":"Log read timed out","body":"Steps and actual error"}`.
`title` must be nonempty; `body` is optional and preserves Markdown and line breaks.
Only this supplied text is submitted. No logs, local files, configuration or
credentials are attached automatically. Review feedback for secrets before sending.

The result includes the created issue URL. The default request timeout is 60 seconds;
`timeoutSeconds` overrides it. Feedback follows the ordinary operation queue and
cancellation rules, but never starts or stops a device capture and rejects `command=`.
No submission is retried automatically. A timeout or cancellation may happen after
GitHub created the issue: inspect the issue URL or repository before submitting again.


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

Automatic `pod install` for new files runs once per change set per Podfile
directory, not on every run. Set `installPods=false` to skip it deliberately.

## One-shot: `/xcodebug <what to verify>`

```text
/xcodebug verify adding a city in Weather
```

Finds the Xcode container, rebuilds when needed, installs, launches and starts
capturing.
Native pi/omp can push logs into the conversation; Claude Code and Codex use
`logs`/`wait` pull reads through MCP. Both clients offer an optional live preview
for the user. The phrase is a goal, not a log filter.

- An explicit `workspace=` or `project=` replaces the configured container.
  Otherwise use the nearest container at or above the invocation directory,
  stopping at the Git worktree root. In a directory, workspaces outrank projects.
  If none is found, search a bounded depth below that root, skipping dependency,
  build and nested Git directories. Multiple candidates require explicit selection.
- A scheme passed explicitly or configured wins. Otherwise filter Xcode schemes
  by the current user's **Show** entries in the container and the workspace's
  referenced projects before bounded probing. Workspace entries override matching
  project entries; an entry without `isShown` is shown, but unrecorded schemes are
  ignored when management maps exist. With no current-user management metadata,
  retain Xcode's default-visible fallback.
  Prefer a shown iOS app scheme with the same name as its owning `.xcodeproj`.
  If the remaining schemes all build the same project target and app, choose the
  scheme named for that target. When multiple choices remain, pass `scheme=`.
  A pure Swift package needs a host iOS app.
- Scheme probes and builds receive the configured build arguments. Product
  lookup uses the build's flags and destination and rejects ambiguous or
  non-iOS app products. Build reuse keys include ordered flags and invocation cwd.
- **The outcome reaches the session**, including a failed build or install - not
  just a UI toast.

Native slash-command outcomes remain in the transcript and UI. Failed malformed-argument, preflight, and runtime commands are queued for the next user turn without waking the model. A successful `command=` run starts an analysis turn. `push=wake` explicitly starts a turn for a valid parsed request, including when that request later fails during preflight or runtime. Malformed arguments cannot establish push intent and always remain queued.

A leading action word is still honoured: `/xcodebug logs`, `/xcodebug stop`.

`/xcodebug restart` is the mid-run answer to "I just changed the code": it
rebuilds, reinstalls, relaunches and reattaches by replaying the last launch in
this session, so the phrase, device and scheme do not have to be retyped. It
forces the rebuild even though nothing about the invocation changed - the edited
code is the whole point - and it retires the previous capture for that app
through the same path as `launch`. The app identity parameters it remembers -
goal, bundleId, processName, device, scheme/workspace/project, configuration,
derivedDataPath, xcodebuildArgs, args, environment, push, match, dualChannel - are each
overridden by an explicit one (`/xcodebug restart device=My-iPhone`), so an
override is never silently ignored. `installPods` and `timeoutSeconds` are
per-invocation and always pass through. It remembers one launch - the most
recent - so after launching a second app, `restart` targets that second app.
The shell line a launch carried with `command=` is remembered too, and `restart`
runs it again after the relaunch - that is what closes the edit → restart → test
loop. Pass a new `command="..."` to override it, or `command=""` to clear it so
the next restart only rebuilds and relaunches.
Restart reads configuration, rebuilds, and reruns the command from the last
launch's working directory. Use a new `launch` to switch directories.

## `command=`: run a shell line alongside a capture

`command=` runs the supplied shell line and reports its exit status. If a capture
was active, xcodebug stops that capture and returns the log path plus a `logs`
query starting at the command's start cursor. Logs can be omitted from memory or
disk rotation; check the read's omission notes rather than treating it as a full
record. The command status is not a test assertion. xcodebug does not parse the
command or assume a particular test framework.

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
| the log records whatever they happened to do | the capture records app output while the case runs |
| the agent waits for a human, then reads | the agent reads as soon as the case exits |
| "it worked when I tried it" | exit status plus app logs for review |

The exit status only tells you whether the command returned zero. The log can
show what the app did while the command ran, subject to the capture's retention
limits. Read it from the cursor reported with the result.

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

The exit code reports the command's result. Only the command's own assertions
can establish that the UI reached the expected state. Read the app output from
the reported cursor for additional evidence:

```text
awaited cd /repo && npm test · exit 0 · 125s
stopped console-mvq1bclw · 5568 new line(s) · <agentDir>/logs/xcodebug/console-...log
next: xcodebug action=logs captureId=console-mvq1bclw since=12428
```

That `since=` starts at the command's cursor. It excludes earlier lines, but
does not guarantee that every line after that cursor is still available.

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
- It stops the targeted capture; other captures and their cursors remain independent.
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

- **Stop a completed goal's capture with `captureId`.** Keeping it alive consumes
  resources; native push also keeps sending log batches. Do not stop unrelated work.
- **Do not stop merely because the user has not acted yet.** Silence is not proof
  that the run is over: say what to do on the phone and keep listening, unless the
  user explicitly asks to stop.
- When the initial process-table query succeeds, a dual-channel launch runs
  console app-PID discovery before connecting the syslog companion. An explicit
  stop during that step does not leave a new companion running.
- A console capture ends when the app process is confirmed gone, and its syslog
  companion is stopped too. It records why - `the app exited`, with the last
  line logged, which is devicectl's own `App terminated due to signal 9.` when
  the app was killed - in the log file, in `status`, and under later `logs`
  reads. If the device wrote a crash report for the app, it is copied next to
  the log and its path is reported the same way. A standalone `syslog` capture
  is not bound to the app's lifetime and keeps reconnecting; stop it explicitly
  when finished.
- An interrupted `wait`, `await`, or `launch` with `command` joins the existing
  exit-diagnostic job (launch identity and report collection) before replying.
  A matching report supplies its
  system termination namespace, code and explanation, plus its local path, in
  the reply and follow-up details (`terminationReason`, `crashReport`). The
  report search can add time after the line-wait or command deadline; caller
  cancellation still interrupts it. A missing report or missing termination
  data is reported as unavailable, not replaced with a guessed cause. A verified
  App PID is required before a report can supply termination evidence; unknown
  identity is reported explicitly without promoting another instance's candidate
  report. Reattach-generation checks prevent an older search from overwriting
  the newly launched instance's report.
  Natural process exit registers that job before pipe/writer drain. Identity is
  taken from this console launch's own `--json-output` result
  (`result.process.processIdentifier`), not a late same-name process-table
  snapshot. Each bridge start owns a fresh result file, removed after reading;
  result identity and reattach-generation checks keep old jobs out of new runs.
  A missing, malformed or unsuccessful launch result remains unverified; an
  automatic reattach will not terminate an unverified running instance.
  `wait` joins both identity and report collection. When a command exits, its
  capture and queued reconnect are stopped before awaiting that independent job;
  confirmed termination likewise cancels reconnect without cancelling collection.
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
- The 30s silence watchdog applies only to a syslog companion and only while
  its primary console is still receiving logs. The watchdog stops the silent
  bridge; the exit hook handles reattachment.
- A standalone `action=syslog` still reconnects if its bridge exits, but does
  not restart a live bridge on silence alone: an idle app and a stalled bridge
  are indistinguishable without a console channel.
- In native pi/omp push modes, after 60s with no new lines the run says so once
  and keeps capturing. MCP users use `logs`/`wait` to inspect quiet captures.
- In pi/omp, a footer line and a widget above the editor show the live state,
  e.g. `📖 xcodebug · capturing · 7895 lines · 42s · /xcodebug stop to end`, plus
  recent log lines and the number of streaming channels. Claude Code can instead
  load the [live display Mod](README.md#claude-code-live-display).
  Codex can enable the [experimental status line](README.md#codex-live-display-experimental).
- Native pushed log batches are **hidden from the transcript** (`display: false`)
  but delivered to the model, subject to the per-batch limit. MCP does not push
  batches; neither MCP live display adds logs to model context.
- `/xcodebug stop` (or `action=stop`) without `captureId` cancels executing/queued
  work and closes **every running capture**, including during a build or command
  with no capture yet. An ID scopes the stop to that capture and its companion,
  leaving unrelated work alone. `keepApp=false` also terminates the app.

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
xcodebug action=logs grep=MySDK context=2
xcodebug action=wait match="DataPacket" timeoutSeconds=30
xcodebug action=wait match="sync (done|failed)" regex=true timeoutSeconds=30
xcodebug action=wait match="unexpected error" since=0 absent=true timeoutSeconds=30

xcodebug action=status
xcodebug action=history limit=5
xcodebug action=history captureId=<capture-id>
xcodebug action=stop keepApp=true
xcodebug action=terminate

# force a rebuild even when the tree is unchanged
xcodebug action=launch force=true
# skip the automatic pod install deliberately
xcodebug action=launch installPods=false

# edited the code mid-run: rebuild + relaunch the same app, same device, same goal
xcodebug action=restart

# run a shell line, stop its targeted capture, and report the log path and cursor
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

Filtered `logs` accepts `context=0..20` only with a non-empty `grep`; it includes
neighboring lines without counting them as matches. Do not send it with `launch`
or other actions, even as `0`. It is unrelated to `push="context"`.
Evidence replies cap text at 48 KiB and indicate
omissions; use the returned log paths for more. `wait` defaults to the most
recent query cursor for that capture; `since=0` deliberately replays old
evidence. A match from before the wait is labeled, not presented as a new event.

`wait absent=true` succeeds only when the full interval was observed with no
match and no known coverage gap. A match fails the assertion; missing data,
cancellation, a disconnected bridge or an ended capture cannot prove absence.

### Run history

`history` reads private JSON records under `<agentDir>/logs/xcodebug/runs/`.
Filter by exact `captureId`, `device` (name or ID), or `bundleId`; default limit
is 20, maximum 100. Records link primary and companion captures to the log
paths, device, Git HEAD, build fingerprint and build provenance when known.
A bound command contributes a short label, SHA-256 and exit outcome, not the
raw shell line, arguments or output. Finished records are retained for up to
30 days and at most 100 ended runs. `history` does not reattach to a capture.


### `syslog`: attach without relaunching

`launch` restarts the app because `devicectl --console` has to start it. When the
app is already running and the state you want to observe would not survive a
restart, attach instead:

```text
xcodebug action=syslog processName=MyApp
```

This runs `idevicesyslog -p <ProcessName>` and leaves the app running. It needs
`idevicesyslog` from libimobiledevice (`action=doctor` reports whether it is
present). It reads the device log for that process. `print` output requires the
console bridge; see the [capture sources](README.md#overview).

### Files

Every capture writes timestamped logs under
`<agentDir>/logs/xcodebug/<mode>-<bundleId>-<timestamp>-<random suffix>.log`.
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

Console launches also own a private `.xcodebug-launch-*` directory containing
`launch.json` and an `owner.json` marker with this extension's format, host PID
and creation time. The directory is mode `0700`; the marker is mode `0600`.
Result cleanup follows reading; raw metadata never enters the console log stream.
Ordinary `stop` leaves a pending result read available to exit diagnostics.
Session shutdown separately cancels those reads, blocks new bridge starts, and
allows up to three seconds per capture for pending startup, result cleanup and
log drainage, including older reattach results and captures evicted from visible
history. Blocked filesystem work or failed deletion is reported as incomplete
cleanup, including failures from captures already evicted from history.
Once cleanup settles, the session retains only the warning text for shutdown,
not the finished capture or its log buffer.
Residual result files may remain; task settlement alone is not proof of deletion.

The bundle id separates apps, and the timestamp includes milliseconds to
separate runs. Segment limits apply per capture. What xcodebug itself says while
a bridge is down - why the capture ended, each reattach - is appended to the same
file, so a log that stops also says why. A crash report copied from the device
lands beside the logs as `crash-<unique-id>-<name>.ips`. When the app PID is
known, a report without that PID is not retained.

Logs are kept for 30 days after their last write. The first `build`, `launch` or
`syslog` of a session deletes older `build-`, `console-`, `syslog-` and
`pod-install-` logs and `crash-*.ips` reports from this directory. The same
retention window applies to residual launch-result directories, but only when
the ownership marker is valid, the host PID is definitely absent, and the
directory and all known files are old. Active or uncertain owners, unmarked
legacy directories, malformed markers, symlinks and extra entries are retained.
Pruning removes only validated `owner.json` / `launch.json` files and an empty
directory, never recursively deleting a directory based on its prefix.

A successful build clears `<agentDir>/logs/xcodebug/archive/` first, so snapshots
from a previous binary cannot be mistaken for the run that is starting.

### Device archiving is off

Pulling the device unified log on a timer is disabled. Measured on an 18-minute
run it cost ~208 MB per snapshot (each covers the whole previous hour) with no
reader, and it cannot serve its stated purpose: `log show --archive ... | grep
MySDK` returns nothing, because `NSLog`/`print` never enters the unified log.
Only framework records (RunningBoard, CFNetwork, WebKit) come back, so a dropped
console bridge is recovered by reconnecting, not by replaying an archive.

