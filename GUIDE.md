# xcodebug — practical guide

## Overview

Install xcodebug for [pi/omp](README.md#piomp-extension),
[Claude Code](README.md#claude-code), or [Codex](README.md#codex). Open a new
session in your Xcode project and run `doctor` using that client's entry point.
The [installation guide](README.md) covers setup and migration; the
[reference](REFERENCE.md) has settings and action details.

Examples below use pi/omp's `/xcodebug` syntax. Use the same action and arguments
with the entry point for [pi/omp](#piomp-extension), [Claude Code](#claude-code),
or [Codex](#codex). A bare invocation launches the app. Use `status` to inspect
an existing capture without launching.

### The one-liner

```text
/xcodebug verify adding a weather city
```

From the current directory it finds the workspace, rebuilds if the tree changed,
installs, launches, and starts capturing. The trailing phrase is the goal the
model must answer — not a log filter.

Without an explicit or configured `scheme`, xcodebug filters the selected
container's schemes using the current user's Show entries. It prefers a shown
iOS app scheme named after its owning `.xcodeproj`; an ambiguous choice still
requires `scheme=...`. See [project discovery](REFERENCE.md#one-shot-xcodebug-what-to-verify)
for workspace overrides, fallback behavior and probe limits.

### Commands and tool calls

**Native command examples**

```text
/xcodebug
/xcodebug status
/xcodebug launch scheme=MyApp
/xcodebug logs grep=MySDK
/xcodebug stop
/xcodebug analyse weather command="cd /repo && npm run test:xxx"
```

Native command text uses `action key=value ...`. JSON parameter objects are for
structured tool/MCP calls, not stringified native slash-command text.

**Tool call** (for the model)

```text
xcodebug action=launch scheme=MyApp
xcodebug action=logs limit=200
```

Actions and examples are in [REFERENCE.md](REFERENCE.md#usage). Two actions
with nonobvious behavior:

- `stop` without `captureId` cancels running/queued xcodebug actions and closes
  **every running capture**, even when only a build or command is running.
  With an ID, it only stops that capture and its syslog companion, leaving
  unrelated execution alone. `keepApp=true` is the default and leaves the app running.
  Cancelling pod install does not roll back generated files; rerun it before building.
  Stop waits up to five seconds for native cleanup; shutdown keeps its three-second
  deadline. `cleanupPending=true` is an error: cleanup is not finished. The native
  stopping display remains until resources close, and later work waits for them.
  An appended command is skipped when cleanup is incomplete.
  Do not restart cancelled work unless the user requests it.
- `restart` replays the last launch of this session, rebuilding and rerunning
  any saved `command=` from that launch's working directory.

### How logs reach the conversation

In Claude Code and Codex, use `logs` to read new lines or `wait` to look for
an expected line. MCP only accepts `push=off`. Neither client's live display
sends logs to the model.

### Running a command alongside a capture

#### What it is for

`command=` runs a shell line after the app is up. xcodebug reports its exit
status. If a capture is active, it also returns the log path and a query starting
at the command's cursor. Logs may be omitted as the capture fills or rotates.

The command can provoke something on the device and let you inspect the app's
response. For example, it can run an automated case that taps through a flow,
send a backend push, import a fixture, or start a benchmark.

- `command=` lets an automated test drive the UI while xcodebug records console output.
- The command's exit status is evidence about that command, not a test assertion.
- The capture log shows app output during the run, subject to its retention limits.

#### The shape of it

Run the test command while the app is being captured. xcodebug does not interpret
the command as a test framework or check whether its assertions passed.

```text
# one line: build + install + launch -> run the case -> stop the capture -> hand back the log
/xcodebug analyse weather city command="cd /repo && npm run test:weather"
```

```text
# or in two steps, when the app is already up
/xcodebug launch scheme=MyApp
/xcodebug await command="cd /repo && npm run test:weather"
```

What happens after `command`:

1. `/bin/sh -lc` runs the whole line from the invocation directory. `restart`
   uses the last launch directory.
2. It waits for the process to exit.
3. It stops **the capture it targeted** and cancels its queued reconnect — other
   apps' captures keep streaming.
4. When collecting exit diagnostics, it waits for the owned console-launch
   result and matching crash-report collection independently of the stopped
   capture; caller cancellation still interrupts that wait.
5. It reports the exit status, elapsed time, number of new log lines, the log
   path, and a `logs` query starting at the command's cursor.

**Quote the whole line.** `command="cd /repo && npm run test"`. Unquoted, the
slash command splits on whitespace before it reads the value, so only `cd`
reaches the shell and the run "succeeds" having executed nothing — xcodebug now
rejects that shape instead of guessing.

**Always join `cd` with `&&`.** `command="cd /repo npm run test"` makes `cd`
swallow the remaining words as arguments and exit 0 without running anything,
which looks like a pass. This one is inside a correctly quoted line, so xcodebug
cannot detect it for you.

Let the repo pick its own config through an npm script
(`"test:weather": "myrunner test --config myrunner-weather.config.ts"`).
Running `myrunner test <file>` against the wrong config exits 1 with
`No tests found`, which is indistinguishable from a failing case.

#### Why this does not disturb other debugging

`await` is not a mode, just an explicit call. Nothing changes for runs that do
not pass `command=` or `action=await`.

- It stops only the capture it targeted (`captureId` > active capture); a second
  app's capture keeps streaming.
- It never kills the app (`stop keepApp=true` semantics), so the screen stays
  where the run left it.
- It records the command label, hash and outcome in `history`, without saving the shell line.
- No timer and no "quiet for N seconds means done" heuristic: process exit is the
  only automatic finish.
- `timeoutSeconds` (default 1800) bounds the child process only; on timeout the
  child is killed, the capture is still stopped, and the result is reported as an
  error.
- With no capture running it still runs the case and reports the exit code.

#### Prerequisite: the test must not relaunch the app

Many UI-test fixtures terminate and relaunch the app before every test unless
`autoAppLaunch: false` is set. That kills the very launch xcodebug is capturing,
so the log stops there. Commands that do not drive the UI have no such
constraint.

Set this in the config the run uses:

```ts
use: {
  autoAppLaunch: false,
}
```

A cold launch can also restore a child page instead of the tab bar. If a case
starts by tapping a tab, it has to handle that state itself — xcodebug launches
the app and nothing more.

### Everyday commands

```text
# environment
xcodebug action=devices
xcodebug action=doctor
xcodebug action=changes

# launch and relaunch
xcodebug action=launch scheme=MyApp
xcodebug action=launch force=true          # rebuild even with no changes
xcodebug action=launch installPods=false   # skip the automatic pod install
xcodebug action=restart                    # after editing: rebuild + relaunch + reuse params
xcodebug action=launch timeoutSeconds=1800  # explicitly allow longer discovery/build stages

# read logs
xcodebug action=logs limit=200
xcodebug action=logs grep=MySDK
xcodebug action=wait match="DataPacket" timeoutSeconds=30
xcodebug action=wait match="sync (done|failed)" regex=true   # either outcome, one wait
xcodebug action=wait match="unexpected error" absent=true timeoutSeconds=30
xcodebug action=history limit=5

# wrap up
xcodebug action=status
xcodebug action=stop keepApp=true
xcodebug action=terminate

# run a command alongside the capture
xcodebug action=await command="cd /repo && npm run test:weather"
```

`timeoutSeconds` sets per-stage budgets, not a total launch deadline. For larger
workspaces, request a longer budget explicitly rather than repeatedly rerunning
a timed-out build. See [Xcode stage timeouts](REFERENCE.md#xcode-stage-timeouts).

### Where files land

Every capture is mirrored to
`<agentDir>/logs/xcodebug/<mode>-<bundleId>-<timestamp>-<random suffix>.log`.

In pi/omp, `agentDir` comes from the host (`ctx.agentDir`, else the parent of the
session directory), so each brand writes under its own prefix (`.pi` / `.omp` /
`.omo` / `.senpi`). MCP defaults to `~/.xcodebug`, overridden by
`XCODEBUG_AGENT_DIR`. The bundle id separates apps, and the timestamp includes
milliseconds to separate runs.

Memory holds up to 20,000 lines and 4 MiB. Disk logs rotate across three files
of about 50 MiB each. Old data can be dropped, and a blocked shutdown can leave
the last log incomplete. See [REFERENCE.md](REFERENCE.md#files) for retention
details and the list of log paths.

### Three rules of use

1. **Stop a completed goal's capture with `captureId`.** Do not stop unrelated
   execution or other captures; do not leave the completed capture streaming.
2. **Do not stop merely because the user has not acted yet.** Silence is not proof
   of completion. Say what to tap and keep listening, unless the user asks to stop.
3. **A console capture ends when the app process is confirmed gone.** Its syslog
   companion is stopped too, and `status` says why it ended and where the crash
   report is, if the device wrote one. A standalone `syslog` capture is not
   bound to the app's lifetime and keeps reconnecting; stop it explicitly when
   finished.

## pi/omp extension

Run `/xcodebug doctor` or `/xcodebug launch scheme=MyApp` in the project session.
The native command calls the extension directly. To send new logs to the model
in the next turn, use `push=context` (the default). Use `push=wake` to start a
turn or `push=off` to read logs. See [native push modes](README.md#pushing-logs-into-the-conversation).

## Claude Code

With Marketplace, run `/xcodebug:xcodebug doctor`, then
`/xcodebug:xcodebug launch scheme=MyApp`. The manual skill uses `/xcodebug`.
The [live band](README.md#claude-code-live-display) shows work and recent lines;
it is empty when the session has nothing to show.

## Codex

Select `xcodebug:xcodebug` in the `$` picker, or select the `xcodebug` skill for
a manual install. Ask it to run `doctor` or `launch scheme=MyApp`. The
[optional live footer](README.md#codex-live-display-experimental) shows work and
capture state. If `quiet` advances without a new line, use `status` and
`logs captureId=<id>` in the same session to inspect that capture.
