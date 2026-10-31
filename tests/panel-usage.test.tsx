import { describe, expect, test } from 'claude-code/testing'

import { SMALL_SIZE, TITLE_SIZE, TITLE_WEIGHT } from '../hooks/sizes'
import { resets, toWindows } from '../hooks/usage'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HOUR = 3_600_000
const RATES = [
  { kind: 'five_hour', percentUsed: 76, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
  { kind: 'seven_day', percentUsed: 33, resetsAt: new Date(NOW + 71 * HOUR).toISOString() },
]

function engine(on: any, opts: { rates?: unknown; store?: Record<string, unknown>; clock?: { now: number }; storeFails?: boolean } = {}) {
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
  on('store.get', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    return (store[e.key] = e.value), { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: rates.current, cost: { usd: 0 } } }))
  return { store, clock, rates }
}

// The exact reset lines as the panel says them, in this machine's time zone (the panel passes none).
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const EXACT = toWindows(RATES).map(w => resets(w, NOW))
const AT_SESSION = re(EXACT[0]!)
const AT_WEEK = re(EXACT[1]!)

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
    expect((await p.findAll({ type: 'Svg' })).some((n: any) => /% left/.test(String(n.props?.alt ?? '')))).toBe(true)
    await p.unmount()
  })

  test('the reset line shows the time left by default, with a switch per window', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Resets in 2h 0m/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Resets in 2d 23h 0m/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Resets at/ })).toBeUndefined()
    const keys = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))
    expect(keys).toContain('usage-reset-session')
    expect(keys).toContain('usage-reset-week')
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]+$/)
    await p.unmount()
  })

  test('pressing either icon switches both windows to the exact 24-hour time and back, and stores it', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await settle()
    let p = await pane($, 'terminal')
    await p.press({ key: 'usage-reset-week' })
    await settle()
    expect(store.usageRemaining).toBe(false)
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: AT_SESSION })).toBeDefined()
    expect(await p.find({ type: 'Text', text: AT_WEEK })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Resets in/ })).toBeUndefined()
    expect(EXACT.every(t => /\d\d:\d\d/.test(t))).toBe(true)
    expect((await p.findAll({ type: 'Text' })).some((t: any) => /\b(AM|PM)\b/.test(String(t.text)))).toBe(false)
    await p.press({ key: 'usage-reset-session' })
    await settle()
    expect(store.usageRemaining).toBe(true)
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Resets in 2h 0m/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Resets in 2d 23h 0m/ })).toBeDefined()
    await p.unmount()
  })

  test('a stored exact choice starts exact', async ($, on) => {
    engine(on, { store: { usageRemaining: false } })
    await start($)
    await settle()
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: AT_SESSION })).toBeDefined()
    await p.unmount()
  })

  test('the choice is one global value, read whatever the project', async ($, on) => {
    const { store } = engine(on, { store: { usageRemaining: false } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project-a' } as any)
    await settle()
    let p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: AT_SESSION })).toBeDefined()
    await p.unmount()
    store.usageRemaining = true
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project-b' } as any)
    await settle()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Resets in 2h 0m/ })).toBeDefined()
    await p.unmount()
  })

  test('a failing store keeps the default and the switch still works', async ($, on) => {
    engine(on, { storeFails: true })
    await start($)
    await settle()
    let p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Resets in 2h 0m/ })).toBeDefined()
    await p.press({ key: 'usage-reset-session' })
    await settle()
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: AT_SESSION })).toBeDefined()
    await p.unmount()
  })

  test('the time left follows the panel clock', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await settle()
    clock.now = NOW + 10 * 60_000
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Resets in 1h 50m/ })).toBeDefined()
    await p.unmount()
  })

  test('desktop: a header drawing and its switch per window above a drawing without its header', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    const p = await pane($, 'desktop', 80)
    const heads = (await p.findAll({ type: 'Svg' })).filter((n: any) => /Resets/.test(String(n.props?.alt ?? '')))
    expect(heads.length).toBe(2)
    const sources = heads.map((n: any) => String(n.props.source))
    expect(sources[0]).toContain(`font-size="${TITLE_SIZE}" font-weight="${TITLE_WEIGHT}">Current session</text>`)
    expect(sources[1]).toContain(`font-size="${TITLE_SIZE}" font-weight="${TITLE_WEIGHT}">This week</text>`)
    expect(sources[0]).toContain(`font-size="${SMALL_SIZE}">Resets in 2h 0m`)
    expect(sources[1]).toContain(`font-size="${SMALL_SIZE}">Resets in 2d 23h 0m`)
    for (const h of heads) expect(h.props.width).toBeLessThan(80 * 8)
    const buttons = await p.findAll({ type: 'Button' })
    const reset = buttons.filter((b: any) => /^usage-reset-(session|week)$/.test(String(b.props.key)))
    expect(reset.length).toBe(2)
    for (const b of reset) {
      expect(b.props.plain).toBe(true)
      expect(b.props.dimColor).toBe(true)
      expect([...String(b.props.label)].length).toBe(1)
    }
    const drawings = (await p.findAll({ type: 'Svg' })).filter((n: any) => /% left/.test(String(n.props?.alt ?? '')))
    expect(drawings.length).toBe(2)
    for (const d of drawings) {
      expect(String(d.props.source)).not.toContain('Resets')
      expect(String(d.props.source)).not.toContain('Current session')
      expect(String(d.props.source)).not.toContain('NaN')
      expect(d.props.height).toBeLessThan(82)
    }
    const keysBefore = buttons.map((b: any) => String(b.props.key))
    await p.unmount()
    const again = await pane($, 'desktop', 80)
    expect((await again.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))).toEqual(keysBefore)
    await again.unmount()
  })

  test('desktop and terminal draw without NaN at any width', async ($, on) => {
    engine(on)
    await start($)
    await settle()
    for (const cols of [24, 40, 60, 80]) {
      const p = await pane($, 'terminal', cols)
      const texts = await p.findAll({ type: 'Text' })
      expect(texts.some((t: any) => /NaN/.test(String(t.text)))).toBe(false)
      await p.unmount()
    }
    for (const cols of [30, 45, 112]) {
      const p = await pane($, 'desktop', cols)
      const svgs = await p.findAll({ type: 'Svg' })
      expect(svgs.some((n: any) => /NaN/.test(String(n.props?.source)))).toBe(false)
      await p.unmount()
    }
  })
})
