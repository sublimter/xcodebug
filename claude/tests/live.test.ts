import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'xcodebug-live', component: 'AbovePrompt', surface: 'terminal',
  viewport: { columns: 120, rows: 40 }, props: {},
} as const

const TOOL = 'mcp__xcodebug__xcodebug'
const LAUNCH = { tool: TOOL, action: 'launch' } as const
const QUIET_ACTIONS = ['doctor', 'devices', 'changes', 'status', 'logs', 'wait', 'stop', 'terminate']
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const reply = (snapshot: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } })
const failure = { value: { isError: true, content: [{ type: 'text', text: 'server unavailable' }] } }

test('an idle session reads the display once, then never again', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('mcp.call', () => {
    reads += 1
    return reply({ rows: [] })
  })
  await $.session.start(START)
  await clock.advance(5000)
  expect(reads).toBe(1)
})

test('a capture already running when the session starts is shown', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('mcp.call', () => reply({ rows: ['capturing · 9 lines', 'earlier log'] }))
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'earlier log' })).toBeDefined()
})

test('an xcodebug call starts the display, and an empty snapshot ends it', async ($, on) => {
  const clock = mock.clock(on)
  let snapshot: { rows: string[] } = { rows: [] }
  let reads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('xcodebug')
    expect(e.tool).toBe('xcodebug_ui')
    reads += 1
    return reply(snapshot)
  })
  await $.session.start(START)
  await clock.advance(1000)
  reads = 0

  snapshot = { rows: ['capturing · 1 line', 'first log'] }
  await $.tool.call(LAUNCH)
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
  expect(reads).toBe(3)
  await clock.advance(5000)
  expect(reads).toBe(3)

  snapshot = { rows: ['capturing · 1 line', 'relaunched'] }
  await $.tool.call(LAUNCH)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'relaunched' })).toBeDefined()
})

test('a call still running keeps the display reading an empty snapshot', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  let finish: (result: unknown) => void = () => {}
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => new Promise(resolve => { finish = resolve }))
  on('mcp.call', () => {
    reads += 1
    return reply({ rows: [] })
  })
  await $.session.start(START)
  await clock.advance(1000)
  reads = 0

  const call = $.tool.call(LAUNCH)
  await clock.advance(4000)
  expect(reads).toBe(4)
  finish({ result: {} })
  await call
  await clock.advance(5000)
  expect(reads).toBe(5)
})

test('actions that paint nothing do not start the display', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => {
    reads += 1
    return reply({ rows: [] })
  })
  await $.session.start(START)
  await clock.advance(1000)
  reads = 0

  for (const action of QUIET_ACTIONS) {
    await $.tool.call({ tool: TOOL, action })
    await clock.advance(2000)
  }
  expect(reads).toBe(0)
})

test('a quiet action that carries a command shows its phase, then stops', async ($, on) => {
  const clock = mock.clock(on)
  let snapshot: { rows: string[] } = { rows: [] }
  let reads = 0
  let finish: (result: unknown) => void = () => {}
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => new Promise(resolve => { finish = resolve }))
  on('mcp.call', () => {
    reads += 1
    return reply(snapshot)
  })
  await $.session.start(START)
  await clock.advance(1000)
  reads = 0

  snapshot = { rows: ['Xcodebug · running', '  command: sleep 3'] }
  const call = $.tool.call({ tool: TOOL, action: 'changes', command: 'sleep 3' })
  const ui = await $.ui.mount(BAND)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /command: sleep 3/ })).toBeDefined()
  snapshot = { rows: [] }
  finish({ result: {} })
  await call
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /command: sleep 3/ })).toBeUndefined()
  expect(reads).toBe(2)
  await clock.advance(5000)
  expect(reads).toBe(2)
})

test('a failed UI read removes stale logs and recovers on the next timer', async ($, on) => {
  const clock = mock.clock(on)
  let failed = false
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => failed ? failure : reply({ rows: ['current log'] }))
  await $.session.start(START)
  await $.tool.call(LAUNCH)
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
  // Failures apart from each other never add up to giving up.
  failed = true
  await clock.advance(2000)
  failed = false
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'current log' })).toBeDefined()
})

test('a server that stays down is given up on, and the band clears', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => {
    reads += 1
    return failure
  })
  await $.session.start(START)
  await $.tool.call(LAUNCH)
  const ui = await $.ui.mount(BAND)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /live display unavailable/ })).toBeDefined()
  await clock.advance(30000)
  expect(reads).toBe(3)
  expect(await ui.find({ type: 'Text', text: /unavailable/ })).toBeUndefined()
})

const FILE = '/agent/ui/42.json'

test('one tool call per activity: later reads come from the snapshot file', async ($, on) => {
  const clock = mock.clock(on)
  let snapshot = { rows: [] as string[], seq: 0 }
  let toolReads = 0
  let fileReads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => {
    toolReads += 1
    return reply({ ...snapshot, file: FILE })
  })
  on('fs.read', ($, e) => {
    expect(e.path).toBe(FILE)
    fileReads += 1
    return { value: JSON.stringify(snapshot) }
  })
  await $.session.start(START)
  await clock.advance(1000)
  toolReads = 0
  fileReads = 0

  const ui = await $.ui.mount(BAND)
  for (const round of ['first', 'second']) {
    snapshot = { rows: [`capturing · ${round}`], seq: snapshot.seq + 1 }
    await $.tool.call(LAUNCH)
    await clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: `capturing · ${round}` })).toBeDefined()
    for (let tick = 0; tick < 10; tick++) {
      snapshot = { rows: [`capturing · ${round} · ${tick}`], seq: snapshot.seq + 1 }
      await clock.advance(1000)
      expect(await ui.find({ type: 'Text', text: `capturing · ${round} · ${tick}` })).toBeDefined()
    }
    snapshot = { rows: [], seq: snapshot.seq + 1 }
    await clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: /capturing/ })).toBeUndefined()
    await clock.advance(5000)
  }
  expect(toolReads).toBe(2)
  expect(fileReads).toBe(22)
})

test('a snapshot file that stops changing sends the next read to the server', async ($, on) => {
  const clock = mock.clock(on)
  let toolReads = 0
  let down = false
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => {
    toolReads += 1
    return down ? failure : reply({ rows: ['capturing · stuck'], seq: 7, file: FILE })
  })
  // The server died without clearing its file: same seq on every read.
  on('fs.read', () => ({ value: JSON.stringify({ rows: ['capturing · stuck'], seq: 7 }) }))
  await $.session.start(START)
  await $.tool.call(LAUNCH)
  const ui = await $.ui.mount(BAND)
  await clock.advance(1000)
  toolReads = 0
  down = true
  await clock.advance(4000)
  expect(toolReads).toBe(0)
  expect(await ui.find({ type: 'Text', text: 'capturing · stuck' })).toBeDefined()
  await clock.advance(30000)
  expect(toolReads).toBe(3)
  expect(await ui.find({ type: 'Text', text: /stuck|unavailable/ })).toBeUndefined()
})

test('a snapshot file that cannot be read sends that read to the server', async ($, on) => {
  const clock = mock.clock(on)
  let toolReads = 0
  let gone = false
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => {
    toolReads += 1
    return reply({ rows: [`from the server · ${toolReads}`], seq: toolReads, file: FILE })
  })
  on('fs.read', () => {
    if (gone) throw new Error('ENOENT')
    return { value: JSON.stringify({ rows: ['from the file'], seq: 100 }) }
  })
  await $.session.start(START)
  await $.tool.call(LAUNCH)
  const ui = await $.ui.mount(BAND)
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: 'from the file' })).toBeDefined()
  gone = true
  toolReads = 0
  await clock.advance(1000)
  expect(toolReads).toBe(1)
  expect(await ui.find({ type: 'Text', text: /from the server/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /unavailable/ })).toBeUndefined()
})

test('a call while the display runs asks the server again, in case it was replaced', async ($, on) => {
  const clock = mock.clock(on)
  const OLD = '/agent/ui/1.json'
  const NEW = '/agent/ui/2.json'
  let server = { rows: ['old capture'], seq: 1, file: OLD }
  let oldSeq = 1
  let oldServerRuns = true
  let newSeq = 1
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => reply(server))
  on('fs.read', ($, e) => ({
    value: JSON.stringify(e.path === OLD
      ? { rows: ['old capture'], seq: oldServerRuns ? ++oldSeq : oldSeq }
      : { rows: ['new build'], seq: ++newSeq }),
  }))
  await $.session.start(START)
  await $.tool.call(LAUNCH)
  const ui = await $.ui.mount(BAND)
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: 'old capture' })).toBeDefined()

  // The old server was killed and left its file; the connection now reaches a new one.
  oldServerRuns = false
  server = { rows: ['new build'], seq: 1, file: NEW }
  await $.tool.call(LAUNCH)
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'new build' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'old capture' })).toBeUndefined()
})
