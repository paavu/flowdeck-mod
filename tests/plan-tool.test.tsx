import { describe, expect, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 26, 12, 40)

function engine(on: any, opts: { store?: Record<string, unknown>; storeFails?: boolean; sessionId?: string } = {}) {
  const store = opts.store ?? {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: opts.sessionId ?? 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: opts.sessionId ?? 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const plan = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__plan', ...input } as any)).result)
const saved = (store: Record<string, unknown>, sid = 's'): any[] => ((store.plans as any)?.[sid] ?? []) as any[]

const STAGES = [
  { name: 'Build', steps: [{ title: 'write tests' }, { title: 'wire tool' }] },
  { name: 'Ship', steps: [{ title: 'commit' }] },
]
const create = ($: any, id = 'work') => plan($, { id, title: 'Plan tool', stages: STAGES })

describe('plan tool', () => {
  test('creating a plan answers with its position, state and active step', async ($, on) => {
    engine(on)
    await start($)
    expect(await create($)).toBe('work: 0/3, running, active "write tests"')
  })

  test('next, done, active, failed, state and note move the plan', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($)
    expect(await plan($, { id: 'work', next: true })).toBe('work: 1/3, running, active "wire tool"')
    expect(await plan($, { id: 'work', active: 'commit' })).toBe('work: 2/3, running, active "commit"')
    expect(await plan($, { id: 'work', failed: 'commit' })).toBe('work: 2/3, error')
    expect(await plan($, { id: 'work', state: 'needs_input', note: 'which branch?' })).toBe('work: 2/3, needs_input')
    expect(saved(store)[0].note).toBe('which branch?')
    expect(await plan($, { id: 'work', done: ['commit'] })).toBe('work: 3/3, done')
  })

  test('an unknown step title is refused and changes nothing', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($)
    const before = JSON.stringify(saved(store))
    expect(await plan($, { id: 'work', done: ['nope'] })).toMatch(/^flowdeck plan: "work" has no step "nope"/)
    expect(JSON.stringify(saved(store))).toBe(before)
    expect(await plan($, { id: 'work', next: true })).toBe('work: 1/3, running, active "wire tool"')
  })

  test('an op before the plan exists is refused', async ($, on) => {
    const { store } = engine(on)
    await start($)
    expect(await plan($, { id: 'ghost', next: true })).toMatch(/^flowdeck plan: no plan "ghost" yet/)
    expect(saved(store)).toEqual([])
  })

  test('a subagent call is ignored', async ($, on) => {
    const { store } = engine(on)
    await start($)
    expect(await plan($, { id: 'work', title: 'x', stages: STAGES, agentId: 'w1' })).toBe('ignored: only the main session plans')
    expect(saved(store)).toEqual([])
  })

  test('resending the stages keeps the done steps', async ($, on) => {
    engine(on)
    await start($)
    await create($)
    await plan($, { id: 'work', next: true })
    const more = [{ name: 'Build', steps: [{ title: 'write tests' }, { title: 'wire tool' }, { title: 'docs' }] }, STAGES[1]]
    expect(await plan($, { id: 'work', stages: more })).toBe('work: 1/4, running, active "wire tool"')
  })

  test('a flat todo list works', async ($, on) => {
    const { store } = engine(on)
    await start($)
    expect(await plan($, { id: 'list', kind: 'todo', stages: [{ name: 'Tasks', steps: [{ title: 'a' }, { title: 'b' }] }] })).toBe('list: 0/2, running, active "a"')
    expect(saved(store)[0].kind).toBe('todo')
  })

  test('four plans keep three', async ($, on) => {
    const { store } = engine(on)
    await start($)
    for (const id of ['p1', 'p2', 'p3', 'p4']) await create($, id)
    expect(saved(store).map(p => p.id)).toEqual(['p2', 'p3', 'p4'])
  })

  test('the main turn closes a fully finished plan, a subagent turn does not', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($, { id: 'work', title: 'x', stages: [{ name: 'S', steps: [{ title: 'a' }] }] })
    await plan($, { id: 'work', done: ['a'], state: 'running' })
    expect(saved(store)[0].state).toBe('running')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'a1' } as any)
    expect(saved(store)[0].state).toBe('running')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(saved(store)[0].state).toBe('done')
    expect(saved(store)[0].endedAt).toBe(NOW)
  })

  test('plans are saved for the session and restored by a new start with the same id', async ($, on) => {
    const { store } = engine(on, { sessionId: 'abc' })
    await start($)
    await create($)
    await plan($, { id: 'work', next: true })
    expect(saved(store, 'abc')).toHaveLength(1)
    await start($)
    expect(await plan($, { id: 'work', next: true })).toBe('work: 2/3, running, active "commit"')
  })

  test('a fresh start restores only its own session from the store', async ($, on) => {
    const mine = { id: 'mine', title: 't', kind: 'plan', stages: [{ name: 'S', steps: [{ title: 'a', status: 'active', substeps: [] }] }], state: 'running', note: null, startedAt: 1 }
    const other = { ...mine, id: 'other' }
    engine(on, { sessionId: 'abc', store: { plans: { abc: [mine], xyz: [other] } } })
    await start($)
    expect(await plan($, { id: 'mine', next: true })).toBe('mine: 1/1, done')
    expect(await plan($, { id: 'other', next: true })).toMatch(/^flowdeck plan: no plan "other" yet/)
  })

  test('the store keeps the 20 most recent sessions', async ($, on) => {
    const plans: Record<string, unknown> = {}
    for (let i = 0; i < 25; i++) plans[`old${i}`] = [{ id: 'p', title: 't', kind: 'plan', stages: [], state: 'done', note: null, startedAt: i }]
    const { store } = engine(on, { store: { plans } })
    await start($)
    await create($)
    const keys = Object.keys(store.plans as object)
    expect(keys).toHaveLength(20)
    expect(keys).toContain('s')
    expect(keys).not.toContain('old5')
    expect(keys).toContain('old24')
  })

  for (const [name, value] of [['a string', 'nope'], ['an object of numbers', { x: 5 }], ['a session of numbers', { s: 5 }]] as const) {
    test(`garbage in the store (${name}) leaves the plans empty`, async ($, on) => {
      engine(on, { store: { plans: value } })
      await start($)
      expect(await plan($, { id: 'work', next: true })).toMatch(/^flowdeck plan: no plan "work" yet/)
      expect(await create($)).toBe('work: 0/3, running, active "write tests"')
    })
  }

  test('a throwing store does not break the tool call or the turn', async ($, on) => {
    engine(on, { storeFails: true })
    await start($)
    expect(await create($)).toBe('work: 0/3, running, active "write tests"')
    expect(await plan($, { id: 'work', next: true })).toBe('work: 1/3, running, active "wire tool"')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  })
})
