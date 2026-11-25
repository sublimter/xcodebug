# xcodebug — practical guide

Task-oriented walkthrough. [README.md](README.md) is the authoritative reference
for every parameter, the change-detection rules and the capture internals; this
file only shows the flows you will actually type.

The `/xcodebug` examples use the native pi/omp command or the manually installed
Claude Code skill. With the [Marketplace plugin](README.md#install-from-marketplace),
use `/xcodebug:xcodebug` in Claude Code or select the plugin's xcodebug skill
with `$` in Codex. For a manual MCP connection, install the
[shared skill](README.md#install-the-manual-entry-point) separately.
A bare invocation builds as needed, installs, launches and starts capturing.
Add `status` to inspect the current captures without launching.

For a manual installation only, run `xcodebug-setup-codex` once. It registers
the server when missing, adds the 4200-second timeout only when no custom
timeout exists, enables the statusline feature on Codex CLI 0.171.0+, and selects
the xcodebug provider when the user selection is missing or `default`. Other
custom providers are preserved with a warning.
It also checks the running app-server version; both CLI and service must support
the feature. An old or unverifiable service gets a warning, not an automatic
upgrade or restart that could interrupt active tasks and captures.
From a checkout, use `node bin/xcodebug-setup-codex.mjs`. Open a new Codex session
after setup. If another custom provider was preserved, select `xcodebug_ui`
(`xcodebug / xcodebug_ui`) through `/statusline` → **Choose a status line provider**
or set `tui.status_line_provider` explicitly. If another process changes the
configuration while setup runs, the stale write is rejected; rerun setup.
See [README.md § Codex live display](README.md#codex-live-display-experimental)
for the configuration and global inventory discovery timeout details.

Native pi/omp `/xcodebug` dispatches directly to the loaded extension handler,
without skill/model selection for that dispatch. The package excludes its
bundled skill from native package discovery; Claude/Codex share `mcp/skills/xcodebug/SKILL.md`.
If a native host also discovers that user-level shared skill, it routes to the native tool
when available. Reading a skill alone never executes an action; model-selected
requests still require a tool call, while the native command runs its handler.

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

Actions and examples are in [README.md § Usage](README.md#usage). Two actions
with nonobvious behavior:

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

Claude Code's Marketplace plugin includes the live display Mod. For a manual
installation, add the separate `xcodebug-live` Mod with
[the one-time installation recipe](README.md#install-once-for-ordinary-claude-sessions).
Keep the MCP server and Mod on the same release. In a new session, check
`/plugin` for the enabled plugin and `/mcp` for the connected server.

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

For the optional footer, follow the
[Codex live display setup](README.md#codex-live-display-experimental). When
`quiet` advances but the count and latest line stay unchanged, the footer is
still refreshing. Use `$xcodebug status` and `$xcodebug logs captureId=<id>` in
the same Codex session to check the capture. A new session does not inherit it.
When idle, the footer mirrors the supported fields from Codex's current
snapshot without switching providers.

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

1. `/bin/sh -lc` runs the whole line from the invocation directory (`ctx.cwd`
   → `pi.cwd` → process cwd).
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

### Why this does not disturb other debugging

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
xcodebug action=wait match="unexpected error" absent=true timeoutSeconds=30
xcodebug action=history limit=5

# wrap up
xcodebug action=status
xcodebug action=stop keepApp=true
xcodebug action=terminate

# run a command alongside the capture
xcodebug action=await command="cd /repo && npm run test:weather"
```

## Where files land

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
