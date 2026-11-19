# xcodebug — practical guide

Task-oriented walkthrough. [README.md](README.md) is the authoritative reference
for every parameter, the change-detection rules and the capture internals; this
file only shows the flows you will actually type.

The `/xcodebug` examples use the native pi/omp command or the installed Claude
Code skill. In Codex, replace `/xcodebug` with `$xcodebug`. Claude Code and Codex
need both the MCP connection and the shared skill; follow
[README.md § Install the manual entry point](README.md#install-the-manual-entry-point).
Enter these commands in the client's chat input. A bare `/xcodebug` (`$xcodebug`
in Codex) builds as needed, installs, launches and starts capturing with defaults.
Use `/xcodebug status` (`$xcodebug status` in Codex) to inspect current captures.

Debug a real iOS device: build, install, launch, and read the app's console
(stdout/stderr + os_log) inside the agent session. No jailbreak, no LLDB attach,
no paid account.

## The one-liner

```text
/xcodebug verify adding a weather city
```

From the current directory it finds the workspace, rebuilds if the tree changed,
installs, launches, and starts capturing. The trailing phrase is the goal the
model must answer — not a log filter.

## Two surfaces

**User entry point** (native command in pi/omp; installed skill in Claude Code/Codex)

```text
/xcodebug
/xcodebug status
/xcodebug launch scheme=MyApp
/xcodebug logs grep=MySDK
/xcodebug stop
/xcodebug analyse weather command="cd /repo && npm run test:xxx"
```

**Tool call** (for the model)

```text
xcodebug action=launch scheme=MyApp
xcodebug action=logs limit=200
```

The 14 actions and their parameters are tabulated in
[README.md § Usage](README.md#usage). Two of them differ from what the name
suggests, so they are repeated here:

- `stop` without `captureId` closes **every running capture**. With an ID, it
  stops that target; stopping a console primary also stops its syslog companion.
  Other apps' captures are unaffected by a targeted stop. `keepApp=true` is the
  default and leaves the app running.
- `restart` replays the last launch of this session — device, scheme, goal and
  the `command=` it carried — and forces a rebuild.

## How logs reach the conversation

In pi/omp, `push` decides whether new lines are mirrored into the session: `context`
(default, queued for the next turn), `off` (pull with `logs`/`wait`), `wake`
(starts a turn). A device console is a firehose; each push carries at most 80
lines and reports how many older lines it dropped. Narrow it with `match`, e.g.
`action=launch match=MySDK push=wake`.

Claude Code and Codex use pull reads through MCP: `logs` for an incremental read,
or `wait` for an expected line. `push=context` and `push=wake` are refused there;
installing the skill does not add background log delivery.

For a live display in Claude Code, install the **separate** `xcodebug-live` Mod
using [the one-time installation recipe](README.md#install-once-for-ordinary-claude-sessions).
It then loads with ordinary `claude` startup. The MCP connection and shared
skill alone do not load it. Confirm `xcodebug-live@skills-dir` in
`claude plugin list`, then restart Claude and check `/plugin` and `/mcp`.

Keep the `xcodebug` MCP server pointed at the same updated checkout or installed
package as the Mod.

The band shows build/install/launch phases, including the rebuild within
`restart`, even when a capture is already running. Capture continues in the
background; after the operation finishes, fails, or is cancelled, the band
returns to the running capture's line count and latest four console lines.
It refreshes once a second, between turns too, while an operation or capture is
running, then clears and stops reading; an idle session makes no reads. It does
not send those lines to the model; use `logs`/`wait`
for analysis.
See [Claude Code live display](README.md#claude-code-live-display) for version
requirements, upgrade/disable steps and missing-display troubleshooting.

## Running a command alongside a capture

### What it is for

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

### The shape of it

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

1. `/bin/sh -lc` runs the whole line, with the project root as the working
   directory (`pi.cwd` → `ctx.cwd` → process cwd).
2. It waits for the process to exit.
3. It stops **the capture it targeted** — other apps' captures keep streaming.
4. It hands back the exit code, elapsed time, how many new lines arrived, the
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

### Why this does not disturb other debugging

`await` is not a mode, just an explicit call. Nothing changes for runs that do
not pass `command=` or `action=await`.

- It stops only the capture it targeted (`captureId` > active capture); a second
  app's capture keeps streaming.
- It never kills the app (`stop keepApp=true` semantics), so the screen stays
  where the run left it.
- It writes no capture state, so a later `launch`/`stop`/`logs` is unaffected.
- No timer and no "quiet for N seconds means done" heuristic: process exit is the
  only automatic finish.
- `timeoutSeconds` (default 1800) bounds the child process only; on timeout the
  child is killed, the capture is still stopped, and the result is reported as an
  error.
- With no capture running it still runs the case and reports the exit code.

### Prerequisite: the test must not relaunch the app

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

## Everyday commands

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

# wrap up
xcodebug action=status
xcodebug action=stop keepApp=true
xcodebug action=terminate

# run a command alongside the capture
xcodebug action=await command="cd /repo && npm run test:weather"
```

## Where files land

Every capture is mirrored to
`<agentDir>/logs/xcodebug/<mode>-<bundleId>-<YYYY-MM-DD_HH-mm-ss-SSS>.log`.

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

## Three rules of use

1. **Stop once the log has answered the question.** A capture left running keeps
   consuming capture resources; native push modes also keep sending log batches.
2. **Do not stop while the user has not acted yet.** Silence there means "not
   tried yet", not "finished" — say what to tap and keep listening.
3. **A console capture ends when the app process is confirmed gone.** Its syslog
   companion is stopped too, and `status` says why it ended and where the crash
   report is, if the device wrote one. A standalone `syslog` capture is not
   bound to the app's lifetime and keeps reconnecting; stop it explicitly when
   finished.
