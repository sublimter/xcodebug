// Poll the existing connection, not a second server with different captures.
let rows = [];
let polling = false;

export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(1000, async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await $.mcp.call('xcodebug', 'xcodebug_ui', {});
        if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text ?? 'UI read failed');
        const snapshot = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}');
        rows = snapshot.rows?.length ? snapshot.rows : snapshot.status ? [snapshot.status] : [];
      } catch (error) {
        rows = ['Xcodebug · live display unavailable', String(error.message ?? error).slice(0, 160)];
      } finally {
        polling = false;
      }
      $.ui.invalidate('ui.render');
    });
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (rows.length === 0) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return Box({
      flexDirection: 'column',
      children: rows.map(text => Text({ children: [text] })),
    });
  });
}
