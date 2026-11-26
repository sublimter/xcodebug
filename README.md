# xcodebug

## Overview

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

| Client | Recommended installation | In-session entry point |
|---|---|---|
| [pi/omp extension](#piomp-extension) | Native package | `/xcodebug` |
| [Claude Code](#claude-code) | Marketplace plugin | `/xcodebug:xcodebug` |
| [Codex](#codex) | Marketplace plugin | `xcodebug:xcodebug` in the `$` picker |

Install using the section for your client. Claude Code and Codex need
[Bun](https://bun.sh) on the client's `PATH` to run the TypeScript MCP server.
After installing, open a new session in your project and run `doctor`. See the
[practical guide](GUIDE.md) for examples or the [reference](REFERENCE.md) for
configuration, actions, and log retention.

### Migrate an existing manual installation

Marketplace installation leaves the old setup in place. If you are switching
from manual MCP, you must remove or disable the old setup **by hand** after
verifying the new plugin. Save the settings you plan to change and stop any old
captures in the session that started them. Live captures and custom commands,
environment variables, and timeouts do not transfer to the plugin.

Follow [Claude Code migration](#claude-code-migration) or [Codex migration](#codex-migration).
The published npm 1.2.5 package includes manual MCP setup, not a Codex
Marketplace plugin. If you never configured manual MCP, there is nothing to
remove. Keep the npm package if pi/omp or another client still uses it.

### Requirements

| Need | Why |
|---|---|
| macOS + Xcode (command-line tools) | `xcodebuild`, `xcrun devicectl` |
| `idevicesyslog` from libimobiledevice | optional; only `syslog` and the dual-channel safety net |
| git | change detection; without a repo every run rebuilds |
| CocoaPods | optional; only projects with a `Podfile` |
| Bun | only for the MCP clients (Claude Code, Codex); pi runs the extension itself |

`xcodebug action=doctor` reports the Xcode toolchain, the capture tools, the
active config and the log directory.

## pi/omp extension

pi and omp load `index.ts` in-process. They do not need an MCP registration
or the shared skill.

```bash
# from npm (writes to ~/.pi/agent/settings.json)
pi install npm:xcodebug
pi install npm:xcodebug -l      # project scope: .pi/settings.json

# explicitly select the latest release, or install from a checkout
pi install npm:xcodebug@latest
pi install /path/to/xcodebug
```

For omp, use its native plugin manager:

```bash
omp plugin install npm:xcodebug
```

Upgrading from `xcodebug-extension` requires removing the old package first;
both names register the same `xcodebug` tool.

```bash
pi remove npm:xcodebug-extension
pi install npm:xcodebug
```

On omp, the removal command is `omp plugin uninstall npm:xcodebug-extension`.

Alternatively, copy the extension directory to `<agentDir>/extensions/xcodebug/`.
The host resolves `<agentDir>` (`~/.omp/agent`, `~/.pi/agent`, `~/.omo/agent`,
or `~/.senpi/agent`). Use one installation method. Start a new session after
installing or updating, then run `/xcodebug doctor`.

### Pushing logs into the conversation

In native pi/omp, `push` controls whether new lines are mirrored into the session.
The MCP adapter accepts only `off`; Claude Code and Codex use `logs`/`wait`.

- `context` (default) — new lines are queued for the next turn (does not start one).
- `off` — pull with `logs`/`wait` only.
- `wake` — new lines start a turn.

A device console is a firehose; the push carries at most 80 lines per tick and
reports how many older lines it dropped. Combine it with `match` to keep it
useful, e.g. `xcodebug action=launch match=MySDK push=wake`.

Native pi/omp needs only the extension, not this skill or an MCP connection.
Both hosts register `extensions: ["./index.ts"]`; `pi.skills: []` disables pi's
package skill loading. The shared skill lives under `mcp/skills/`, outside the
root `skills/` directory that omp scans independently of manifest fields.
Native `/xcodebug` runs
the registered extension handler directly; it does not ask the model to select
a skill. A normal model tool call uses the registered native `xcodebug` tool.
If pi/omp also discovers the shared user-level skill through `.agents/skills`
or `.claude/skills`, its instructions select that native tool before MCP.
This shared-skill selection is model-driven, not a substitute for the native
command's deterministic dispatch. The extension must be installed, enabled and
loaded in the session; explicitly disabling it is not overridden.

## Claude Code

### Claude Code Marketplace installation

Already using manual MCP? Install the plugin, verify it, then
[remove the old setup](#claude-code-migration).

```bash
claude plugin marketplace add sublimter/xcodebug
claude plugin install xcodebug@sublimter-xcodebug --scope user
```

Open a new Claude session in the project and run `/xcodebug:xcodebug doctor`.
The plugin bundles the skill, MCP server, and live display Mod. Check `/plugin`
for the enabled plugin. In `/mcp`, confirm `plugin:xcodebug:xcodebug` is
connected. For a local checkout, pass its absolute path to `plugin marketplace
add` instead of `sublimter/xcodebug`. Verified on Claude Code 2.1.331.

### Claude Code manual MCP fallback

Use the npm package or a local checkout. Set `XCODEBUG_DIR` to its root:

```bash
npm i -g xcodebug@latest
XCODEBUG_DIR="$(npm root -g)/xcodebug"
# For a checkout, skip npm and use XCODEBUG_DIR=/absolute/path/to/xcodebug.
claude mcp add --scope user xcodebug -- bun "$XCODEBUG_DIR/mcp/server.ts"
```

Check the connection with `claude mcp list`. For `/xcodebug`,
[link the shared skill](REFERENCE.md#install-the-manual-entry-point) and open a new session.
To add a live band to this manual setup, install the
[standalone Mod](#install-once-for-ordinary-claude-sessions).

### Claude Code migration

1. In a new session, run `/xcodebug:xcodebug doctor`. In `/mcp`, confirm
   `plugin:xcodebug:xcodebug` is connected. Claude Code
   [deduplicates endpoints](https://code.claude.com/docs/en/mcp.md#scope-hierarchy-and-precedence).
   If a manual server points to the same command and file as the plugin and
   hides the bundled server, install the plugin from a separate checkout for
   this check. Do not remove the manual entry before the plugin works.
2. Finish any captures in the old session. Use `claude mcp get xcodebug` to
   identify the old server and its scope. Save the individual MCP entry as
   private JSON so you can restore it. Run **only** the commands that apply:

   ```bash
   # The old standalone display is enabled in `claude plugin list`:
   claude plugin disable xcodebug-live@skills-dir

   # The old registration is user-scoped:
   claude mcp remove --scope user xcodebug

   # The old registration is local to this project; run from that project:
   claude mcp remove --scope local xcodebug
   ```

   Check `claude mcp get xcodebug` again: removing a local entry can reveal an
   older user entry. For a shared `.mcp.json`, review the change with the
   project owner before removing its `xcodebug` entry.
3. If no other project or client uses the manual Skill link, move the confirmed
   symlink to an unused path outside the skills directory. For the default
   Claude configuration directory:

   ```bash
   mv -n "$HOME/.claude/skills/xcodebug" "$HOME/.claude/xcodebug-skill.before-marketplace"
   ```

   Use your `CLAUDE_CONFIG_DIR` instead of `$HOME/.claude` if you set it.
4. Reopen Claude Code. Verify `/xcodebug:xcodebug doctor` and confirm `/mcp`
   shows the bundled server and no longer shows the retired manual entry.

**Rollback:** Run `claude plugin disable xcodebug@sublimter-xcodebug --scope user`.
Restore the saved registration with `claude mcp add-json --scope user xcodebug - < /path/to/saved-entry.json`.
Use `--scope local` from its project if that was the original scope. Move back
any saved Skill link and, if you disabled the standalone Mod, run
`claude plugin enable xcodebug-live@skills-dir`. Open a new session.

### Claude Code live display

The [Marketplace plugin](#claude-code-marketplace-installation) includes the
live band. It needs Claude Code 2.1.323 or later in an interactive terminal.
If you use [manual MCP](#claude-code-manual-mcp-fallback), install the standalone
`xcodebug-live` Mod separately. The steps below apply only to that setup.

#### Standalone Mod prerequisites

Use a checkout or package containing both the Mod and MCP adapter:

```bash
XCODEBUG_DIR=/path/to/xcodebug
# For an npm package containing this feature:
# XCODEBUG_DIR="$(npm root -g)/xcodebug"
claude --version
test -f "$XCODEBUG_DIR/claude/.claude-plugin/plugin.json"
test -f "$XCODEBUG_DIR/mcp/server.ts"
```

If either file is missing, use a checkout that contains both. The standalone
Mod uses the manual server named `xcodebug`. Check its path with
`claude mcp get xcodebug` and keep both on the same release.

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

In your project session, run `/xcodebug:xcodebug launch scheme=MyApp` for
Marketplace, or `/xcodebug launch scheme=MyApp` for manual setup.

During build, install, launch, and the rebuild within `restart`, the band shows
the current phase and elapsed time. An operation's phase takes priority over
an existing capture; capture continues in the background. When the operation
finishes, fails, or is cancelled, the band returns to the running capture's
line count and latest four log lines.

The band refreshes once a second between and during turns, then clears when
no operation or capture is running. When the Mod starts, it checks the current
MCP connection once and resumes polling if there is active work. A new Claude
session does not inherit an old server's captures. Read-only and cleanup
actions do not start polling unless they carry a `command`. Build percentages
are estimates; installation shows elapsed time. Use `logs` or `wait` to give
the model log evidence.

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

1. In `/plugin`, check `xcodebug@sublimter-xcodebug` for Marketplace or
   `xcodebug-live@skills-dir` for manual setup. Check the Errors tab if it did
   not load. Safe mode, disabled Mods or hooks, and managed settings can block it.
2. In `/mcp`, check `plugin:xcodebug:xcodebug` for Marketplace or `xcodebug` for
   manual setup. If the manual server lacks `xcodebug_ui`, inspect its path with
   `claude mcp get xcodebug`; the adapter may be out of date.
3. Run `/xcodebug:xcodebug status` for Marketplace or `/xcodebug status` for
   manual setup in that session. The band is empty when there is no active
   capture or operation to show.
4. After updating the plugin, server, or Mod, restart Claude Code. Reloading
   the plugin files does not restart an existing MCP server. `claude -p`
   sessions do not draw the band.

For manual setup, `claude plugin disable xcodebug-live@skills-dir` disables
only the band after reopening Claude Code. Disabling the Marketplace plugin
also disables its bundled skill and MCP server.

## Codex

### Codex Marketplace installation

Already using manual MCP? Install the plugin, verify it, then
[remove the old setup](#codex-migration).

```bash
codex plugin marketplace add sublimter/xcodebug
codex plugin add xcodebug@sublimter-xcodebug --json
```

Open a new project session, select `xcodebug:xcodebug` in the `$` picker, and
ask for `doctor`. Confirm `source:` points to the installed plugin. Its MCP
server is named `xcodebug_marketplace` so an old manual `xcodebug` registration
cannot hide it. The plugin sets a 4200-second tool timeout, and its skill passes
the project directory as `cwd`. Direct project-scoped calls need the absolute
path of an existing directory. `restart` reuses the last launch directory.
If a symlink and `..` make the path ambiguous, pass the resolved directory.

Codex installs a copy of the plugin source in its cache. The installation JSON
contains `installedPath`, the authoritative root of that copy. Keep this path
from the installation you just verified. Do not use MCP `transport.cwd` to
locate scripts: it is a server working directory and may be overridden.
Marketplace does not run npm or put `xcodebug-setup-codex` on `PATH`. The
[live footer](#codex-live-display-experimental) is optional.

For a local checkout, pass its absolute path to `plugin marketplace add`
instead of `sublimter/xcodebug`. Verified on Codex CLI 0.172.0.

### Codex manual MCP fallback

```bash
npm i -g xcodebug@latest
xcodebug-setup-codex
# For a checkout, skip npm and run node bin/xcodebug-setup-codex.mjs from its root.
```

Setup registers `xcodebug` with Bun if absent and adds a 4200-second tool
timeout only if none is set. It preserves custom server commands and warns about
project overrides. On CLI 0.171.0 or later, it enables the statusline feature
and selects `xcodebug / xcodebug_ui` only when the user-level selection is
missing or `default`. It checks the running app-server version but does not
update or restart it. If Codex rejects a stale configuration write, rerun setup
after the other edit has finished.

To configure the same manual server without the script, merge this table into
`${CODEX_HOME:-$HOME/.codex}/config.toml`. Use the actual absolute path to
`mcp/server.ts` in your npm installation or checkout. Keep any existing custom
command, environment variables, and timeout that you still need.

```toml
[mcp_servers.xcodebug]
command = "bun"
args = ["/absolute/path/to/xcodebug/mcp/server.ts"]
tool_timeout_sec = 4200
```

For the optional manual footer, use the [footer settings below](#codex-live-display-experimental)
with `server = "xcodebug"`. Check `codex mcp get xcodebug`. For the `$` picker,
[link the shared skill](REFERENCE.md#install-the-manual-entry-point) before opening a new session.
Increase the MCP timeout if your stage budgets need more time. It does not
change stage deadlines or the separate status-line deadlines.

### Codex migration

1. In a new session, run `doctor` through `xcodebug:xcodebug`. Verify that
   `source:` points to the installed plugin. Finish any old captures in the
   session that started them.
2. If your footer uses `{ server = "xcodebug", tool = "xcodebug_ui" }`, change
   only `server` to `xcodebug_marketplace` in the config that sets it. For the
   base user config, you can make the same change with the verified plugin's script:

   ```bash
   # Use installedPath from the successful `codex plugin add ... --json` result.
   node "/verified/installedPath/bin/xcodebug-setup-codex.mjs" --migrate-marketplace
   ```

   Use Node.js 20 or later. If you did not retain or cannot verify the current
   installation root, use the [TOML alternative](#codex-live-display-experimental)
   instead of executing a script found through MCP `cwd`. Do not reinstall
   merely to discover a path, because installation changes plugin settings.

   The script requires the plugin to be enabled in the user/global configuration.
   A project-only enable does not authorize changing the user-wide footer.
   Preflight runs after the user configuration version is captured, so a plugin
   uninstall or other user edit during migration rejects the write. The script
   does not enable the footer, change a default or custom provider, or remove MCP
   registrations. Project/profile provider settings and explicit overrides of
   `xcodebug_marketplace` must be reviewed separately before migration.
3. Run `codex mcp get xcodebug`. If it is the old manual server, save its
   `[mcp_servers.xcodebug]` entry, including any environment variables and
   timeout. Remove the confirmed **user-level** registration:

   ```bash
   codex mcp remove xcodebug
   ```

   Review any `xcodebug` entry in a project `.codex/config.toml` with its owner.
   Do not replace the whole file or remove entries used by other clients.
4. If no other client uses your manual Skill symlink, move it to an unused
   path outside the skills directory:

   ```bash
   mv -n "$HOME/.agents/skills/xcodebug" "$HOME/.agents/xcodebug-skill.before-marketplace"
   ```

   Reopen Codex. Verify `doctor` and, if enabled, the new footer provider.

**Rollback:** Run `codex plugin remove xcodebug@sublimter-xcodebug`. Restore the
saved MCP entry and the old provider selection in their original files. Move
the saved Skill link back if you moved it, then open a new session.
After the migration works, you may remove an unused global npm package with
`npm uninstall -g xcodebug`. Do not do this if pi/omp or another client uses
that package, or while you still need it for rollback.


### Codex live display (experimental)

Marketplace installation makes the MCP tool available, but does not select a
status-line provider. The optional footer requires Codex CLI and app server
0.171.0 or later. Enable `features.tui_extensions_statusline` in your Codex
configuration, or pass `--enable tui_extensions_statusline` for one session.
`xcodebug-setup-codex` enables the feature only on the manual setup path.

If your running app server is too old, finish active tasks and captures before
running `codex app-server daemon update --from-cli --yes`, then
`codex app-server daemon restart`. Opening a new TUI does not update the server.

Start a new Codex session after setup or after updating the service or MCP
server. To change providers, open `/statusline`, enter **Choose a status line
provider**, then select `xcodebug_marketplace / xcodebug_ui` for Marketplace or
`xcodebug / xcodebug_ui` for a manual installation. A project-level override of
the same MCP server name can make the provider unavailable.

Codex 0.171.0 has a five-second provider discovery deadline. If the global MCP
inventory stalls, the picker can show only the default provider even though
xcodebug itself is available. Specify the provider directly for one session:

```bash
# Marketplace (for manual installs, use server="xcodebug" instead)
codex --enable tui_extensions_statusline -c 'tui.status_line_provider={server="xcodebug_marketplace",tool="xcodebug_ui"}'
```

For a persistent selection, merge these keys into your existing `config.toml`
tables. For manual MCP, use `server = "xcodebug"` instead. The manual setup
script preserves a custom provider; leave it unchanged unless you intend to
replace it. `tui.status_line` controls idle fields, not the provider selection.

```toml
[features]
tui_extensions_statusline = true

[tui]
status_line_provider = { server = "xcodebug_marketplace", tool = "xcodebug_ui" }
```

See Codex's
[provider configuration](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/app/status_line_settings.rs)
and [discovery deadline](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/statusline_provider.rs).

The footer shows xcodebug's operation or one running capture's line count and
latest log line, including between tool calls. The count is per capture, not a
total across channels. A new `launch` or `syslog` that replaces a capture for
the same app starts a new count.

If elapsed time and `quiet Ns` advance while the count and latest line stay
unchanged, the footer is refreshing but that capture has no new lines to show.
This does not distinguish app silence from a stalled bridge. In the **same
Codex session**, use `action=status` to identify the running capture and
`action=logs captureId=<id>` to inspect what it received. A new session does
not inherit the live capture.

When no operation or capture remains, the footer restores the configured
`model-with-reasoning`, `current-dir`, `context-remaining`, and `fast-mode`
content from Codex's current statusline snapshot, in order. Unavailable
context usage or tier information is omitted rather than guessed.
The provider stays selected; xcodebug does not rewrite global settings at each
start or stop. Codex does not delegate to its native default renderer, so other
built-in items and styling are not mirrored. Clients that do not supply a
statusline snapshot receive empty idle content. The footer does not stream
logs into the model; use `action=logs` or `action=wait` for log evidence.
Long status text is shortened in the footer without changing the command or
its output.

