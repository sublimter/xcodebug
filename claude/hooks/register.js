// Poll the existing connection, not a second server with different captures.
const SERVER = 'xcodebug';
// A literal, not built from SERVER: `claude plugin validate` reads the matcher statically.
const ACTION_TOOL = 'mcp__xcodebug__xcodebug';
const UI_TOOL = 'xcodebug_ui';
const POLL_MS = 1000;
// One failed read may be a blip; a server that stays down is not polled forever.
const MAX_FAILURES = 3;
const MAX_ERROR_CHARS = 160;
// The server repaints once a second while it shows anything, so a file whose
// `seq` stands still this many reads running belongs to a server that is gone.
const MAX_STALE_READS = 5;
// Actions that neither build nor start a capture, so they paint nothing new
// unless they carry a `command`, which runs as a phase of its own.
// Listed as exclusions so that an action added later shows by default.
const QUIET_ACTIONS = new Set(['doctor', 'devices', 'changes', 'history', 'status', 'logs', 'wait', 'stop', 'terminate']);

let rows = [];
let polling = false;
let timer;
let calls = 0;
let failures = 0;
let file;
let seq;
let stale = 0;

// A tool call runs the session's tool hooks, so only the first read of an
// activity asks the server; it names the file the server keeps the same
// snapshot in, and the reads after that come from there.
async function readServer($, server) {
  const result = await $.mcp.call(server, UI_TOOL, {});
  if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text ?? 'UI read failed');
  const snapshot = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}');
  // A server from before the file existed names none, and is asked every time.
  file = snapshot.file;
  seq = snapshot.seq;
  stale = 0;
  return snapshot;
}

async function readFile($) {
  if (!file) return undefined;
  try {
    const snapshot = JSON.parse(await $.fs.read(file));
    stale = snapshot.seq === seq ? stale + 1 : 0;
    seq = snapshot.seq;
    if (stale < MAX_STALE_READS) return snapshot;
  } catch {
    // Removed when its server exited; the server is asked instead, below.
  }
  file = undefined;
  return undefined;
}

// The timer lives only while there is something to show: it ends once the
// server empties its snapshot (no build, no capture) or keeps failing.
export function watch($, server) {
  timer ??= $.clock.every(POLL_MS, async () => {
    if (polling) return;
    polling = true;
    try {
      const snapshot = await readFile($) ?? await readServer($, server);
      rows = snapshot.rows?.length ? snapshot.rows : snapshot.status ? [snapshot.status] : [];
      failures = 0;
    } catch (error) {
      rows = ['Xcodebug · live display unavailable', String(error.message ?? error).slice(0, MAX_ERROR_CHARS)];
      failures += 1;
    } finally {
      polling = false;
    }
    // A call still in flight may not have painted its first status yet.
    if (calls === 0 && (rows.length === 0 || failures >= MAX_FAILURES)) {
      timer?.cancel();
      timer = undefined;
      rows = [];
      failures = 0;
      // The next activity may meet a restarted server, with a file of its own.
      file = undefined;
    }
    $.ui.invalidate('ui.render');
  });
}

export async function trackTool($, e, next, server) {
  if (QUIET_ACTIONS.has(e.action) && !e.command) return next(e);
  // An older server may have exited without removing its snapshot file.
  file = undefined;
  watch($, server);
  calls += 1;
  try {
    return await next(e);
  } finally {
    calls -= 1;
  }
}

export async function render($, e, next) {
  if (rows.length === 0) return next(e);
  const { Box, Text } = $.ui.resolve(e);
  return Box({
    flexDirection: 'column',
    children: rows.map(text => Text({ children: [text] })),
  });
}

export function register(on) {
  // A capture outlives the module: a reload or a resumed session finds it here.
  on('session.start', async ($, e, next) => {
    watch($, SERVER);
    return next(e);
  });
  on('tool.call', { tool: ACTION_TOOL }, ($, e, next) => trackTool($, e, next, SERVER));
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => render($, e, next));
}
