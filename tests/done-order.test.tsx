import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { newestFirst } from '../hooks/order'
import { doneText, hhmm } from '../hooks/time'
import { fakeFs } from './fake-fs'
import { seed, sessions } from './archive-files'
import { showTab } from './tabs'
import type { Tab } from './tabs'

// Every finished row shows when it finished, and every list is ordered by it, latest on top, whatever the order the
// rows were archived, trashed or restored in.
const NOW = Date.UTC(2026, 9, 30, 9, 0)
const MIN = 60_000
const DIR = '/work/app/.claude/flowdeck'

function engine(on: any, opts: { files?: Record<string, string> } = {}) {
  const store: Record<string, unknown> = {}
  const fs = fakeFs(on, { files: opts.files })
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  return { files: fs.files, clock, fs }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-light', description, tool_use_id: id } as any)
const turnStep = async ($: any, agentId: string) => {
  for await (const _ of $.turn.step({ agentId, model: 'claude-opus-5-5', turnId: 't', index: 0, messageCount: 1 } as any));
}
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const pane = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', tab: Tab = 'finished') => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 90 } } as any)
}
const look = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', tab: Tab = 'finished'): Promise<{ texts: string[]; keys: string[]; alts: string[]; svgs: string[] }> => {
  const p = await pane($, surface, tab)
  const texts: string[] = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const keys: string[] = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))
  const alts: string[] = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt ?? ''))
  const svgs: string[] = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.source ?? ''))
  await p.unmount()
  return { texts, keys, alts, svgs }
}
const press = async ($: any, key: string, tab: Tab = 'finished') => {
  const p = await pane($, 'terminal', tab)
  await p.press({ key })
  await settle()
  await p.unmount()
}

// Workers w1..w4 start in that order, a minute apart, and finish in the order `ends` gives (w3 first, …).
async function runs($: any, clock: { now: number }, ends: number[]) {
  await progress($, { title: 'Ship', total: 4, phase: 'delegate', tasks: [1, 2, 3, 4].map(i => ({ title: `task ${i}`, tier: 'light' })) })
  for (const i of [1, 2, 3, 4]) {
    clock.now = NOW + i * MIN
    await spawn($, `w${i}`, `task ${i}`)
    await turnStep($, `w${i}`)
  }
  for (const [k, i] of ends.entries()) {
    clock.now = NOW + (10 + k) * MIN
    await complete($, `w${i}`)
  }
  clock.now = NOW + 20 * MIN
}
const rowOrder = (texts: string[]) => texts.filter(t => /^\d\. task \d$/.test(t)).map(t => Number(t.slice(-1)))

describe('completion times on the rows', () => {
  test('finished rows show when they finished, 24-hour, at the end of the name line; running rows show none', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', total: 2, phase: 'delegate', tasks: [{ title: 'task 1', tier: 'light' }, { title: 'task 2', tier: 'light' }] })
    clock.now = NOW + MIN
    await spawn($, 'w1', 'task 1')
    await spawn($, 'w2', 'task 2')
    clock.now = NOW + 14 * 60 * MIN + 7 * MIN // 23:07 UTC
    await complete($, 'w1')
    const at = NOW + 14 * 60 * MIN + 7 * MIN
    const t = await look($)
    expect(t.texts).toContain(doneText(at, at))
    expect(doneText(at, at)).toMatch(/^\d\d:\d\d$/)
    expect(t.texts.some(x => /AM|PM/.test(x))).toBe(false)
    const d = await look($, 'desktop')
    expect(d.texts).toContain(hhmm(at))
    // The running row (Active tab) shows no time.
    const a = await look($, 'terminal', 'active')
    expect(a.texts).not.toContain(hhmm(at))
  })

  test('a row finished on an earlier day shows the day too', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', total: 1, phase: 'delegate', tasks: [{ title: 'task 1', tier: 'light' }] })
    await spawn($, 'w1', 'task 1')
    clock.now = NOW + 5 * MIN
    await complete($, 'w1')
    clock.now = NOW + 26 * 60 * MIN
    const t = await look($)
    expect(t.texts).toContain(`Oct 30 · ${hhmm(NOW + 5 * MIN)}`)
    expect(t.texts.some(x => /^Oct 30 · \d\d:\d\d$/.test(x))).toBe(true)
  })

  test('an accepted task with no run shows when it was accepted and sits by that time', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await runs($, clock, [1, 2, 3, 4]) // ends at NOW+10..13 min
    clock.now = NOW + 11 * MIN + 30_000
    await progress($, { add: [{ title: 'by hand', tier: 'medium' }] })
    await progress($, { done: [5] })
    clock.now = NOW + 20 * MIN
    const t = await look($)
    expect(t.texts.some(x => x.includes('5. by hand'))).toBe(true)
    expect(t.texts).toContain(doneText(NOW + 11 * MIN + 30_000, NOW + 20 * MIN))
    // Between w2 (ended +11) and w3 (ended +12): latest first.
    const order = t.texts.filter(x => /^(\d\. task \d|.*5\. by hand)$/.test(x)).map(x => (x.includes('by hand') ? 5 : Number(x.slice(-1))))
    expect(order).toEqual([4, 3, 5, 2, 1])
  })

  test('an archived entry without accepted times uses its own end for them', async ($, on) => {
    const files: Record<string, string> = {}
    const end = NOW - 30 * MIN
    seed(files, DIR, [
      { id: 'old', project: '/work/app', title: 'Old', startedAt: end - 60 * MIN, endedAt: end, status: 'finished', done: 1, total: 1, tasks: [{ title: 'by hand', tier: 'medium' }], accepted: [1], cost: 0, tokens: 0, time: 0, agents: [{ id: 'r', type: 'flowdeck-light', description: 'other', model: 'm', status: 'done', startedAt: end - 50 * MIN, endedAt: end - 40 * MIN, contextTokens: 0, contextMax: 0, tokens: 0, costUsd: 0, steps: 1, round: 1 }] },
    ])
    engine(on, { files })
    await start($)
    await settle()
    const t = await look($, 'terminal', 'archive')
    expect(t.texts).toContain(hhmm(end))
    expect(t.texts).toContain(hhmm(end - 40 * MIN))
  })
})

describe('one order everywhere: latest completion first', () => {
  test('the comparator: end, then start, then id', () => {
    const list = [
      { end: 5, start: 1, id: 'b' },
      { end: 5, start: 1, id: 'a' },
      { end: 5, start: 2, id: 'c' },
      { end: 9, start: 0, id: 'd' },
    ]
    expect([...list].sort(newestFirst).map(x => x.id)).toEqual(['d', 'c', 'a', 'b'])
  })

  test('the Finished list is ordered by when rows finished, not when they started', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await runs($, clock, [3, 1, 4, 2])
    expect(rowOrder((await look($)).texts)).toEqual([2, 4, 1, 3])
    const d = await look($, 'desktop')
    expect(d.alts.filter(a => /^task \d: /.test(a)).map(a => Number(a[5]))).toEqual([2, 4, 1, 3])
  })

  test('⤓ archives the pressed row and every row that finished before it, whatever their start order', async ($, on) => {
    const { clock, files } = engine(on)
    await start($)
    await runs($, clock, [3, 1, 4, 2]) // finished: w3, w1, w4, w2 (newest)
    await press($, 'archive-item-w1')
    // w1 and w3 finished at or before w1: they go; w4 and w2 stay.
    expect(rowOrder((await look($)).texts)).toEqual([2, 4])
    const saved = sessions(files, DIR)[0]
    expect(saved.agents.map((a: any) => a.id).sort()).toEqual(['w1', 'w3'])
  })

  for (const presses of [['w4', 'w2'], ['w2'], ['w1', 'w4', 'w2']]) {
    test(`archive presses ${presses.join(' then ')} leave the same rows in the same order in the Archive group`, async ($, on) => {
      const { clock } = engine(on)
      await start($)
      await runs($, clock, [3, 1, 4, 2])
      for (const id of presses) await press($, `archive-item-${id}`)
      await progress($, { finished: true })
      await settle()
      expect(rowOrder((await look($, 'terminal', 'archive')).texts)).toEqual([2, 4, 1, 3])
    })
  }

  test('the Archive list is ordered by each session’s end, whatever order they were saved in', async ($, on) => {
    const files: Record<string, string> = {}
    const e = (i: number, end: number) => ({ id: `s${i}`, project: '/work/app', title: `S${i}`, startedAt: end - MIN, endedAt: end, status: 'finished', done: 0, total: 1, tasks: [{ title: 't', tier: 'medium' }], cost: 0, tokens: 0, time: MIN })
    seed(files, DIR, [e(1, NOW - 3 * MIN), e(2, NOW - 1 * MIN), e(3, NOW - 2 * MIN)])
    engine(on, { files })
    await start($)
    await settle()
    const p = await pane($, 'terminal', 'archive')
    const keys = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key)).filter((k: string) => /^archive-k[a-z0-9]+$/.test(k))
    await p.unmount()
    expect(keys).toEqual(['s2', 's3', 's1'].map(id => `archive-${keyOf(id)}`))
  })
})
