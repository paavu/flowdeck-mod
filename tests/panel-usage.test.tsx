import { describe, expect, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HOUR = 3_600_000
const RATES = [
  { kind: 'five_hour', percentUsed: 76, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
  { kind: 'seven_day', percentUsed: 33, resetsAt: new Date(NOW + 71 * HOUR).toISOString() },
]

function engine(on: any, opts: { rates?: unknown; store?: Record<string, unknown>; clock?: { now: number } } = {}) {
  const store = opts.store ?? {}
  const clock = opts.clock ?? { now: NOW }
  const rates = { current: opts.rates === undefined ? RATES : opts.rates }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: rates.current, cost: { usd: 0 } } }))
  return { store, clock, rates }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 60) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)

describe('usage section in the panel', () => {
  test('shows the session and the week with the verdict in the terminal panel', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Current session/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /24% left/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /This week/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /average: 100% at/ })).toBeDefined()
    await p.unmount()
  })

  test('the Usage button hides the section and the choice is stored', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await settle()
    let p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /Usage/ })).toBeDefined()
    await p.press({ key: 'usage' })
    await settle()
    expect(store.usageShown).toBe(false)
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /24% left/ })).toBeUndefined()
    await p.unmount()
  })

  test('a stored hidden choice starts hidden', async ($, on) => {
    engine(on, { store: { usageShown: false } })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /24% left/ })).toBeUndefined()
    await p.unmount()
  })

  test('without readings it says there is no usage data yet', async ($, on) => {
    engine(on, { rates: [] })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /no usage data yet/ })).toBeDefined()
    await p.unmount()
  })

  test('a rate limits value that is not a list does not break the panel', async ($, on) => {
    engine(on, { rates: {} })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /no usage data yet/ })).toBeDefined()
    await p.unmount()
  })

  test('readings taken over time give a recent pace', async ($, on) => {
    const { clock, rates } = engine(on, { rates: [{ ...RATES[0], percentUsed: 70 }, RATES[1]] })
    await start($)
    await settle()
    clock.now = NOW + 20 * 60_000
    rates.current = [{ ...RATES[0], percentUsed: 76 }, RATES[1]]
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    const p = await pane($, 'terminal', 90)
    expect(await p.find({ type: 'Text', text: /recent: (100|\d+)% (at|at reset)/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /gathering/ })).toBeUndefined()
    await p.unmount()
  })

  test('the desktop panel draws the usage svg', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'desktop', 80)
    expect((await p.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(2)
    await p.unmount()
  })
})
