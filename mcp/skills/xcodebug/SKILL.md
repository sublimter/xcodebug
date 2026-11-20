---
name: xcodebug
description: "Builds, launches, and captures console logs from physical iOS devices using the registered native xcodebug tool or an explicitly configured xcodebug MCP connection. Use when the user invokes xcodebug, requests its doctor/devices/status/logs/wait/stop/restart actions, or wants to verify an iOS app on a real device using its console."
---

# xcodebug

Select the execution tool by exposed capability, not by client name:

- If the session exposes the registered native extension tool `xcodebug`,
  execute the action through that tool. A native transport exposed as
  `xd://xcodebug` is the same backend: read its live schema, then write the action
  JSON to that URI. Reading a schema or this skill does not execute an action.
- If the user explicitly requests the native extension but it is not exposed,
  report that it must be loaded. Do not substitute MCP or a shell command.
- Otherwise, use only an existing configured xcodebug MCP tool, commonly named
  `mcp__xcodebug__xcodebug` or `xcodebug.xcodebug`. If it is absent, report the
  missing connection; do not start another server.
- Captures and restart settings belong to the selected tool's process. Do not
  switch backends or substitute another operation.

Native command dispatch is enforced by the host's registered command handler,
not by these instructions. A shared skill may still be discovered through a
user-level skills directory; these instructions do not disable that discovery.

## Dispatch the request

Read the request following `/xcodebug` in Claude Code or `$xcodebug` in Codex.
Both explicit invocation and a matching natural-language request can use this skill.

- With no arguments, call `{"action":"launch"}` once to build as needed, install,
  launch and start capturing with the selected tool's defaults. Keep the capture running;
  report a launch error without substituting a status query or another action.
- For `status`, call `{"action":"status"}` to inspect captures without launching.
- For an explicit action, call the selected tool with that action and the supplied
  parameters immediately. Do not replace execution with instructions for the user.
- Accept `action [key=value ...]`, `action=... [key=value ...]`, or a JSON parameter
  object. Actions: `doctor`, `devices`, `changes`, `build`, `install`, `launch`,
  `syslog`, `logs`, `wait`, `status`, `stop`, `terminate`, `restart`, `await`.
- Use the live tool schema for parameter names and types. Preserve quoted strings,
  numeric `since`/`limit`/`timeoutSeconds`, booleans, JSON `args` arrays and
  `environment` objects. Keep a supplied `command` shell line intact.
- Omit unspecified parameters so the selected tool can apply its project configuration.
- Only on MCP, use pull reads: omit `push` or use `push="off"`; `context` and
  `wake` are unsupported. Explain an unsupported explicit value instead of changing it silently.
  Native tools retain their live schema's push modes.
- For an explicit action, make exactly one selected-tool call, report its result,
  and stop, including on error. Do not add diagnostic `status` calls or retry
  with another action unless the user asks. `logs` never authorizes launching
  an app, and `launch` does not imply an immediate `stop`.
- For a natural-language verification goal, use `launch` with known project/device
  parameters, then collect evidence for that goal. The goal describes what to
  verify; do not use the entire sentence as a literal log filter. If the app must
  keep running, use `syslog` with its known process name instead of `launch`.

## Examples

| Request after the skill name | Selected tool arguments |
|---|---|
| *(no arguments)* | `{"action":"launch"}` |
| `status` | `{"action":"status"}` |
| `doctor` | `{"action":"doctor"}` |
| `launch scheme=MyApp device="My iPhone"` | `{"action":"launch","scheme":"MyApp","device":"My iPhone"}` |
| `logs captureId=console-123 since=42 limit=100 grep="Weather Sync"` | `{"action":"logs","captureId":"console-123","since":42,"limit":100,"grep":"Weather Sync"}` |
| `wait match="sync complete" timeoutSeconds=30` | `{"action":"wait","match":"sync complete","timeoutSeconds":30}` |
| `stop captureId=console-123 keepApp=true` | `{"action":"stop","captureId":"console-123","keepApp":true}` |
| `restart` | `{"action":"restart"}` |

## Follow a capture

- `launch` restarts the app and captures stdout/stderr plus os_log. `syslog`
  attaches without restarting. `stop` leaves the app running by default;
  `terminate` explicitly terminates it. `restart` reuses this server's last launch
  and forces a rebuild; a saved `command` runs again.
- Track `captureId` and the returned cursor **per capture**. Pass that cursor as
  `since` on the next incremental read; never reuse another capture's cursor.
  `logs` returns the newest matching lines up to `limit` and advances to the
  latest capture cursor, so omitted or evicted lines will not reappear merely
  by advancing `since`. Report omissions instead of claiming a lossless stream.
- A filtered read (`logs grep=...`, `wait`) also searches the log files for lines
  memory has dropped, and a `note:` line in the reply says what it covered. If
  the note says some lines were not searched, say so instead of "not logged".
- Use bounded `wait` for an expected line. With `regex=true`, `match` and `grep`
  are regular expressions, so one `wait` covers both outcomes of a step:
  `match="sync (done|failed)"`. An empty read or quiet log is not proof
  that a test finished. While waiting for the user to operate the phone, tell them
  the required action and keep the capture running.
- For an automated scenario, pass the user's `command` to `launch`, or use `await`
  with the current capture. The command must not relaunch the app itself, since
  that would break the console bridge. Use the returned exit code and logs as evidence.
- A capture that ended on its own says why in `status`, under `logs`, and in the
  reply of the `wait` or `command` it interrupted: the app exited, or was
  restarted outside the capture. Interrupted actions wait for the existing
  crash-report search and include its system termination cause and report path
  when available; missing evidence is reported explicitly, not guessed. Caller
  cancellation still applies. A reply can also warn that a console reattach
  relaunched the app.
  Report these with the result; the log then does not describe one
  uninterrupted run.
- When a verification goal is answered, stop the capture started for that goal.
  Include its `captureId` so other captures are not stopped. An explicit `stop`
  without an ID intentionally stops all running captures in the selected tool.
- Report the operation's result, relevant log evidence, capture ID/cursor or log
  path when returned, and whether capture remains active. Do not invent device
  activity, successful builds, or test outcomes.
