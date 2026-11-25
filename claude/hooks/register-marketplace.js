import { render, trackTool, watch } from './register.js';

const SERVER = 'plugin:xcodebug:xcodebug';
const ACTION_TOOL = 'mcp__plugin_xcodebug_xcodebug__xcodebug';

export function register(on) {
  on('session.start', async ($, e, next) => {
    watch($, SERVER);
    return next(e);
  });
  on('tool.call', { tool: ACTION_TOOL }, ($, e, next) => trackTool($, e, next, SERVER));
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => render($, e, next));
}
