import { describe, expect, test } from 'claude-code/testing'

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_400, color: 'promptBorder', kind: 'used' },
    { name: 'Messages', tokens: 186_000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', kind: 'buffer' },
    { name: 'Free space', tokens: 760_600, color: 'promptBorder', kind: 'free' },
  ],
  totalTokens: 189_400,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 19,
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
}

function engine(on: any, opts: { breakdown?: unknown; store?: Record<string, unknown>; storeFails?: boolean } = {}) {
  const store = opts.store ?? {}
  const asked: unknown[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
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
  on('session.usage', (_$: any, e: any) => {
    asked.push(e)
    return { value: { startedAt: 0, context: { tokens: 189_400, window: 1_000_000, percent: 19, breakdown: opts.breakdown === undefined ? BREAKDOWN : opts.breakdown }, rateLimits: {}, cost: { usd: 0 } } }
  })
  return { store, asked }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 60) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)

describe('context section in the panel', () => {
  test('shows the context bar at the top of the terminal panel', async ($, on) => {
    const { asked } = engine(on)
    await start($)
    await settle()
    expect(asked).toEqual([{ breakdown: 'summary' }])
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /189k of 1M · compacts at 950k/ })).toBeDefined()
    await p.unmount()
  })

  test('the Context button collapses the section to its head line and bar, and the choice is stored', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await settle()
    let p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /Context/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /messages 186k/ })).toBeDefined()
    await p.press({ key: 'context' })
    await settle()
    expect(store.contextShown).toBe(false)
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /189k of 1M/ })).toBeDefined() // the head line stays
    expect(await p.find({ type: 'Text', text: /messages 186k/ })).toBeUndefined() // the legend is gone
    await p.unmount()
  })

  test('the Context and Usage buttons are the first thing in the panel', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    const root: any = await p.drawn()
    const first = JSON.stringify(root.children?.[0] ?? root)
    expect(first).toContain('Context')
    expect(first).toContain('Usage')
    expect(first).not.toContain('Collapse') // the compact toggle is not in the top row
    await p.unmount()
  })

  test('a stored collapsed choice starts collapsed', async ($, on) => {
    engine(on, { store: { contextShown: false } })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /of 1M/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /messages 186k/ })).toBeUndefined()
    await p.unmount()
  })

  test('with no usable window it says there is no data yet', async ($, on) => {
    engine(on, { breakdown: { ...BREAKDOWN, rawMaxTokens: 0 } })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /no context data yet/ })).toBeDefined()
    await p.unmount()
  })

  test('a narrow panel does not throw', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'terminal', 10)
    expect(await p.find({ type: 'Text', text: /of 1M/ })).toBeDefined() // the terminal clamps to 24 columns
    await p.unmount()
  })

  test('a failing store still works and defaults to shown', async ($, on) => {
    engine(on, { storeFails: true })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /of 1M/ })).toBeDefined()
    await p.press({ key: 'context' })
    await settle()
    await p.unmount()
  })

  test('refreshes after a main turn and a compaction, not after a subagent turn', async ($, on) => {
    const { asked } = engine(on)
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($)
    await settle()
    expect(asked.length).toBe(1)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'a1' } as any)
    expect(asked.length).toBe(1)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(asked.length).toBe(2)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await settle()
    expect(asked.length).toBe(3)
  })

  test('the desktop panel draws the context svg', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'desktop', 80)
    expect(await p.find({ type: 'Svg' })).toBeDefined()
    await p.unmount()
  })
})
