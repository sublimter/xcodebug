# xcodebug — practical guide

## Overview

Install xcodebug for [pi/omp](README.md#piomp-extension),
[Claude Code](README.md#claude-code), or [Codex](README.md#codex). Then open a
new session in the Xcode project and run `doctor` using the entry point for
your client. [README.md](README.md) also has the configuration and action reference.

Examples below use pi/omp's `/xcodebug` syntax. For Claude Code and Codex, use
the same action and arguments with the skill listed in the client sections
at the end of this guide. A bare invocation launches the app. Use `status`
if you only want to inspect an existing capture.

### The one-liner

```text
/xcodebug verify adding a weather city
```

From the current directory it finds the workspace, rebuilds if the tree changed,
installs, launches, and starts capturing. The trailing phrase is the goal the
model must answer — not a log filter.

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

Actions and examples are in [README.md § Usage](README.md#usage). Two actions
with nonobvious behavior:

- `stop` without `captureId` cancels running/queued xcodebug actions and closes
  **every running capture**, even when only a build or command is running.
  With an ID, it only stops that capture and its syslog companion, leaving
  unrelated execution alone. `keepApp=true` is the default and leaves the app running.
  Cancelling pod install does not roll back generated files; rerun it before building.
  Stop waits up to five seconds for native cleanup; shutdown keeps its three-second
  deadline. `cleanupPending=true` is an error: resources remain unfinished, pending
  native cleanup retains its stopping display, and later work waits for settlement.
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

`command=` is a general primitive: any shell line, run to completion after the app
is up, with the capture recording the whole time. When it exits you get the exit
code plus the app-side log for exactly that window. xcodebug never parses the
line and assumes no framework.

That makes it how you *provoke* something and watch the app react — an automated
case tapping through a flow, a backend push, a fixture import, a CLI driving the
phone, a codegen step the app reloads, a benchmark.

The most common use is replacing a human's taps: a capture alone only records
what the app does while **a person** drives the phone — slow to reproduce and
never quite identical twice. `command=` hands the driving to an automated case:
the case performs the taps, the capture records the app's response, and the model
reads that delta.

```text
without command=                      with command=
  a person opens the weather page       the case taps the same path
  the log holds whatever they did       the log holds exactly that path, every run
  the agent waits, then reads           the agent reads as soon as the case exits
  "it worked when I tried it"           exit code + app-side log for one run
```

So a verification run is **goal** (what to prove) + **command** (how to provoke
it) + **capture** (what the app did). The exit code says the UI reached the
expected state; the log says what the app did to get there.

#### The shape of it

Scenario: bring the app up under capture, run an automated case, then read the
app side of that run. xcodebug knows nothing about any test framework — you put
the command in `command`.

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
5. It hands back the exit code, elapsed time, how many new lines arrived, the
   log path, and the `logs` call (with the right `since`) for the app side.

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

### Where files land

Every capture is mirrored to
`<agentDir>/logs/xcodebug/<mode>-<bundleId>-<timestamp>-<random suffix>.log`.

In pi/omp, `agentDir` comes from the host (`ctx.agentDir`, else the parent of the
session directory), so each brand writes under its own prefix (`.pi` / `.omp` /
`.omo` / `.senpi`). MCP defaults to `~/.xcodebug`, overridden by
`XCODEBUG_AGENT_DIR`. The bundle id separates apps, and the timestamp includes
milliseconds to separate runs.

Memory retains at most 20k lines and 4 MiB of text. Disk logging rotates through
the base path plus `.1` and `.2`, retaining three segments targeting 50 MiB each;
older segments are overwritten. Complete lines are kept, so a single oversized
line can exceed a segment's target size. Shutdown allows two seconds to drain
pending writes; a drain timeout can truncate logs. Neither memory nor disk is
a lossless archive of the whole run. See [retention](README.md#reading-logs-from-a-cursor)
and [disk files](README.md#files) for details and the `logFiles` path list.

A filtered read (`logs grep=`, `wait`) looks in those files for the lines memory
has dropped and says in its reply that it did. Logs are deleted 30 days after
their last write.

Console launch-result JSON is temporary metadata, not a log. Ordinary `stop`
preserves pending exit diagnostics; session exit instead cancels result reads
and bounds startup/result cleanup as well as log drainage. Incomplete cleanup
is reported. Ownership-checked stale-result reclamation and its conservative
exceptions are documented under [disk files](README.md#files).

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
turn or `push=off` to read logs explicitly. See [native push modes](README.md#pushing-logs-into-the-conversation).

## Claude Code

With Marketplace, run `/xcodebug:xcodebug doctor` and then
`/xcodebug:xcodebug launch scheme=MyApp`. The manual skill uses `/xcodebug`
instead. The [live band](README.md#claude-code-live-display) shows the current
operation or recent capture lines. An empty band during idle is normal.

## Codex

Select `xcodebug:xcodebug` in the `$` picker (or `xcodebug` for the manual
skill), then ask for `doctor` or `launch scheme=MyApp`. The
[live footer](README.md#codex-live-display-experimental) is optional. If
`quiet` advances while the line count stays unchanged, the footer is still
refreshing. Run `status` and `logs captureId=<id>` through the same skill in
the same session to inspect the capture.
