import { describe, expect, test } from 'claude-code/testing'

function engine(on: any, opts: { refuseCommand?: boolean } = {}) {
  const state = { ticked: false }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => {
    state.ticked = true
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 1 }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => {
    if (opts.refuseCommand) throw new Error('name already taken')
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: {}, cost: { usd: 0 } } }))
  return state
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const A = { title: 'a', tier: 'light' }
const B = { title: 'b', tier: 'medium' }

describe('linked session flow', () => {
  test('add appends a task, raises the total and keeps what is done', async ($, on) => {
    engine(on)
    await start($)
    expect(await progress($, { title: 'S', total: 2, tasks: [A, B], done: 1, phase: 'delegate' })).toMatch(/1\/2/)
    expect(await progress($, { add: [{ title: 'c', tier: 'light' }] })).toMatch(/1\/3/)
  })

  test('adding a title that is already in the flow is ignored', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 1, phase: 'delegate' })
    await progress($, { add: [{ title: 'c', tier: 'light' }] })
    expect(await progress($, { add: [{ title: ' C ', tier: 'light' }] })).toMatch(/1\/3/)
  })

  test('a re-plan with another title keeps the linked flow and its accepted tasks', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 1, phase: 'delegate' })
    expect(await progress($, { title: 'Other', total: 4, tasks: [A, B, { title: 'c', tier: 'light' }, { title: 'd', tier: 'light' }] })).toMatch(/1\/4/)
  })

  test('add before any plan starts a flow with that task', async ($, on) => {
    engine(on)
    await start($)
    expect(await progress($, { add: [{ title: 'x', tier: 'light' }], phase: 'delegate' })).toMatch(/0\/1/)
  })

  test('after the flow is finished a new plan starts fresh', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 2, phase: 'delegate' })
    await progress($, { finished: true })
    expect(await progress($, { title: 'New', total: 3, tasks: [A, B, { title: 'c', tier: 'light' }], phase: 'delegate' })).toMatch(/0\/3/)
  })

  test('a task added to the session task list is mirrored into a linked flow', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 1, phase: 'delegate' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'new todo', status: 'pending' }] } as any)
    expect(await progress($, { phase: 'delegate' })).toMatch(/1\/3/)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'new todo', status: 'completed' }] } as any)
    expect(await progress($, { phase: 'delegate' })).toMatch(/2\/3/) // the list completed it: counted once
  })

  test('a task list change before any flow does not create one', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'lonely', status: 'pending' }] } as any)
    expect(await progress($, { title: 'S', total: 1, tasks: [A], phase: 'delegate' })).toMatch(/0\/1/)
  })

  test('a plugin-namespaced worker (flowdeck:flowdeck-light) moves the flow to delegate', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await $.tool.call({ tool: 'Agent', subagent_type: 'flowdeck:flowdeck-light', description: 'x', prompt: 'p' } as any)
    expect(await progress($, {})).not.toMatch(/Plan/)
  })

  test('a non-flowdeck agent does not create a flow', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'x', prompt: 'p' } as any)
    expect(await progress($, {})).toMatch(/Plan/)
  })

  test('a worker\'s own task list is not mirrored into the flow', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 1, phase: 'delegate' })
    await $.tool.call({ tool: 'TodoWrite', agentId: 'w1', todos: [{ content: 'step 1' }, { content: 'step 2' }] } as any)
    expect(await progress($, { phase: 'delegate' })).toMatch(/1\/2/)
  })

  test('a mirrored task counts as done when the session task list completes it', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 1, phase: 'delegate' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'new todo', status: 'pending' }] } as any)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'new todo', status: 'completed' }] } as any)
    expect(await progress($, { phase: 'delegate' })).toMatch(/2\/3/)
  })

  test('a re-plan that lists only the remaining tasks keeps the earlier ones and done', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'S', total: 3, tasks: [A, B, { title: 'c', tier: 'light' }], done: 3, phase: 'delegate' })
    expect(await progress($, { title: 'B job', total: 2, tasks: [{ title: 'x', tier: 'light' }, { title: 'y', tier: 'light' }] })).toMatch(/3\/5/)
  })

  test('a re-plan keeps tasks mirrored from the session task list', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await progress($, { title: 'S', total: 2, tasks: [A, B], done: 0, phase: 'delegate' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'from list', status: 'pending' }] } as any)
    expect(await progress($, { total: 2, tasks: [A, B] })).toMatch(/0\/3/)
  })

  test('a malformed task list does not break the tool call', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await progress($, { title: 'S', total: 1, tasks: [A], phase: 'delegate' })
    const r = await $.tool.call({ tool: 'TodoWrite', todos: 'nope' } as any)
    expect(r.result).toBe('ok')
    const r2 = await $.tool.call({ tool: 'TodoWrite', todos: [null, { content: 7 }] } as any)
    expect(r2.result).toBe('ok')
  })

  test('a refused /flowdeck-agents registration does not stop the session start', async ($, on) => {
    const state = engine(on, { refuseCommand: true })
    await start($)
    expect(state.ticked).toBe(true) // the clock ticker is set up after the registration
  })
})
