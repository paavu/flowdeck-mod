import { describe, expect, test } from 'claude-code/testing'

function engine(on: any) {
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: {}, cost: { usd: 0 } } }))
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
    expect(await progress($, { phase: 'delegate' })).toMatch(/1\/3/)
  })

  test('a task list change before any flow does not create one', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    await start($)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'lonely', status: 'pending' }] } as any)
    expect(await progress($, { title: 'S', total: 1, tasks: [A], phase: 'delegate' })).toMatch(/0\/1/)
  })
})
