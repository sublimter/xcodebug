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

# pin a version, or install from a checkout
pi install npm:xcodebug@1.0.0
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

## Requirements

| Need | Why |
|---|---|
| macOS + Xcode (command-line tools) | `xcodebuild`, `xcrun devicectl` |
| `idevicesyslog` from libimobiledevice | optional; only `syslog` and the dual-channel safety net |
| git | change detection; without a repo every run rebuilds |
| CocoaPods | optional; only projects with a `Podfile` |

`xcodebug action=doctor` reports which of these are present.

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

## Change detection and pod install

Every `build` and `launch` first inspects the working tree with
`git status --porcelain -uall`:

1. **Any build-relevant change** (sources, resources, Podfile, podspec, project
   files) forces a rebuild + relaunch.
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
4. **No change** since the last successful build in this session reuses that
   build instead of rebuilding for minutes. Pass `force=true` to override.

Inspect the decision without building:

```text
xcodebug action=changes
```

```text
2 build-relevant change(s)
   M Packages/FeatureX/Classes/Weather/AddCityController.swift
fingerprint: 963e92a4
rebuild needed: yes
pod install needed: no
```

`pod install` runs once per change set (tracked by fingerprint), not on every
run. Set `installPods=false` to skip it deliberately.

## One-shot: `/xcodebug <what to verify>`

```text
/xcodebug 验证天气添加城市
```

Detects the workspace from the current directory (walking up, so a nested cwd
works), rebuilds when the tree changed, installs, launches, and streams the
console into this session. The phrase is a goal for the model, not a log filter.

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
/xcodebug 分析天气添加城市 command="cd /repo && npm run test:weather"
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
   phrase `分析天气添加城市` attached as the goal the analysis must answer.

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

A bare `/xcodebug` (or `/xcodebug 分析xxx`) has **no deadline**: it launches,
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
successful "run finished".

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
capturing. Set it in the config the run uses. A command that does not touch the
app (a curl, a fixture import, a codegen step) has no such constraint.

### Run semantics

Verification is a loop: run, read the log, conclude, stop, edit the code, run
again. Each `launch` or `syslog` retires the previous cycle's capture for that same
app **before** the new bridge starts, so the two never push the same app's lines
into one conversation; other apps keep streaming, so several apps can be
debugged in one session.

- **Stop once the log has answered the question.** Keeping a capture alive after
  the conclusion only floods the session.
- **Do not stop while the user has not acted yet.** Silence there means nothing
  has been tried, not that the run is over: say what to do on the phone and keep
  listening.
- A capture ends on its own when the app process exits. A run whose app the user
  deliberately closed is not reconnected.
- A dropped console bridge otherwise reconnects indefinitely. An inconclusive
  probe (USB unplugged, `devicectl` timeout) is **not** treated as "the app exited".
- `idevicesyslog` can go silent with its process still alive; a 30s watchdog kills
  it and the exit hook reattaches. Reattachment has exactly one owner, so the
  watchdog and the exit hook can never both assume the other is handling it.
- After 60s with no new lines the run says so once and keeps capturing.
- A footer line and a widget above the editor show the live state, e.g.
  `📖 xcodebug · capturing · 7895 lines · 42s · /xcodebug stop to end`, plus the
  last few log lines and how many channels are streaming.
- Pushed log batches are **hidden from the transcript** (`display: false`) but
  still delivered to the model, which is the only consumer that needs every
  line. The screen keeps one status line instead of a wall of log frames.
- `/xcodebug stop` (or `action=stop`) closes **every running capture** - the
  console bridge and its syslog companion, plus any other app still streaming.
  Pass `captureId=` to close one. `keepApp=false` also terminates the app.

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
xcodebug action=wait match="DataPacket" timeoutSeconds=30

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

### Pushing logs into the conversation

`push` controls whether new lines are mirrored into the session:

- `context` (default) — new lines are queued for the next turn (does not start one).
- `off` — pull with `logs`/`wait` only.
- `wake` — new lines start a turn.

A device console is a firehose; the push carries at most 80 lines per tick and
reports how many older lines it dropped. Combine it with `match` to keep it
useful, e.g. `xcodebug action=launch match=MySDK push=wake`.

### Files

Every capture also writes a full log to
`<agentDir>/logs/xcodebug/<mode>-<bundleId>-<YYYY-MM-DD_HH-mm-ss-SSS>.log`, so
nothing is lost when the in-memory ring buffer (20k lines) rolls over.

The app's bundle id is part of the name because several apps are debugged in
one session; the timestamp carries milliseconds so a relaunch of the same app
cannot reuse the previous run's file (files are opened in append mode, so a
collision would interleave two runs with no way to tell them apart).

A successful build clears `<agentDir>/logs/xcodebug/archive/` first, so snapshots
from a previous binary cannot be mistaken for the run that is starting.

### Device archiving is off

Pulling the device unified log on a timer is disabled. Measured on an 18-minute
run it cost ~208 MB per snapshot (each covers the whole previous hour) with no
reader, and it cannot serve its stated purpose: `log show --archive ... | grep
MySDK` returns nothing, because `NSLog`/`print` never enters the unified log.
Only framework records (RunningBoard, CFNetwork, WebKit) come back, so a dropped
console bridge is recovered by reconnecting, not by replaying an archive.
