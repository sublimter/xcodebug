# xcodebug — practical guide

Task-oriented walkthrough. [README.md](README.md) is the authoritative reference
for every parameter, the change-detection rules and the capture internals; this
file only shows the flows you will actually type.

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

**Slash command** (for humans)

```text
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

- `stop` closes **every running capture** (the console bridge and its syslog
  companion, plus any other app still streaming). Pass `captureId=` to close one.
  `keepApp=true` is the default and leaves the app running.
- `restart` replays the last launch of this session — device, scheme, goal and
  the `command=` it carried — and forces a rebuild.

## How logs reach the conversation

`push` decides whether new lines are mirrored into the session: `context`
(default, queued for the next turn), `off` (pull with `logs`/`wait`), `wake`
(starts a turn). A device console is a firehose; each push carries at most 80
lines and reports how many older lines it dropped. Narrow it with `match`, e.g.
`action=launch match=MySDK push=wake`.

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

`agentDir` comes from the host (`ctx.agentDir`, else the parent of the session
directory), so each brand writes under its own prefix (`.pi` / `.omp` / `.omo` /
`.senpi`); the extension hardcodes none of them. The bundle id is in the name
because several apps are debugged in one session, and the timestamp carries
milliseconds because relaunching the same app within a second would otherwise
interleave two runs in one file. The in-memory ring buffer keeps the last 20k
lines; the file on disk is complete.

## Three rules of use

1. **Stop once the log has answered the question.** A capture left running only
   keeps flooding the session.
2. **Do not stop while the user has not acted yet.** Silence there means "not
   tried yet", not "finished" — say what to tap and keep listening.
3. **A capture ends on its own when the app process exits.** Do not reconnect a
   run whose app the user deliberately closed.
