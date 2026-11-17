import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'xcodebug-live', component: 'AbovePrompt', surface: 'terminal',
  viewport: { columns: 120, rows: 40 }, props: {},
} as const

test('idle timer replaces the console tail and clears the band after stop', async ($, on) => {
  const clock = mock.clock(on)
  let snapshot = { rows: ['capturing · 1 line', 'first log'] }
  on('session.start', () => ({ cwd: '/work' }))
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('xcodebug')
    expect(e.tool).toBe('xcodebug_ui')
    return { value: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'first log' })).toBeDefined()
  snapshot = { rows: ['capturing · 2 lines', 'second log'] }
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'second log' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'first log' })).toBeUndefined()
  snapshot = { rows: [] }
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /capturing/ })).toBeUndefined()
})

test('a failed UI read removes stale logs and recovers on the next timer', async ($, on) => {
  const clock = mock.clock(on)
  let failed = false
  on('session.start', () => ({ cwd: '/work' }))
  on('mcp.call', () => failed
    ? { value: { isError: true, content: [{ type: 'text', text: 'server unavailable' }] } }
    : { value: { content: [{ type: 'text', text: '{"rows":["current log"]}' }] } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'current log' })).toBeDefined()
  failed = true
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /live display unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'current log' })).toBeUndefined()
  failed = false
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'current log' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /unavailable/ })).toBeUndefined()
})
