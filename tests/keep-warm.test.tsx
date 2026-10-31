import { describe, expect, mock, test } from 'claude-code/testing'

import { isRenewDue, KEEP_WARM_DEFAULT, KEEP_WARM_MAX_RENEWALS, KEEP_WARM_MIN_TOKENS, keepStatus, keepText, RENEW_AT_MS, TTL_MS, viewOf } from '../hooks/cache'
import { CACHE_FOLD_PX } from '../hooks/cache-view'
import { FOLD_OPEN, FOLD_SHUT, foldGlyph } from '../hooks/fold'
import { asKeepWarm, asPanel, PANEL_DEFAULT } from '../hooks/shapes'
import { hhmm } from '../hooks/time'
import { fakeFs } from './fake-fs'

// Keep warm: with the switch on (the default), an idle session's prompt cache of at least 80k tokens is renewed at
// minute 50 by one side request over the main thread's transcript ($.model.fork), at most twice between two of the
// user's messages; never while cold, while a main turn runs, or once the session ended. Failures back off and show.

const NOW = Date.UTC(2026, 9, 30, 9, 0)
const MIN = 60_000
const TOKENS = 770_000
const SURFACES = ['desktop', 'terminal'] as const
// Tests that run hours of 5-second ticks get more than the default 5 s.
const LONG = { timeoutMs: 15_000 }

type Answer = 'ok' | 'empty' | 'error' | 'nothing' | 'throw'

function engine(on: any, opts: { tokens?: number; store?: Record<string, unknown>; answer?: Answer } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = { ...opts.store }
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  const ctx = { tokens: opts.tokens ?? TOKENS }
  const fork = { answer: (opts.answer ?? 'ok') as Answer, prompts: [] as string[], during: null as null | (($$: any) => Promise<void>) }
  const logs: string[] = []
  const usage = { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: TOKENS, cache_creation_input_tokens: 0 }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => (logs.push(String(e.text)), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: ctx.tokens, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: e.model, input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('classic.SessionStart', () => ({}))
  on('model.fork', async ($$: any, e: any) => {
    fork.prompts.push(String(e.prompt))
    if (fork.during) await fork.during($$)
    switch (fork.answer) {
      case 'ok':
        return { value: { isAnswered: true, text: 'ok', usage } }
      case 'empty':
        return { value: { isAnswered: false, reason: 'empty-reply', usage } }
      case 'error':
        return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { ...usage, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0 } } }
      case 'nothing':
        return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
      default:
        throw new Error('fork down')
    }
  })
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
  return { clock, ctx, fork, logs, store, forks: () => fork.prompts.length }
}

// A value an older flowdeck (or junk) left held: the held state answers it until the new code writes the key.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return r?.value?.version > 0 ? r : { value: { value, version: r?.value?.version ?? 0 } }
  })

const start = ($: any, cwd = '') => $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
const request = async ($: any, agentId?: string) => {
  for await (const _ of $.turn.step({ ...(agentId ? { agentId } : {}), model: 'claude-opus-5-5', turnId: 't', index: 0, messageCount: 1 } as any));
}
const endTurn = ($: any, durationMs = 1000) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs } as any)
const mainTurn = async ($: any) => {
  await request($)
  await endTurn($)
}
const say = ($: any, kind = 'composer') => $.prompt.submit({ text: 'go on', wait: false, origin: { kind } } as any)
const band = ($: any, surface: 'desktop' | 'terminal', bodyColumns = 100) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } } as any)
const pane = ($: any, surface: 'desktop' | 'terminal') => $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)

type Look = { texts: string[]; alts: string[]; widths: number[]; json: string; chip: string }
const look = async ($: any, surface: 'desktop' | 'terminal', bodyColumns = 100): Promise<Look> => {
  const b = await band($, surface, bodyColumns)
  const svgEls = await b.findAll({ type: 'Svg' })
  const texts = (await b.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const alts = svgEls.map((s: any) => String(s.props.alt ?? ''))
  const json = JSON.stringify(await b.drawn())
  await b.unmount()
  const at = texts.findIndex((t: string) => /^ (WARM|COLD) $/.test(t))
  const term = at < 0 ? '' : `${texts[at]!.trim()}:${texts[at + 1] ?? ''}${texts[at + 2] === ' · ' ? ` · ${texts[at + 3] ?? ''}` : ''}`
  return { texts, alts, widths: svgEls.map((s: any) => Number(s.props.width)), json, chip: alts.find((a: string) => /^(WARM|COLD):/.test(a)) ?? term }
}
const openCard = async ($: any) => {
  const b = await band($, 'terminal')
  if (!JSON.stringify(await b.drawn()).includes('"cache-card"')) await b.press({ key: 'cache-fold' })
  await b.unmount()
}
// The card's keep-warm state and costs, the same on both surfaces (the desktop's alt; the terminal's one line for both).
const cardOf = async ($: any): Promise<{ keep: string; renewal: string | undefined; facts: string; alt: string }> => {
  await openCard($)
  const t = await look($, 'terminal')
  const d = await look($, 'desktop')
  const alt = d.alts.find(a => a.startsWith('Cache ')) ?? ''
  const line = t.texts.find(x => /^(keep warm: |kept warm ×)/.test(x)) ?? ''
  const renewal = t.texts.find(x => x.startsWith('renewal ≈'))
  const keep = line.split(' · renewal ≈ ')[0]!
  expect(line).toBe(renewal ? `${keep} · ${renewal}` : keep)
  expect(alt).toContain(`. ${keep}.`)
  return { keep, renewal, facts: t.texts.find(x => x.startsWith('idle ')) ?? '', alt }
}
const pressKeepWarm = async ($: any, surface: 'desktop' | 'terminal' = 'terminal') => {
  const p = await pane($, surface)
  await p.press({ key: 'keep-warm' })
  await p.unmount()
}
const keepWarmLabel = async ($: any, surface: 'desktop' | 'terminal') => {
  const p = await pane($, surface)
  const b = await p.find({ type: 'Button', key: 'keep-warm' })
  await p.unmount()
  return String(b?.props?.label ?? '')
}

describe('when keep warm renews', () => {
  test('at minute 50 of an idle hour, not before; the band then counts the hour from the renewal and the card keeps the real idle time', LONG, async ($, on) => {
    const { clock, forks, fork } = engine(on)
    await start($)
    await mainTurn($)
    await clock.set(NOW + RENEW_AT_MS - 5000)
    expect(forks()).toBe(0)
    expect((await cardOf($)).keep).toBe(`keep warm: renews at ${hhmm(NOW + 50 * MIN)}`)
    await clock.set(NOW + RENEW_AT_MS)
    expect(forks()).toBe(1)
    expect(fork.prompts[0]).toMatch(/renews the prompt cache/)
    expect(fork.prompts[0]).toMatch(/\bok\b/)
    await clock.advance(55_000) // the rest of that minute: never twice
    expect(forks()).toBe(1)
    expect((await look($, 'desktop')).chip).toBe('WARM: 59m left')
    const card = await cardOf($)
    expect(card.keep).toBe(`kept warm ×1 · renews at ${hhmm(NOW + 100 * MIN)}`)
    expect(card.facts).toBe('idle 50m · 770k tokens cached · cold in 59m')
  })

  test('a reply without text read the cache too and counts as a renewal', LONG, async ($, on) => {
    const { clock, forks } = engine(on, { answer: 'empty' })
    await start($)
    await mainTurn($)
    await clock.set(NOW + RENEW_AT_MS)
    expect(forks()).toBe(1)
    expect((await cardOf($)).keep).toBe(`kept warm ×1 · renews at ${hhmm(NOW + 100 * MIN)}`)
  })

  test('at most twice between two user messages: then the limit, and the cache goes cold an hour after the second', LONG, async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await mainTurn($)
    await clock.set(NOW + 100 * MIN)
    expect(forks()).toBe(KEEP_WARM_MAX_RENEWALS)
    expect((await cardOf($)).keep).toBe('kept warm ×2 · limit reached')
    await clock.set(NOW + 159 * MIN)
    expect(forks()).toBe(2)
    expect((await look($, 'desktop')).chip).toBe('WARM: 1m left')
    await clock.set(NOW + 160 * MIN)
    const cold = await look($, 'desktop')
    expect(cold.chip).toBe('COLD: 2h 40m · $6.16') // the idle time since the last request, not since the renewal
    expect((await cardOf($)).keep).toBe('kept warm ×2 · limit reached')
    expect(forks()).toBe(2)
  })

  test("only the user's own message starts the count again; a task notification's turn does not", LONG, async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await mainTurn($)
    await clock.set(NOW + 100 * MIN)
    expect(forks()).toBe(2)
    // A background task's notification wakes the main thread: the cache is read again, the count stays.
    await clock.set(NOW + 110 * MIN)
    await say($, 'task-notification')
    await mainTurn($)
    await clock.set(NOW + 165 * MIN)
    expect(forks()).toBe(2)
    expect((await cardOf($)).keep).toBe('kept warm ×2 · limit reached')
    // The user writes: a new idle period, renewed again at its minute 50.
    await clock.set(NOW + 166 * MIN)
    await say($)
    await mainTurn($)
    expect((await cardOf($)).keep).toBe(`keep warm: renews at ${hhmm(NOW + 216 * MIN)}`)
    await clock.set(NOW + 216 * MIN)
    expect(forks()).toBe(3)
  })

  for (const kind of ['bridge', 'sdk'] as const) {
    test(`a ${kind} prompt is the user's message too`, LONG, async ($, on) => {
      const { clock, forks } = engine(on)
      await start($)
      await mainTurn($)
      await clock.set(NOW + 100 * MIN)
      await say($, kind)
      await mainTurn($)
      await clock.set(NOW + 150 * MIN)
      expect(forks()).toBe(3)
    })
  }
})

describe('when keep warm leaves the cache alone', () => {
  test(`below ${KEEP_WARM_MIN_TOKENS / 1000}k tokens`, async ($, on) => {
    const { clock, forks } = engine(on, { tokens: KEEP_WARM_MIN_TOKENS - 1000 })
    await start($)
    await mainTurn($)
    await clock.set(NOW + 59 * MIN)
    expect(forks()).toBe(0)
    expect((await cardOf($)).keep).toBe('keep warm: below 80k tokens')
  })

  test('a cold cache: a session away past the hour (asleep, or resumed) is never renewed', async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 70 * 60, context_tokens: TOKENS, model: 'claude-opus-5-5' } as any)
    await clock.set(NOW + 30 * MIN)
    expect(forks()).toBe(0)
    expect((await look($, 'desktop')).chip).toMatch(/^COLD: /)
    expect((await cardOf($)).keep).toBe('keep warm: not renewed')
  })

  test('woken in the last minute of the hour: too late to renew safely', async ($, on) => {
    const { forks, clock } = engine(on)
    held(on, 'cache', { lastAt: NOW - 59 * MIN - 30_000, tokens: TOKENS, window: 1e6, model: 'claude-opus-5-5' })
    await start($)
    await clock.advance(25_000)
    expect(forks()).toBe(0)
    expect((await cardOf($)).keep).toBe('keep warm: not renewed')
  })

  test('while a main turn runs (a long tool, say), and again once it ended', async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await mainTurn($)
    await $.turn.start({ text: 'build it', turnId: 't2' } as any)
    await clock.set(NOW + 55 * MIN)
    expect(forks()).toBe(0)
    await endTurn($, 55 * MIN) // the turn's end stamps no request: the cache was last read at NOW
    await clock.advance(5000)
    expect(forks()).toBe(1)
  })

  test('with the switch off; switched on again it renews', async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await mainTurn($)
    await pressKeepWarm($)
    await clock.set(NOW + 55 * MIN)
    expect(forks()).toBe(0)
    expect((await cardOf($)).keep).toBe('keep warm: off')
    await pressKeepWarm($)
    await clock.advance(5000)
    expect(forks()).toBe(1)
  })

  test('once the session ended', async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await mainTurn($)
    await $.session.end({ reason: 'other', sessionId: 's', resume: {} } as any)
    await clock.set(NOW + 55 * MIN)
    expect(forks()).toBe(0)
  })

  test('/clear starts a new cache: nothing renewed until the next request', LONG, async ($, on) => {
    const { clock, forks } = engine(on)
    await start($)
    await mainTurn($)
    await clock.set(NOW + 100 * MIN)
    expect(forks()).toBe(2)
    await $.classic.SessionStart({ source: 'clear' } as any)
    await clock.set(NOW + 155 * MIN)
    expect(forks()).toBe(2)
    await mainTurn($)
    expect((await cardOf($)).keep).toBe(`keep warm: renews at ${hhmm(NOW + 205 * MIN)}`)
  })
})

describe('a renewal that fails', () => {
  for (const answer of ['error', 'nothing', 'throw'] as const) {
    test(`(${answer}) is counted, backs off two minutes, stops after the second, and never reaches the band as an error`, async ($, on) => {
      const { clock, forks, logs } = engine(on, { answer })
      await start($)
      await mainTurn($)
      await clock.set(NOW + RENEW_AT_MS)
      expect(forks()).toBe(1)
      expect((await cardOf($)).keep).toBe(`keep warm: failed · retry at ${hhmm(NOW + 52 * MIN)}`)
      await clock.set(NOW + 52 * MIN - 5000)
      expect(forks()).toBe(1)
      await clock.set(NOW + 52 * MIN)
      expect(forks()).toBe(2)
      expect((await cardOf($)).keep).toBe('keep warm: failed')
      await clock.set(NOW + 59 * MIN)
      expect(forks()).toBe(2)
      for (const s of SURFACES) {
        const l = await look($, s)
        expect(l.chip).toMatch(/^WARM: 1m left$/)
        expect(l.json).not.toMatch(/could not be drawn|band error/)
      }
      expect(logs.filter(x => /could not be drawn/.test(x))).toEqual([])
      // The user's next message starts over.
      await say($)
      await mainTurn($)
      expect((await cardOf($)).keep).toBe(`keep warm: renews at ${hhmm(NOW + 109 * MIN)}`)
    })
  }

  test('a failure then a success: the renewal counts, and the failure still counts toward the two of the idle period', LONG, async ($, on) => {
    const { clock, forks, fork } = engine(on, { answer: 'error' })
    await start($)
    await mainTurn($)
    await clock.set(NOW + RENEW_AT_MS)
    fork.answer = 'ok'
    await clock.set(NOW + 52 * MIN)
    expect(forks()).toBe(2)
    expect((await cardOf($)).keep).toBe(`kept warm ×1 · renews at ${hhmm(NOW + 102 * MIN)}`)
    fork.answer = 'error'
    await clock.set(NOW + 102 * MIN)
    expect(forks()).toBe(3)
    expect((await cardOf($)).keep).toBe('kept warm ×1 · failed')
    await clock.set(NOW + 110 * MIN)
    expect(forks()).toBe(3)
  })
})

describe("the renewal's own request", () => {
  test('a main request the engine raised for the fork is not taken for the user: the idle time and the count hold', async ($, on) => {
    const { clock, forks, fork } = engine(on)
    fork.during = async () => {
      for await (const _ of $.turn.step({ model: 'claude-opus-5-5', turnId: 'f', index: 0, messageCount: 9 } as any));
      await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 900 } as any)
    }
    await start($)
    await mainTurn($)
    await clock.set(NOW + RENEW_AT_MS)
    expect(forks()).toBe(1)
    const card = await cardOf($)
    expect(card.facts).toBe('idle 50m · 770k tokens cached · cold in 60m')
    expect(card.keep).toBe(`kept warm ×1 · renews at ${hhmm(NOW + 100 * MIN)}`)
  })
})

describe('the Keep warm switch', () => {
  for (const surface of SURFACES) {
    test(`sits after Band in the top row, in its style, on by default (${surface})`, async ($, on) => {
      engine(on)
      await start($)
      const p = await pane($, surface)
      const band = await p.find({ type: 'Button', key: 'band' })
      const keep = await p.find({ type: 'Button', key: 'keep-warm' })
      await p.unmount()
      expect(keep?.props?.label).toBe('● Keep warm')
      expect(keep?.props?.plain).toBe(band?.props?.plain)
      expect(keep?.props?.dimColor).toBeUndefined()
      await pressKeepWarm($, surface)
      expect(await keepWarmLabel($, surface)).toBe('○ Keep warm')
    })
  }

  test('the choice is saved per project, beside the other projects', async ($, on) => {
    fakeFs(on)
    const { store } = engine(on, { store: { keepWarm: { '/work/other': true } } })
    await start($, '/work/app')
    await pressKeepWarm($)
    expect(store.keepWarm).toEqual({ '/work/other': true, '/work/app': false })
    await pressKeepWarm($)
    expect(store.keepWarm).toEqual({ '/work/other': true, '/work/app': true })
  })

  test('a project switched off starts off', async ($, on) => {
    fakeFs(on)
    engine(on, { store: { keepWarm: { '/work/app': false } } })
    await start($, '/work/app')
    for (const surface of SURFACES) expect(await keepWarmLabel($, surface)).toBe('○ Keep warm')
  })

  test('another project is on unless it was switched off there', async ($, on) => {
    fakeFs(on)
    engine(on, { store: { keepWarm: { '/work/app': false } } })
    await start($, '/work/other')
    expect(await keepWarmLabel($, 'terminal')).toBe('● Keep warm')
  })

  test('a store value of the wrong kind reads as on', async ($, on) => {
    engine(on, { store: { keepWarm: { '': 'no' } } })
    await start($)
    expect(await keepWarmLabel($, 'desktop')).toBe('● Keep warm')
  })

  test('a panel held from before 1.0.0030 reads as on, and its press works', async ($, on) => {
    expect(asPanel({ isBandHidden: true, isContextShown: false }).isKeepWarm).toBe(true)
    expect(asPanel({ isKeepWarm: 'off' }).isKeepWarm).toBe(true)
    expect(asPanel({ isKeepWarm: false }).isKeepWarm).toBe(false)
    expect(PANEL_DEFAULT.isKeepWarm).toBe(true)
    engine(on)
    const old: Record<string, unknown> = { ...PANEL_DEFAULT }
    delete old.isKeepWarm
    held(on, 'panel', old)
    for (const surface of SURFACES) expect(await keepWarmLabel($, surface)).toBe('● Keep warm')
    await pressKeepWarm($)
    expect(await keepWarmLabel($, 'terminal')).toBe('○ Keep warm')
  })
})

describe('the card and the band', () => {
  test('the card names what a renewal costs beside a cold restart, on the session model', async ($, on) => {
    engine(on)
    await start($)
    await mainTurn($)
    const card = await cardOf($)
    expect(card.renewal).toBe('renewal ≈ $0.15 · cold ≈ $6.16')
    expect(card.alt).toContain('renewal ≈ $0.15 · cold ≈ $6.16.')
    expect(card.alt).toMatch(/prices are estimates\.$/)
    const t = await look($, 'terminal')
    expect(t.texts).toContain('prices are estimates')
    // The desktop card draws both lines.
    const d = await band($, 'desktop')
    const svg = String((await d.findAll({ type: 'Svg' })).map((s: any) => s.props.source).find((s: string) => s.includes('prices are estimates')))
    await d.unmount()
    expect(svg).toContain(`keep warm: renews at ${hhmm(NOW + 50 * MIN)}`)
    expect(svg).toContain('renewal ≈ $0.15 · cold ≈ $6.16')
  })

  test('an unpriced model has no cost line; keep warm still says what it does', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    for await (const _ of $.turn.step({ model: 'mystery-model', turnId: 't', index: 0, messageCount: 1 } as any));
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, usage: { model: 'mystery-model', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any)
    await clock.advance(5000)
    const card = await cardOf($)
    expect(card.renewal).toBeUndefined()
    expect(card.keep).toBe(`keep warm: renews at ${hhmm(NOW + 50 * MIN)}`)
  })

  test('the band row keeps its width: the chip says only the minutes left, whatever keep warm does', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await mainTurn($)
    const before = await look($, 'desktop')
    const termBefore = await look($, 'terminal', 120)
    await clock.set(NOW + RENEW_AT_MS)
    const after = await look($, 'desktop')
    expect(after.chip).toBe('WARM: 60m left')
    expect(after.widths[0]).toBe(before.widths[0])
    for (const columns of [60, 100, 200, 400]) {
      const l = await look($, 'desktop', columns)
      expect(l.widths[0]).toBe(before.widths[0]) // the chip's own drawing
      expect(l.chip).not.toMatch(/keep|renew|kept/)
    }
    const termAfter = await look($, 'terminal', 120)
    expect(termAfter.texts).toContain(' 60m left')
    expect(termAfter.texts.filter(t => /keep warm|kept warm/.test(t))).toEqual([]) // the card is folded: nothing on the row
    expect(termBefore.texts.length).toBe(termAfter.texts.length)
    // With a flow, the progress drawing still gives the chip and its chevron exactly their room.
    await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] } as any)
    for (const columns of [60, 100, 200, 400]) {
      const l = await look($, 'desktop', columns)
      expect(l.widths[0]).toBe(Math.max(180, Math.min(1600, columns * 9 - 180) - (l.widths[1]! + CACHE_FOLD_PX) - 56))
      expect(l.widths[1]).toBe(before.widths[0])
    }
    const bar = (await look($, 'terminal', 120)).texts.find(t => /^[█░]+$/.test(t)) ?? ''
    const titleW = Math.max(8, Math.min(30, 'FlowDeck'.length + 2, Math.floor(120 / 3)))
    expect(bar.length).toBe(Math.max(6, Math.min(40, 120 - titleW - 32 - (' WARM '.length + 1 + '60m left'.length + 1 + 1 + 2))))
  })
})

describe('keep warm, pure', () => {
  const facts = { lastAt: NOW, tokens: TOKENS, window: 1e6, model: 'claude-opus-5-5' }
  const k = (o: Partial<typeof KEEP_WARM_DEFAULT> = {}) => ({ ...KEEP_WARM_DEFAULT, ...o })

  test('the status and its line', () => {
    expect(keepStatus(facts, k(), true, NOW)).toEqual({ kind: 'due', renewals: 0, at: NOW + RENEW_AT_MS })
    expect(keepStatus(facts, k(), false, NOW).kind).toBe('off')
    expect(keepStatus({ ...facts, tokens: KEEP_WARM_MIN_TOKENS - 1 }, k(), true, NOW).kind).toBe('small')
    expect(keepStatus({ ...facts, tokens: KEEP_WARM_MIN_TOKENS }, k(), true, NOW).kind).toBe('due')
    expect(keepStatus(facts, k({ renewals: 2 }), true, NOW).kind).toBe('limit')
    expect(keepStatus(facts, k({ failures: 2 }), true, NOW)).toEqual({ kind: 'failed', renewals: 0, retryAt: null })
    expect(keepStatus(facts, k({ failures: 1, triedAt: NOW + 50 * MIN }), true, NOW + 50 * MIN)).toEqual({ kind: 'failed', renewals: 0, retryAt: NOW + 52 * MIN })
    expect(keepStatus(facts, k({ failures: 1, triedAt: NOW + 58 * MIN }), true, NOW + 58 * MIN)).toEqual({ kind: 'failed', renewals: 0, retryAt: null }) // no time left to retry
    expect(keepStatus(facts, k(), true, NOW + TTL_MS).kind).toBe('missed')
    expect(keepStatus(facts, k({ renewals: 1, renewedAt: NOW + 50 * MIN }), true, NOW + 60 * MIN)).toEqual({ kind: 'due', renewals: 1, at: NOW + 100 * MIN })
    const at = hhmm(NOW + 50 * MIN, 'UTC')
    expect(at).toBe('09:50')
    expect(keepText({ kind: 'due', renewals: 0, at: NOW + 50 * MIN }, 'UTC')).toBe('keep warm: renews at 09:50')
    expect(keepText({ kind: 'due', renewals: 1, at: NOW + 100 * MIN }, 'UTC')).toBe('kept warm ×1 · renews at 10:40')
    expect(keepText({ kind: 'limit', renewals: 2 })).toBe('kept warm ×2 · limit reached')
    expect(keepText({ kind: 'off', renewals: 0 })).toBe('keep warm: off')
    expect(keepText({ kind: 'failed', renewals: 0, retryAt: null })).toBe('keep warm: failed')
    expect(keepText({ kind: 'failed', renewals: 0, retryAt: NOW + 52 * MIN }, 'UTC')).toBe('keep warm: failed · retry at 09:52')
    expect(keepText({ kind: 'small', renewals: 0 })).toBe('keep warm: below 80k tokens')
    expect(keepText({ kind: 'missed', renewals: 0 })).toBe('keep warm: not renewed')
    expect(keepText({ kind: 'missed', renewals: 1 })).toBe('kept warm ×1')
    // 24-hour, never AM or PM
    expect(keepText({ kind: 'due', renewals: 0, at: Date.UTC(2026, 9, 30, 21, 5) }, 'UTC')).toBe('keep warm: renews at 21:05')
  })

  test('due exactly at minute 50, not before, never while a turn runs or with nothing to show', () => {
    expect(isRenewDue(facts, k(), true, NOW + RENEW_AT_MS - 1)).toBe(false)
    expect(isRenewDue(facts, k(), true, NOW + RENEW_AT_MS)).toBe(true)
    expect(isRenewDue(facts, k({ turnAt: NOW + 1 }), true, NOW + RENEW_AT_MS)).toBe(false)
    expect(isRenewDue(facts, k(), false, NOW + RENEW_AT_MS)).toBe(false)
    expect(isRenewDue(null, k(), true, NOW + RENEW_AT_MS)).toBe(false)
    expect(isRenewDue(facts, k({ triedAt: NOW + RENEW_AT_MS - 30_000 }), true, NOW + RENEW_AT_MS)).toBe(false) // never twice in a minute
  })

  test('the view counts the hour from the later of the last request and the last renewal; the idle time from the request', () => {
    const v = viewOf(facts, NOW + 70 * MIN, k({ renewals: 1, renewedAt: NOW + 50 * MIN }))!
    expect(v.mode).toBe('warm')
    expect(v.idleMs).toBe(70 * MIN)
    expect(v.warmMs).toBe(20 * MIN)
  })

  test('the held bookkeeping reads old and junk shapes', () => {
    expect(asKeepWarm(undefined)).toEqual(KEEP_WARM_DEFAULT)
    expect(asKeepWarm('x')).toEqual(KEEP_WARM_DEFAULT)
    expect(asKeepWarm({ renewals: 1, failures: 'two', turnAt: -5, extra: true })).toEqual({ ...KEEP_WARM_DEFAULT, renewals: 1 })
  })
})

describe('the toggle and collapse glyphs', () => {
  test('foldGlyph: solid down triangle open, solid right triangle with the text selector folded', async () => {
    expect(foldGlyph(true)).toBe('\u25bc')
    expect(foldGlyph(false)).toBe('\u25b6\ufe0e')
    expect(FOLD_OPEN).toBe('\u25bc')
    expect(FOLD_SHUT).toBe('\u25b6\ufe0e')
  })

  for (const surface of SURFACES) {
    test(`the top row: fold glyphs on Context and Usage, dot switches on Band and Keep warm, both states (${surface})`, async ($, on) => {
      engine(on)
      await start($)
      const p = await pane($, surface)
      const labels = async () => {
        const out: string[] = []
        for (const key of ['context', 'usage', 'band', 'keep-warm']) out.push(String((await p.find({ type: 'Button', key }))?.props?.label))
        return out
      }
      expect(await labels()).toEqual(['\u25bc Context', '\u25bc Usage', '\u25cf Band', '\u25cf Keep warm'])
      for (const key of ['context', 'usage', 'band', 'keep-warm']) await p.press({ key })
      expect(await labels()).toEqual(['\u25b6\ufe0e Context', '\u25b6\ufe0e Usage', '\u25cb Band', '\u25cb Keep warm'])
      await p.unmount()
    })
  }
})
