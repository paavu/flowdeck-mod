import { describe, expect, mock, test } from 'claude-code/testing'

import { CACHE_WORD, coldCost, familyOf, isCardOpen, MODELS, nextCost, summaryText, toggledFold, tokText, TTL_MS, ttlText, usd, viewOf, warmCost } from '../hooks/cache'
import type { CacheView } from '../hooks/cache'
import { CACHE_FOLD_PX, CARD_MAX_W, cardLines, cardSvg, WIDE_MIN_W } from '../hooks/cache-view'
import { textWidth } from '../hooks/plan-view'
import { asCacheFacts, asCacheFold, asCacheTick } from '../hooks/shapes'
import { hhmm, idleText, minutesLeft } from '../hooks/time'

// The prompt cache in the band: WARM for an hour after the main thread's last request, then COLD with the next
// message's cost; the card the chevron beside the chip opens and folds; the facts' hooks; held values from older shapes.

const NOW = Date.UTC(2026, 9, 30, 9, 0)
const MIN = 60_000
const SURFACES = ['desktop', 'terminal'] as const
const TOKENS = 770_000

// Nothing answers `$.model.fork` here, so a keep-warm renewal fails quietly; tests/keep-warm.test.tsx answers it.
function engine(on: any, opts: { tokens?: number; model?: string; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, opts.store)
  const ctx = { tokens: opts.tokens ?? TOKENS }
  const logs: string[] = []
  let tickWrites = 0
  const fold = { isDown: false }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => (logs.push(String(e.text)), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: ctx.tokens, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.model', () => ({ value: opts.model ?? 'claude-sonnet-5' }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: e.model, input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.SessionStart', () => ({}))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('state.get', { plugin: 'flowdeck', key: 'cacheFold' }, async (_$: any, e: any, next: any) => (fold.isDown ? { deny: 'fold down' } : next(e)))
  on('state.set', { plugin: 'flowdeck', key: 'cacheTick' }, async (_$: any, e: any, next: any) => {
    tickWrites++
    return next(e)
  })
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
  return { clock, ctx, logs, fold, tickWrites: () => tickWrites }
}

// A value an older flowdeck (or junk) left held: the held state answers it until the new code writes the key.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return r?.value?.version > 0 ? r : { value: { value, version: r?.value?.version ?? 0 } }
  })

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '' } as any)
const request = async ($: any, agentId?: string, model = 'claude-opus-5-5') => {
  for await (const _ of $.turn.step({ ...(agentId ? { agentId } : {}), model, turnId: 't', index: 0, messageCount: 1 } as any));
}
const endTurn = ($: any, agentId?: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, ...(agentId ? { agentId } : {}) } as any)
const mainTurn = async ($: any, model?: string) => {
  await request($, undefined, model)
  await endTurn($)
}
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const band = ($: any, surface: 'desktop' | 'terminal', bodyColumns = 100) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } } as any)

type Look = { texts: string[]; alts: string[]; svgs: string[]; buttons: { key: string; label: string }[]; json: string; widths: number[]; chip: string; isCardOpen: boolean }
const read = async (b: any): Promise<Look> => {
  const svgEls = await b.findAll({ type: 'Svg' })
  const buttons = (await b.findAll({ type: 'Button' })).map((x: any) => ({ key: String(x.props.key), label: String(x.props.label ?? x.text ?? '') }))
  const json = JSON.stringify(await b.drawn())
  const texts = (await b.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const alts = svgEls.map((s: any) => String(s.props.alt ?? ''))
  // The chip's words as `WARM: 42m left`: the desktop drawing's alt, or the terminal's chip texts joined.
  const at = texts.findIndex((t: string) => /^ (WARM|COLD) $/.test(t))
  const term = at < 0 ? '' : `${texts[at]!.trim()}:${texts[at + 1] ?? ''}${texts[at + 2] === ' · ' ? ` · ${texts[at + 3] ?? ''}` : ''}`
  return {
    texts,
    alts,
    svgs: svgEls.map((s: any) => String(s.props.source ?? '')),
    widths: svgEls.map((s: any) => Number(s.props.width)),
    buttons,
    json,
    chip: alts.find((a: string) => /^(WARM|COLD):/.test(a)) ?? term,
    isCardOpen: json.includes('"cache-card"'),
  }
}
const look = async ($: any, surface: 'desktop' | 'terminal', bodyColumns = 100): Promise<Look> => {
  const b = await band($, surface, bodyColumns)
  const l = await read(b)
  await b.unmount()
  return l
}
// The chip's words, the same on both surfaces ('' with no chip).
const chipOf = (l: Look, _surface: 'desktop' | 'terminal'): string => l.chip
const pressFold = async ($: any, surface: 'desktop' | 'terminal') => {
  const b = await band($, surface)
  await b.press({ key: 'cache-fold' })
  await b.unmount()
}

describe('cache maths', () => {
  test('the warm countdown counts whole minutes, says <1m below a minute and flips to cold at exactly 60 minutes', () => {
    const at = (idle: number) => viewOf({ lastAt: NOW, tokens: TOKENS, window: 1e6, model: 'claude-opus-5-5' }, NOW + idle)!
    expect(summaryText(at(0))).toBe('60m left')
    expect(summaryText(at(1))).toBe('59m left')
    expect(summaryText(at(30_000))).toBe('59m left')
    expect(summaryText(at(18 * MIN))).toBe('42m left')
    expect(summaryText(at(59 * MIN))).toBe('1m left')
    expect(summaryText(at(59 * MIN + 1))).toBe('<1m left')
    expect(summaryText(at(TTL_MS - 1))).toBe('<1m left')
    expect(at(TTL_MS - 1).mode).toBe('warm')
    expect(at(TTL_MS).mode).toBe('cold')
    expect(summaryText(at(TTL_MS))).toBe('1h 0m · $6.16')
    expect(ttlText(at(18 * MIN))).toBe('cold in 42m')
    expect(ttlText(at(TTL_MS - 1))).toBe('cold in <1m')
    expect(ttlText(at(12 * 60 * MIN + 45 * MIN))).toBe('cold for 11h 45m')
  })

  test('no hours ever in the warm text', () => {
    for (let idle = 0; idle < TTL_MS; idle += 1000) {
      const v = viewOf({ lastAt: NOW, tokens: TOKENS, window: 1e6, model: 'claude-opus-5-5' }, NOW + idle)!
      expect(v.mode).toBe('warm')
      expect(summaryText(v)).toMatch(/^(<1m|([1-9]|[1-5]\d|60)m) left$/)
      expect(ttlText(v)).toMatch(/^cold in (<1m|\d+m)$/)
    }
    expect(minutesLeft(TTL_MS)).toBe('60m')
    expect(minutesLeft(-5)).toBe('<1m')
  })

  test('idle times read like 18m, 2h 5m and 3d 9h', () => {
    expect(idleText(18 * MIN)).toBe('18m')
    expect(idleText(125 * MIN)).toBe('2h 5m')
    expect(idleText(12 * 60 * MIN + 45 * MIN)).toBe('12h 45m')
    expect(idleText((3 * 24 + 9) * 60 * MIN + 59 * MIN)).toBe('3d 9h')
  })

  test('the next message costs, per model: a cold cache writes again at 2x input, a warm one reads', () => {
    const want: Record<string, [string, string]> = { fable: ['$15.40', '$0.19'], opus: ['$6.16', '$0.15'], sonnet: ['$3.08', '$0.15'], haiku: ['$0.77', '$0.04'] }
    expect(MODELS.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    for (const m of MODELS) {
      expect(usd(coldCost(m, TOKENS))).toBe(want[m.id]![0])
      expect(usd(warmCost(m, TOKENS))).toBe(want[m.id]![1])
      expect(nextCost(m, 'cold', TOKENS)).toBe(coldCost(m, TOKENS))
      expect(nextCost(m, 'warm', TOKENS)).toBe(warmCost(m, TOKENS))
      expect(coldCost(m, 1e6)).toBe(m.input * 2)
      expect(warmCost(m, 1e6)).toBe(m.read)
    }
    // The owner's example: about 597.5k tokens on Opus, cold.
    expect(usd(coldCost(familyOf('claude-opus-5-5')!, 597_500))).toBe('$4.78')
  })

  test('a model is matched by its family; an unknown model has no price', () => {
    expect(familyOf('claude-opus-5-5')?.id).toBe('opus')
    expect(familyOf('claude-fable-5')?.id).toBe('fable')
    expect(familyOf('CLAUDE-SONNET-5')?.id).toBe('sonnet')
    expect(familyOf('claude-haiku-5-5[1m]')?.id).toBe('haiku')
    expect(familyOf('gpt-5')).toBeNull()
    expect(familyOf('')).toBeNull()
    expect(familyOf(null)).toBeNull()
    const v = viewOf({ lastAt: NOW, tokens: TOKENS, window: 0, model: 'mystery-model' }, NOW + 2 * TTL_MS)!
    expect(v.model).toBeNull()
    expect(summaryText(v)).toBe('2h 0m') // cold, and no price to name
  })

  test('tokens read as k and M', () => {
    expect(tokText(770_000)).toBe('770k')
    expect(tokText(999_600)).toBe('1M')
    expect(tokText(1_240_000)).toBe('1.2M')
    expect(tokText(640)).toBe('640')
  })

  test('nothing to show until a request and a context size are known', () => {
    expect(viewOf(null, NOW)).toBeNull()
    expect(viewOf({ lastAt: 0, tokens: TOKENS, window: 0, model: null }, NOW)).toBeNull()
    expect(viewOf({ lastAt: NOW, tokens: 0, window: 0, model: null }, NOW)).toBeNull()
  })

  test('the card: warm starts folded, cold open, and a choice holds only in its mode', () => {
    expect(isCardOpen(null, 'warm')).toBe(false)
    expect(isCardOpen(null, 'cold')).toBe(true)
    expect(isCardOpen({ mode: 'warm', open: true }, 'warm')).toBe(true)
    expect(isCardOpen({ mode: 'warm', open: true }, 'cold')).toBe(true)
    expect(isCardOpen({ mode: 'cold', open: false }, 'cold')).toBe(false)
    expect(isCardOpen({ mode: 'cold', open: false }, 'warm')).toBe(false)
    expect(toggledFold(null, 'warm')).toEqual({ mode: 'warm', open: true })
    expect(toggledFold({ mode: 'warm', open: true }, 'cold')).toEqual({ mode: 'cold', open: false })
  })
})

describe('the cache facts', () => {
  test('a main request stamps the hour; a subagent request and turn never do', async ($, on) => {
    const { clock, ctx } = engine(on)
    await start($)
    for (const s of SURFACES) expect(chipOf(await look($, s), s)).toBe('') // no request yet: no chip
    await mainTurn($)
    await clock.set(NOW + 30 * MIN)
    ctx.tokens = 500_000 // only a main turn measures the window
    await request($, 'w1')
    await endTurn($, 'w1')
    expect((await look($, 'desktop')).chip).toBe('WARM: 30m left')
    expect((await look($, 'terminal')).texts).toContain(' 30m left')
    await pressFold($, 'terminal')
    expect((await look($, 'terminal')).texts.some(t => t.startsWith('idle 30m · 770k tokens cached'))).toBe(true)
    await request($)
    expect((await look($, 'desktop')).chip).toBe('WARM: 60m left')
    await endTurn($)
    expect((await look($, 'terminal')).texts.some(t => t.startsWith('idle 0m · 500k tokens cached'))).toBe(true)
  })

  test('the engine measuring the main window moves the size, once a request is known', async ($, on) => {
    engine(on)
    await start($)
    await $.session.measure({ context: { tokens: 900_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as any)
    expect(chipOf(await look($, 'desktop'), 'desktop')).toBe('')
    await mainTurn($)
    await $.session.measure({ context: { tokens: 900_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as any)
    await pressFold($, 'terminal')
    expect((await look($, 'terminal')).texts.some(t => t.startsWith('idle 0m · 900k tokens cached'))).toBe(true)
  })

  for (const source of ['clear', 'compact'] as const) {
    test(`/${source} drops the cache until the next request`, async ($, on) => {
      engine(on)
      await start($)
      await mainTurn($)
      await pressFold($, 'desktop')
      expect((await look($, 'desktop')).alts.some(a => a.startsWith('Cache warm'))).toBe(true)
      await $.classic.SessionStart({ source } as any)
      for (const s of SURFACES) {
        const l = await look($, s)
        expect(chipOf(l, s)).toBe('')
        expect(l.texts).toContain('band below')
      }
      await mainTurn($)
      const l = await look($, 'desktop')
      expect(l.chip).toBe('WARM: 60m left')
      expect(l.alts.some(a => a.startsWith('Cache warm'))).toBe(false) // the card's choice went with the old cache
    })
  }

  test('a resumed session is seeded from how long it was away and how big it is', async ($, on) => {
    engine(on)
    await start($)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: TOKENS, model: 'claude-opus-5-5' } as any)
    expect((await look($, 'desktop')).chip).toBe('WARM: 42m left')
    expect((await look($, 'terminal')).texts).toContain(' 42m left')
  })

  test('a forked session away for days is cold, priced for its model (asked of the session when the event names none)', async ($, on) => {
    engine(on, { model: 'claude-sonnet-5' })
    await start($)
    await $.classic.SessionStart({ source: 'fork', seconds_since_last_response: (3 * 24 + 9) * 3600, context_tokens: TOKENS } as any)
    expect((await look($, 'desktop')).chip).toBe('COLD: 3d 9h · $3.08')
    const t = await look($, 'terminal')
    expect(t.texts).toContain(' 3d 9h')
    expect(t.texts).toContain('$3.08')
  })

  test('a startup SessionStart changes nothing', async ($, on) => {
    engine(on)
    await start($)
    await mainTurn($)
    await $.classic.SessionStart({ source: 'startup' } as any)
    expect((await look($, 'desktop')).chip).toBe('WARM: 60m left')
  })
})

describe('the chip in the band', () => {
  for (const surface of SURFACES) {
    test(`without a flow the band shows the chip alone, above what is drawn below (${surface})`, async ($, on) => {
      const { clock } = engine(on)
      await start($)
      await mainTurn($)
      await clock.set(NOW + 18 * MIN)
      const l = await look($, surface)
      expect(l.json).not.toMatch(/×\d/)
      expect(l.texts).toContain('band below')
      expect(l.json.indexOf('band below')).toBeGreaterThan(l.json.indexOf('cache-fold'))
      expect(l.isCardOpen).toBe(false)
      expect(l.chip).toBe('WARM: 42m left')
      // no Show/Hide: the one control is the dim fold chevron right after the chip
      expect(l.buttons).toEqual([{ key: 'cache-fold', label: '▸' }])
      expect(l.json).not.toMatch(/"(Show|Hide)"/)
      expect(l.json.indexOf('cache-chip')).toBeLessThan(l.json.indexOf('cache-fold'))
      if (surface === 'desktop') {
        // the chip drawing as in 1.0.0028: the word on a rounded rect of its hue, the summary beside it
        expect(l.alts).toEqual(['WARM: 42m left'])
        expect(l.svgs[0]).toMatch(/<rect x="0" y="3" width="\d+" height="16" rx="4" fill="#cc6363"\/>/)
        expect(l.svgs[0]).toContain('>WARM<')
        expect(l.svgs[0]).toContain('42m left')
      } else {
        expect(l.texts).toContain(' WARM ')
        expect(l.texts).toContain(' 42m left')
        expect(l.json).toContain('#cc6363')
        expect(l.json).toContain('#1c1a16')
      }
    })

    test(`the chevron beside the chip opens and folds the card (${surface})`, async ($, on) => {
      const { clock } = engine(on)
      await start($)
      await mainTurn($)
      await clock.set(NOW + 18 * MIN)
      await pressFold($, surface)
      let l = await look($, surface)
      expect(l.isCardOpen).toBe(true)
      expect(l.buttons).toEqual([{ key: 'cache-fold', label: '▾' }])
      expect(l.chip).toBe('WARM: 42m left') // the chip itself is unchanged
      await pressFold($, surface)
      l = await look($, surface)
      expect(l.isCardOpen).toBe(false)
      expect(l.buttons).toEqual([{ key: 'cache-fold', label: '▸' }])
    })

    test(`with a flow the chip sits between the progress and the buttons (${surface})`, async ($, on) => {
      const { clock } = engine(on)
      await start($)
      await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
      await mainTurn($)
      await clock.set(NOW + 2 * TTL_MS + 45 * MIN)
      const l = await look($, surface)
      const at = (s: string) => l.json.indexOf(s)
      expect(l.json).toMatch(/×\d/)
      expect(l.chip).toBe('COLD: 2h 45m · $6.16')
      expect(l.json).toContain('#6aaabd')
      if (surface === 'desktop') {
        expect(l.alts[0]).toMatch(/: Tasks 0\/1, 0%$/)
        expect(l.alts[1]).toBe('COLD: 2h 45m · $6.16')
        expect(l.svgs[1]).toMatch(/rx="4" fill="#6aaabd"/)
      } else {
        expect(at('Tasks 0/1')).toBeLessThan(at(' COLD '))
        expect(l.texts).toContain(' 2h 45m')
        expect(l.texts).toContain('$6.16')
      }
      expect(at('"cache-fold"')).toBeLessThan(at('"flowdeck-agents"'))
      expect(at('"flowdeck-agents"')).toBeLessThan(at('"flowdeck-dismiss"'))
      expect(l.texts).toContain('band below')
    })
  }

  test('the desktop row still fits: the progress drawing gives the chip and its chevron their room', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    await mainTurn($)
    for (const columns of [60, 100, 200, 400]) {
      const l = await look($, 'desktop', columns)
      const slot = Math.min(1600, columns * 9 - 180)
      expect(l.widths[0]).toBe(Math.max(180, slot - (l.widths[1]! + CACHE_FOLD_PX)))
      expect(l.json).toContain('"overflow":"hidden"') // still shrinks and clips, never pushes a neighbour
    }
  })

  test('the terminal row gives the chip, its chevron and their gaps their columns', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    await mainTurn($)
    const l = await look($, 'terminal', 120)
    const bar = l.texts.find(t => /^[█░]+$/.test(t)) ?? ''
    const titleW = Math.max(8, Math.min(30, 'FlowDeck'.length + 2, Math.floor(120 / 3)))
    // ` WARM `, a space, `60m left`, the gap, `▸`, the row's gap
    expect(bar.length).toBe(Math.max(6, Math.min(40, 120 - titleW - 32 - (' WARM '.length + 1 + '60m left'.length + 1 + 1 + 2))))
  })

  test('the terminal row keeps its bar within the columns', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    await mainTurn($)
    const l = await look($, 'terminal', 80)
    const bar = l.texts.find(t => /^[█░]+$/.test(t)) ?? ''
    expect(bar.length).toBeGreaterThanOrEqual(6)
    expect(bar.length).toBeLessThanOrEqual(40)
  })

  test('the hidden band hides the chip too; the panel Band button brings it back', async ($, on) => {
    engine(on)
    await start($)
    await mainTurn($)
    const p = await $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
    await p.press({ key: 'band' })
    expect(chipOf(await look($, 'terminal'), 'terminal')).toBe('')
    await p.press({ key: 'band' })
    await p.unmount()
    expect((await look($, 'terminal')).texts).toContain(' WARM ')
  })
})

describe('Show and Hide', () => {
  for (const surface of SURFACES) {
    // Seven hours of 5-second ticks: it took about 4.6 s before keep warm, so it gets more than the default 5 s.
    test(`warm starts folded, cold starts open, a choice holds until the mode flips (${surface})`, { timeoutMs: 15_000 }, async ($, on) => {
      const { clock } = engine(on)
      await start($)
      await mainTurn($)
      await clock.set(NOW + 18 * MIN)
      const hasCard = (l: Look) => (surface === 'desktop' ? l.alts.some(a => /^Cache (warm|cold)/.test(a)) : l.texts.includes('prices are estimates'))
      let l = await look($, surface)
      expect(hasCard(l)).toBe(false)
      expect(l.isCardOpen).toBe(false)
      await pressFold($, surface)
      l = await look($, surface)
      expect(hasCard(l)).toBe(true)
      expect(l.isCardOpen).toBe(true)
      if (surface === 'desktop') {
        const alt = l.alts.find(a => a.startsWith('Cache warm'))!
        expect(alt).toBe(
          `Cache warm: idle 18m · 770k tokens cached · cold in 42m. keep warm: renews at ${hhmm(NOW + 50 * MIN)}. renewal ≈ $0.15 · cold ≈ $6.16. next message, cache read: Fable $0.19, Opus $0.15 (you), Sonnet $0.15, Haiku $0.04. prices are estimates.`,
        )
        const card = l.svgs[l.alts.indexOf(alt)]!
        expect(card).toContain('YOU')
        expect(card).toContain('prices are estimates')
        expect(card).toContain('cold in 42m')
        expect(card).toContain('prefers-color-scheme: dark') // the panel's light and dark classes
      } else {
        expect(l.texts).toContain('idle 18m · 770k tokens cached · cold in 42m')
        expect(l.texts).toContain('next message, cache read:')
        expect(l.texts.some(t => t.startsWith('Fable $0.19 · Opus $0.15 YOU · Sonnet $0.15 · Haiku $0.04'))).toBe(true)
        expect(l.texts).toContain('prices are estimates')
      }
      // The choice holds while warm, across requests.
      await clock.set(NOW + 20 * MIN)
      await mainTurn($)
      expect(hasCard(await look($, surface))).toBe(true)
      // Cold: open by default, whatever was chosen while warm.
      await clock.set(NOW + 20 * MIN + TTL_MS)
      await pressFold($, surface) // Hide while cold
      l = await look($, surface)
      expect(hasCard(l)).toBe(false)
      expect(l.isCardOpen).toBe(false)
      await clock.set(NOW + 5 * TTL_MS)
      expect(hasCard(await look($, surface))).toBe(false) // the choice holds while cold
      // A request: warm again, folded by default (the earlier warm choice does not come back).
      await mainTurn($)
      l = await look($, surface)
      expect(hasCard(l)).toBe(false)
      expect(l.isCardOpen).toBe(false)
      // Cold again: open again.
      await clock.set(NOW + 7 * TTL_MS)
      expect(hasCard(await look($, surface))).toBe(true)
    })
  }

  test('a cold card names the re-cache price per model and marks the session model', async ($, on) => {
    const { clock } = engine(on, { store: { keepWarm: { '': false } } }) // keep warm switched off in this project
    await start($)
    await mainTurn($, 'claude-fable-5')
    await clock.set(NOW + 2 * TTL_MS)
    const d = await look($, 'desktop')
    expect(d.chip).toBe('COLD: 2h 0m · $15.40')
    expect(d.alts.find(a => a.startsWith('Cache cold'))).toBe(
      'Cache cold: idle 2h 0m · 770k tokens cached · cold for 1h 0m. keep warm: off. renewal ≈ $0.19 · cold ≈ $15.40. next message, re-cache (1-hour write): Fable $15.40 (you), Opus $6.16, Sonnet $3.08, Haiku $0.77. prices are estimates.',
    )
    const t = await look($, 'terminal')
    expect(t.texts.some(x => x.startsWith('Fable $15.40 YOU · Opus $6.16'))).toBe(true)
  })

  test('an unknown model: the chip has no price, the card marks no model', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await mainTurn($, 'mystery-model')
    await clock.set(NOW + 2 * TTL_MS)
    const d = await look($, 'desktop')
    expect(d.chip).toBe('COLD: 2h 0m')
    expect(d.alts.find(a => a.startsWith('Cache cold'))).not.toContain('(you)')
    const t = await look($, 'terminal')
    expect(t.texts).toContain(' 2h 0m')
    expect(t.texts.some(x => /\$/.test(x) && /^\$/.test(x))).toBe(false)
  })

  test('a narrow desktop card puts two models a row', async ($, on) => {
    engine(on)
    await start($)
    await mainTurn($)
    await pressFold($, 'desktop')
    const wide = await look($, 'desktop', 100)
    const narrow = await look($, 'desktop', 40)
    const h = (l: Look) => Number(/height="(\d+)"/.exec(l.svgs[l.alts.findIndex(a => a.startsWith('Cache'))]!)?.[1])
    expect(h(narrow)).toBeGreaterThan(h(wide))
    expect(narrow.widths[narrow.alts.findIndex(a => a.startsWith('Cache'))]).toBe(180)
  })
})

describe("the card's layout", () => {
  const facts = (tokens: number, model: string) => ({ lastAt: NOW, tokens, window: 1e6, model })
  const at = (tokens: number, model: string, idle: number, keep?: CacheView['keep']): CacheView => {
    const v = viewOf(facts(tokens, model), NOW + idle)!
    return keep ? { ...v, keep } : v
  }
  // The owner's screenshot (cold for 13h 14m, not renewed), a warm card, the longest keep-warm text on Fable's larger
  // context, an unpriced model on a tiny context, and a cold Haiku days later.
  const VIEWS: Record<string, CacheView> = {
    screenshot: at(220_000, 'claude-sonnet-5', (14 * 60 + 14) * MIN),
    warm: at(TOKENS, 'claude-opus-5-5', 18 * MIN),
    longest: at(1_240_000, 'claude-fable-5', 30 * MIN, { kind: 'failed', renewals: 2, retryAt: NOW + 52 * MIN }),
    unpriced: at(640, 'mystery-model', 5 * MIN),
    days: at(TOKENS, 'claude-haiku-5', (3 * 24 + 9) * 60 * MIN),
  }
  const WIDTHS = [760, 640, 520, 400, 300, 180]
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const attrsOf = (s: string) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1]!, m[2]!]))
  // Each text's box, measured as the card measures it (600 and up is bold); the chip's word is centred on its x.
  const textsOf = (svg: string) =>
    [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map(m => {
      const a = attrsOf(m[1]!)
      const s = unesc(m[2]!)
      const size = Number(a['font-size'])
      const w = textWidth(s, size, Number(a['font-weight'] ?? 400) >= 600)
      const x = Number(a.x) - (a['text-anchor'] === 'middle' ? w / 2 : 0)
      const y = Number(a.y)
      return { s, y, left: x, right: x + w, top: y - size * 0.75, bottom: y + size * 0.2 }
    })
  const draw = (v: CacheView, w: number) => cardSvg(v, w, (_w, _h, body) => body)
  const norm = (s: string) => s.replace(/ · /g, ' ').replace(/\s+/g, ' ')

  test('every text, rect and line stays inside the card, and no two texts overlap, at every width', () => {
    for (const [name, v] of Object.entries(VIEWS)) {
      for (const W of WIDTHS) {
        const c = draw(v, W)
        const where = `${name} at ${W}`
        expect([where, c.width]).toEqual([where, W])
        const texts = textsOf(c.source)
        for (const t of texts) {
          expect([where, t.s, t.left >= 0, t.right <= c.width, t.bottom <= c.height]).toEqual([where, t.s, true, true, true])
        }
        for (let i = 0; i < texts.length; i++)
          for (let j = i + 1; j < texts.length; j++) {
            const a = texts[i]!
            const b = texts[j]!
            const isOver = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
            expect([where, a.s, b.s, isOver]).toEqual([where, a.s, b.s, false])
          }
        for (const m of c.source.matchAll(/<rect ([^>]*)\/>/g)) {
          const a = attrsOf(m[1]!)
          expect([where, Number(a.x) >= 0, Number(a.x) + Number(a.width) <= c.width, Number(a.y) + Number(a.height) <= c.height]).toEqual([where, true, true, true])
        }
        for (const m of c.source.matchAll(/<line ([^>]*)\/>/g)) {
          const a = attrsOf(m[1]!)
          expect([where, Number(a.x1) > 0 && Number(a.x1) < c.width, Number(a.y2) <= c.height]).toEqual([where, true, true])
        }
      }
    }
  })

  test('a wide band gets two columns of about three rows, at most 110 px high', () => {
    for (const [name, v] of Object.entries(VIEWS)) {
      const c = draw(v, 2000)
      expect(c.width).toBe(CARD_MAX_W)
      expect([name, c.source.includes('<line class="ln"'), c.height <= 110]).toEqual([name, true, true])
    }
    // The owner's screenshot: three rows, every model's price beside the costs, the footer at the caption's end.
    const c = draw(VIEWS.screenshot!, 760)
    expect(c.height).toBeLessThanOrEqual(90)
    const texts = textsOf(c.source)
    const y = (s: string) => texts.find(t => t.s === s)!.y
    expect(y('keep warm: not renewed')).toBe(y('renewal ≈ $0.04 · cold ≈ $0.88'))
    expect(y('next message, re-cache (1-hour write)')).toBe(y('prices are estimates'))
    const prices = ['$4.40', '$1.76', '$0.88', '$0.22'].map(y)
    expect(new Set(prices).size).toBe(1)
    expect(textsOf(c.source).filter(t => t.s === 'prices are estimates')[0]!.left).toBeGreaterThan(texts.find(t => t.s === 'idle 14h 14m · 220k tokens cached')!.right)
  })

  test(`below ${WIDE_MIN_W} px (or when the columns do not fit) the card stacks, and still says everything`, () => {
    expect(draw(VIEWS.screenshot!, 400).source).not.toContain('<line')
    expect(draw(VIEWS.screenshot!, 180).source).not.toContain('<line')
    for (const [name, v] of Object.entries(VIEWS)) {
      for (const W of WIDTHS) {
        const c = draw(v, W)
        const texts = textsOf(c.source).map(t => t.s)
        const flat = norm(texts.join(' '))
        const lines = cardLines(v)
        const want = [`idle ${idleText(v.idleMs)} · ${tokText(v.tokens)} tokens cached`, ttlText(v), lines.keep, lines.renewal ?? '', lines.label.slice(0, -1), lines.footer]
        for (const f of want) expect([name, W, f, flat.includes(norm(f))]).toEqual([name, W, f, true])
        for (const m of lines.models) expect([name, W, texts.includes(m.name), texts.includes(m.cost)]).toEqual([name, W, true, true])
        expect([name, W, texts.includes('YOU')]).toEqual([name, W, v.model !== null])
        expect([name, W, texts.includes(CACHE_WORD[v.mode])]).toEqual([name, W, true])
      }
    }
  })

  test('the stacked card is still shorter than the eight rows it replaced, and grows only as the band narrows', () => {
    const v = VIEWS.screenshot!
    expect(draw(v, 400).height).toBeLessThanOrEqual(150)
    expect(draw(v, 180).height).toBeGreaterThanOrEqual(draw(v, 400).height)
    expect(draw(v, 400).height).toBeGreaterThan(draw(v, 760).height)
  })

  for (const [columns, isFootUp] of [[140, true], [70, false]] as const) {
    test(`the terminal card: three lines, the footer ${isFootUp ? 'at the end of the third' : 'on its own'} (${columns} columns)`, async ($, on) => {
      const { clock } = engine(on, { store: { keepWarm: { '': false } } }) // keep warm switched off in this project
      await start($)
      await mainTurn($)
      await clock.set(NOW + 2 * TTL_MS)
      const l = await look($, 'terminal', columns)
      expect(l.isCardOpen).toBe(true)
      expect(l.texts).toContain('idle 2h 0m · 770k tokens cached · cold for 1h 0m')
      expect(l.texts).toContain('keep warm: off · renewal ≈ $0.15 · cold ≈ $6.16')
      const models = 'Fable $15.40 · Opus $6.16 YOU · Sonnet $3.08 · Haiku $0.77'
      const third = `next message, re-cache (1-hour write): ${models}`
      expect(l.texts).toContain(isFootUp ? `${third} · prices are estimates` : third)
      expect(l.texts).toContain(models)
      expect(l.texts).toContain('prices are estimates')
      const card = l.json.slice(l.json.indexOf('"cache-card"'))
      expect(card.split('"wrap":"truncate-end"').length - 1).toBe(isFootUp ? 3 : 4)
    })
  }
})

describe('the minute tick', () => {
  test('a mounted band counts down and flips to COLD; the tick writes only when the texts change', async ($, on) => {
    const { clock, tickWrites } = engine(on)
    await start($)
    await clock.set(NOW + 2500) // the request falls between two ticks, as it does in a session
    await mainTurn($)
    const b = await band($, 'terminal')
    expect((await read(b)).texts).toContain(' 60m left')
    await clock.advance(5000)
    expect((await read(b)).texts).toContain(' 59m left')
    const before = tickWrites()
    await clock.advance(55_000) // eleven ticks within one minute: nothing new to show
    expect(tickWrites()).toBe(before)
    await clock.advance(5000) // past the minute: one write
    expect(tickWrites()).toBe(before + 1)
    expect((await read(b)).texts).toContain(' 58m left')
    await clock.set(NOW + 2500 + TTL_MS - 30_000)
    expect((await read(b)).texts).toContain(' <1m left')
    await clock.set(NOW + 2500 + TTL_MS + 2500) // the first tick at or after the hour
    const cold = await read(b)
    expect(cold.texts).toContain(' COLD ')
    expect(cold.texts).toContain(' 1h 0m')
    expect(cold.texts).toContain('prices are estimates') // cold opens the card
    await b.unmount()
  })
})

describe('held values', () => {
  test('the normalizers read old and junk shapes', () => {
    expect(asCacheFacts(null)).toBeNull()
    expect(asCacheFacts({ tokens: 5 })).toBeNull()
    expect(asCacheFacts({ lastAt: 'x', tokens: 5 })).toBeNull()
    expect(asCacheFacts({ lastAt: NOW, tokens: '5', window: null, model: 7 })).toEqual({ lastAt: NOW, tokens: 0, window: 0, model: null })
    expect(asCacheFacts({ lastAt: NOW, tokens: TOKENS, extra: 1 })).toEqual({ lastAt: NOW, tokens: TOKENS, window: 0, model: null })
    expect(asCacheFold({ mode: 'hot', open: true })).toBeNull()
    expect(asCacheFold({ mode: 'cold', open: 'yes' })).toBeNull()
    expect(asCacheFold({ mode: 'warm', open: false, at: 3 })).toEqual({ mode: 'warm', open: false })
    expect(asCacheTick(42)).toBe('')
  })

  test('junk held facts draw no chip and leave the band as it was', async ($, on) => {
    engine(on)
    held(on, 'cache', { lastAt: 'yesterday', tokens: 'many' })
    held(on, 'cacheFold', 'open')
    held(on, 'cacheTick', 7)
    await start($)
    await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    for (const s of SURFACES) {
      const l = await look($, s)
      expect(l.json).toMatch(/×\d/)
      expect(chipOf(l, s)).toBe('')
    }
  })

  test('facts held without a window or a model draw the chip with no price; a fold of junk reads as the default', async ($, on) => {
    engine(on)
    held(on, 'cache', { lastAt: NOW - 5 * MIN, tokens: TOKENS })
    held(on, 'cacheFold', { mode: 'warm', open: 'yes' })
    held(on, 'panel', { isCompact: true }) // a panel from before the tabs
    await start($)
    const d = await look($, 'desktop')
    expect(d.chip).toBe('WARM: 55m left')
    expect(d.isCardOpen).toBe(false)
    const t = await look($, 'terminal')
    expect(t.texts).toContain(' 55m left')
  })
})

describe('a cache part that fails', () => {
  test('is said once and left out; the flow row still draws', async ($, on) => {
    const { logs, fold } = engine(on)
    await start($)
    await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    await mainTurn($)
    fold.isDown = true
    for (const s of SURFACES) {
      for (let i = 0; i < 2; i++) {
        const l = await look($, s)
        expect(l.json).toMatch(/×\d/)
        expect(chipOf(l, s)).toBe('')
        expect(l.texts).toContain('band below')
      }
    }
    const lines = logs.filter(x => /could not be drawn: cache: .*fold down/.test(x))
    expect(lines.length).toBe(1)
  })
})
