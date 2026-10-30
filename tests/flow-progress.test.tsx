import { describe, expect, test } from 'claude-code/testing'

import { applyItemOps, finishItems, itemElapsed, itemLine, parseSteps, timedItems } from '../hooks/agent-items'
import type { AgentItem } from '../types'
import { doneText } from '../hooks/time'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

const NOW = Date.UTC(2026, 9, 30, 9, 0)

function engine(on: any, opts: { clockFails?: () => boolean } = {}) {
  const store: Record<string, unknown> = { historyShown: false }
  const fs = fakeFs(on)
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => {
    if (opts.clockFails?.()) throw new Error('clock down')
    return { value: clock.now }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { clock, fs }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const spawn = ($: any, id: string, description: string, type = 'flowdeck-medium') => $.agent.spawn({ subagentType: type, description, tool_use_id: id } as any)
const step = ($: any, agentId: string, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__step', agentId, ...input } as any)
const complete = ($: any, agentId: string, reason = 'answer') => $.turn.complete({ reason, answer: 'ok', durationMs: 1, agentId } as any)
const pane = async ($: any, surface: 'terminal' | 'desktop', tab: Tab = 'active', bodyColumns = 80) => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
}
const band = ($: any, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } } as any)

// What the band says on both surfaces: the desktop drawing's alt and source, the terminal's label and percent.
async function bandSays($: any) {
  const d = await band($, 'desktop')
  const svg = (await d.findAll({ type: 'Svg' })).find((s: any) => /: (Tasks|Done|Plan|Design|Review)\b.*%$/.test(String(s.props.alt)))
  await d.unmount()
  const t = await band($, 'terminal')
  const texts = (await t.findAll({ type: 'Text' })).map((x: any) => String(x.text))
  await t.unmount()
  return { alt: String(svg?.props.alt ?? ''), source: String(svg?.props.source ?? ''), texts }
}
async function tabCounts($: any) {
  const p = await pane($, 'terminal')
  const labels = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.text ?? b.props.label))
  await p.unmount()
  return { active: labels.find(l => l.startsWith('Active')), finished: labels.find(l => l.startsWith('Finished')) }
}
const expectBand = async ($: any, count: string, percent: string) => {
  const b = await bandSays($)
  expect(b.alt.endsWith(`: Tasks ${count}, ${percent}`)).toBe(true)
  expect(b.source).toContain(`>Tasks ${count}<`)
  expect(b.source).toContain(`>${percent}<`)
  expect(b.texts).toContain(`Tasks ${count}`)
  expect(b.texts).toContain(percent)
}

const SIX = ['Read code', 'Wire it', 'Polish', 'Docs', 'Tests', 'Release'].map(title => ({ title, tier: 'medium' }))

describe('the band counts the rows the tabs count', () => {
  test("the owner's flow: 2 finished, 3 running, 1 ready reads 3/6 (where it is; not the orchestrator's 1/3)", async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.map((t, i) => (i === 5 ? { ...t, after: [1] } : t)) })
    for (const [id, title] of [['w1', 'Read code'], ['w2', 'Wire it'], ['w3', 'Polish'], ['w4', 'Docs'], ['w5', 'Tests']]) await spawn($, id!, title!)
    await complete($, 'w1')
    await complete($, 'w2')
    // The orchestrator's own count lags behind: one accepted, as the live panel showed `1/3`.
    await progress($, { done: 1 })
    await expectBand($, '3/6', '33%')
    expect(await tabCounts($)).toEqual({ active: 'Active (4)', finished: 'Finished (2)' })
  })

  test('while a task runs X is the running task: 0 done + 1 running of 2 reads 1/2, the bar still empty', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 2) })
    await expectBand($, '0/2', '0%') // nothing runs: the done count
    await spawn($, 'w1', 'Read code')
    await expectBand($, '1/2', '0%')
    expect((await bandSays($)).source).toContain('#8f8cf4') // not green: nothing is done
  })

  test('3 done and the 4th running of 7 reads 4/7; idle with 3 done reads 3/7; all done reads 7/7, then Done in green', async ($, on) => {
    engine(on)
    await start($)
    const SEVEN = [...SIX, { title: 'Announce', tier: 'medium' }]
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SEVEN })
    for (const [i, t] of SEVEN.slice(0, 3).entries()) {
      await spawn($, `w${i + 1}`, t.title)
      await complete($, `w${i + 1}`)
    }
    await expectBand($, '3/7', '43%')
    await spawn($, 'w4', 'Docs')
    await expectBand($, '4/7', '43%')
    await complete($, 'w4')
    for (const [i, t] of SEVEN.slice(4).entries()) {
      await spawn($, `w${i + 5}`, t.title)
      await complete($, `w${i + 5}`)
    }
    await expectBand($, '7/7', '100%')
    // the flow finishes: Done, in green
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    const b = await bandSays($)
    expect(b.alt).toBe('FlowDeck: Done, 100%')
    expect(b.source).toContain('#5fbf8f')
  })
})

describe('the band title says where the flow is', () => {
  // The title as each surface shows it: the desktop alt's head and drawing, the terminal's title Text.
  const titleOf = async ($: any) => {
    const b = await bandSays($)
    return { alt: b.alt.replace(/: (Tasks|Done)\b.*$/, ''), source: b.source, texts: b.texts }
  }

  test('one running: its task title, never the flow title; a description without a task loses its #n', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 3) })
    await spawn($, 'w2', '#2 Wire it')
    const t = await titleOf($)
    expect(t.alt).toBe('Wire it')
    expect(t.source).toMatch(/<text class="t" x="16"[^>]*>Wire it<\/text>/) // the title's ink, as before
    expect(t.source).not.toContain('Ship')
    expect(t.texts).toContain('Wire it')
    expect(t.texts).not.toContain('Ship')
    await complete($, 'w2')
    await spawn($, 'x1', '#9 Look around', 'Explore') // linked to no task
    expect((await titleOf($)).alt).toBe('Look around')
  })

  test('two running: the lowest-numbered task and +1', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 4) })
    await spawn($, 'w3', 'Polish')
    await spawn($, 'w2', 'Wire it')
    const t = await titleOf($)
    expect(t.alt).toBe('Wire it +1')
    expect(t.texts).toContain('Wire it +1')
  })

  test('none running with a task queued: the next ready task; all done: FlowDeck', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Read code', tier: 'medium' }, { title: 'Wire it', tier: 'medium', after: [1] }, { title: 'Docs', tier: 'medium' }] })
    expect((await titleOf($)).alt).toBe('Read code') // ready, first in plan order
    await spawn($, 'w1', 'Read code')
    await complete($, 'w1')
    expect((await titleOf($)).alt).toBe('Wire it')
    await progress($, { done: [1, 2, 3] })
    const t = await titleOf($)
    expect(t.alt).toBe('FlowDeck')
    expect(t.texts).toContain('FlowDeck')
  })

  test('a long title is cut with an ellipsis on the desktop and keeps the bar its room', async ($, on) => {
    engine(on)
    await start($)
    const LONG = 'Rewrite the whole archive importer so that every legacy volume is read once and never again'
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: LONG, tier: 'medium' }] })
    await spawn($, 'w1', LONG)
    const t = await titleOf($)
    expect(t.alt).toBe(LONG)
    const drawn = /<text class="t" x="16"[^>]*>([^<]*)<\/text>/.exec(t.source)?.[1] ?? ''
    expect(drawn.endsWith('…')).toBe(true)
    expect(LONG.startsWith(drawn.slice(0, -1))).toBe(true)
    // the bar starts after the shown title, inside the row's first half
    const barX = Number(/<g transform="translate\((\d+),/.exec(t.source)?.[1])
    const W = Number(/<svg[^>]* width="(\d+)"/.exec(t.source)?.[1])
    expect(barX).toBeLessThan(W * 0.4 + 40)
  })
})

describe('the band counts the rows the tabs count', () => {
  test('a run linked to no task is a row of its own', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 2) })
    await spawn($, 'x1', 'look around', 'Explore')
    await complete($, 'x1')
    await expectBand($, '1/3', '33%')
    expect(await tabCounts($)).toEqual({ active: 'Active (2)', finished: 'Finished (1)' })
  })

  test('Incomplete and failed rows are finished but not done', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 3) })
    await spawn($, 'w1', 'Read code')
    await step($, 'w1', { steps: [{ title: 'one' }, { title: 'two' }] })
    await complete($, 'w1') // `one` closes with the run, `two` stays: Incomplete
    await spawn($, 'w2', 'Wire it')
    await complete($, 'w2', 'error')
    await expectBand($, '0/3', '0%')
    expect(await tabCounts($)).toEqual({ active: 'Active (1)', finished: 'Finished (2)' })
    // Accepting the Incomplete task does not make its run done; an accepted task with no run is.
    await progress($, { done: [1, 3] })
    await expectBand($, '1/3', '33%')
  })

  test('with no row at all the orchestrator total and count stay; a fresh plan reads 0/N', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', total: 4, done: 1 })
    await expectBand($, '1/4', '25%')
    await progress($, { finished: true })
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 5) })
    await expectBand($, '0/5', '0%')
  })

  test('archived rows stay counted as finished: archiving never moves the band back', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 3) })
    await spawn($, 'w1', 'Read code')
    await spawn($, 'w2', 'Wire it')
    clock.now = NOW + 60_000
    await complete($, 'w1')
    clock.now = NOW + 61_000
    await complete($, 'w2')
    await expectBand($, '2/3', '67%')
    const p = await pane($, 'terminal', 'finished')
    await p.press({ key: 'archive-item-w2' })
    await settle()
    await p.unmount()
    expect(await tabCounts($)).toEqual({ active: 'Active (1)', finished: 'Finished (0)' })
    await expectBand($, '2/3', '67%')
  })
})

describe('every agent row folds', () => {
  const detail = (t: string) => new RegExp(`Opus 5\\.5 · started ${doneText(NOW, NOW)} · \\d+ tokens · ≈\\$\\d\\.\\d\\d`).test(t)

  test('terminal: a running row with no step list has a dim chevron and opens on its details', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 3) })
    await spawn($, 'w1', 'Read code')
    await spawn($, 'w2', 'Wire it')
    await step($, 'w2', { steps: [{ title: 'one' }, { title: 'two' }] })
    let p = await pane($, 'terminal')
    const chevrons = (await p.findAll({ type: 'Button' })).filter((b: any) => /^agent-fold-/.test(String(b.props.key)))
    expect(chevrons.map((b: any) => [String(b.props.key), String(b.props.label), b.props.dimColor])).toEqual([
      ['agent-fold-w2', '▸', false],
      ['agent-fold-w1', '▸', true],
    ])
    // planned rows do not fold
    expect((await p.findAll({ type: 'Button' })).some((b: any) => /plan-/.test(String(b.props.key)))).toBe(false)
    await p.press({ key: 'agent-fold-w1' })
    await settle()
    await p.unmount()
    p = await pane($, 'terminal')
    const texts = (await p.findAll({ type: 'Text' })).map((x: any) => ({ text: String(x.text), dim: x.props.dimColor }))
    const buttons = await p.findAll({ type: 'Button' })
    await p.unmount()
    expect(buttons.find((b: any) => b.props.key === 'agent-fold-w1')?.props.label).toBe('▾')
    expect(buttons.find((b: any) => b.props.key === 'agent-fold-w2')?.props.label).toBe('▸') // only the row pressed opens
    expect(texts.some(x => detail(x.text) && x.dim)).toBe(true)
    expect(texts.some(x => x.text.trim() === 'No steps reported yet' && x.dim)).toBe(true)
    expect(texts.some(x => /\btwo\b/.test(x.text))).toBe(false) // w2's items stay folded
    // the press folds it again
    p = await pane($, 'terminal')
    await p.press({ key: 'agent-fold-w1' })
    await settle()
    await p.unmount()
    p = await pane($, 'terminal')
    const after = (await p.findAll({ type: 'Text' })).map((x: any) => String(x.text))
    await p.unmount()
    expect(after.some(t => t.includes('No steps reported yet'))).toBe(false)
  })

  test('desktop: the chevron sits in the slot before the name on every row; a row without items opens on its details', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 3) })
    await spawn($, 'w1', 'Read code')
    await spawn($, 'w2', 'Wire it')
    await step($, 'w2', { steps: [{ title: 'one' }, { title: 'two' }] })
    let p = await pane($, 'desktop')
    const buttons = await p.findAll({ type: 'Button' })
    expect(buttons.filter((b: any) => /^agent-fold-/.test(String(b.props.key))).map((b: any) => [String(b.props.key), b.props.dimColor])).toEqual([
      ['agent-fold-w2', false],
      ['agent-fold-w1', true],
    ])
    await p.press({ key: 'agent-fold-w1' })
    await settle()
    await p.unmount()
    p = await pane($, 'desktop')
    const svgs = await p.findAll({ type: 'Svg' })
    await p.unmount()
    const kids = svgs.filter((s: any) => Number(s.props.height) === 22).map((s: any) => String(s.props.alt))
    expect(kids.length).toBe(2)
    expect(detail(kids[0]!)).toBe(true)
    expect(kids[1]).toBe('No steps reported yet')
    const src = String(svgs.find((s: any) => s.props.alt === 'No steps reported yet')?.props.source)
    expect(src).toContain('class="s"')
    expect(src).toContain('x="58"') // the child rows' title column
  })

  test('a finished row without items folds too, live and in the Finished tab', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 2) })
    await spawn($, 'w1', 'Read code')
    await complete($, 'w1')
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface, 'finished')
      const b = (await p.findAll({ type: 'Button' })).find((x: any) => x.props.key === 'agent-fold-w1')
      await p.unmount()
      expect(b?.props.label).toBe('▸')
      expect(b?.props.dimColor).toBe(true)
    }
  })
})

describe('every done or failed step shows a time', () => {
  const it = (title: string, status: AgentItem['status'], startedAt?: number, doneAt?: number): AgentItem => ({ title, status, ...(startedAt === undefined ? {} : { startedAt }), ...(doneAt === undefined ? {} : { doneAt }) })
  const times = (items: AgentItem[], run: { startedAt?: number; endedAt?: number }, now = NOW + 600_000) =>
    timedItems(items, run).map(x => itemLine(x, now, 80).time)

  test('the first move to done or failed stamps doneAt; an existing one is never overwritten', () => {
    let items = parseSteps([{ title: 'a' }, { title: 'b' }, { title: 'c' }], [], NOW) ?? []
    items = applyItemOps(items, { done: ['c'] }, NOW + 5000).items // out of order
    expect(items[2]).toEqual({ title: 'c', status: 'done', doneAt: NOW + 5000 })
    items = applyItemOps(items, { done: ['c'] }, NOW + 9000).items
    expect(items[2]!.doneAt).toBe(NOW + 5000)
    items = applyItemOps(items, { failed: 'c' }, NOW + 9000).items
    expect(items[2]).toEqual({ title: 'c', status: 'error', doneAt: NOW + 5000 })
    // a resent list that says done keeps the start and dates the end
    const resent = parseSteps([{ title: 'a', status: 'done' }, { title: 'b' }, { title: 'c', status: 'error' }], items, NOW + 12_000) ?? []
    expect(resent[0]).toEqual({ title: 'a', status: 'done', startedAt: NOW, doneAt: NOW + 12_000 })
    expect(finishItems([{ title: 'x', status: 'active', startedAt: NOW }], true, NOW + 3000)[0]).toEqual({ title: 'x', status: 'done', startedAt: NOW, doneAt: NOW + 3000 })
  })

  test('sequential steps: each from its start to its end', () => {
    let items = parseSteps([{ title: 'a' }, { title: 'b' }, { title: 'c' }], [], NOW) ?? []
    items = applyItemOps(items, { next: true }, NOW + 4000).items
    items = applyItemOps(items, { next: true }, NOW + 10_000).items
    items = applyItemOps(items, { next: true }, NOW + 11_000).items
    expect(times(items, { startedAt: NOW - 2000 })).toEqual(['4s', '6s', '1s'])
  })

  test('out of order done: a step never made active starts where the step before it ended, else at the run start', () => {
    let items = parseSteps([{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }], [], NOW) ?? []
    items = applyItemOps(items, { done: ['c'] }, NOW + 5000).items // a stays active, c done without a start
    items = applyItemOps(items, { done: ['a'] }, NOW + 8000).items // b becomes active
    items = applyItemOps(items, { done: ['d'] }, NOW + 9000).items
    // a 8s; b active from 8000 (live); c from the run start (nothing ended before it) 7s; d from c's end 4s
    expect(times(items, { startedAt: NOW - 2000 }, NOW + 20_000)).toEqual(['8s', '12s', '7s', '4s'])
  })

  test('a batch close at the end: every closed step has a time, the batch ones 0s', () => {
    let items = parseSteps([{ title: 'a' }, { title: 'b' }, { title: 'c' }], [], NOW) ?? []
    items = applyItemOps(items, { done: ['a', 'b', 'c'] }, NOW + 30_000).items
    expect(times(items, { startedAt: NOW })).toEqual(['30s', '0s', '0s'])
  })

  test('a failed step shows its time; pending ones none; an active one runs to now', () => {
    let items = parseSteps([{ title: 'a' }, { title: 'b' }, { title: 'c' }], [], NOW) ?? []
    items = applyItemOps(items, { failed: 'a' }, NOW + 3000).items
    expect(times(items, { startedAt: NOW }, NOW + 5000)).toEqual(['3s', '', ''])
    items = applyItemOps(items, { active: 'b' }, NOW + 4000).items
    expect(times(items, { startedAt: NOW }, NOW + 5000)).toEqual(['3s', '1s', ''])
  })

  test('saved items without times: from the neighbours and the run', () => {
    const saved = [it('a', 'done'), it('b', 'done', NOW + 10_000, NOW + 15_000), it('c', 'done'), it('d', 'error'), it('e', 'pending')]
    // a: run start to b's start; c: from b's end, to the run end; d: from c's end (the run end), 0s
    expect(times(saved, { startedAt: NOW, endedAt: NOW + 40_000 })).toEqual(['10s', '5s', '25s', '0s', ''])
    // without a run end, an item with nothing after it ends where it starts
    expect(times([it('a', 'done')], { startedAt: NOW })).toEqual(['0s'])
    expect(itemElapsed(timedItems([it('a', 'done')], { startedAt: NOW })[0]!, NOW)).toBe(0)
  })

  test('in the panel: steps closed out of order, in a batch and without a clock all show a time, desktop and terminal', async ($, on) => {
    let broken = false
    const { clock } = engine(on, { clockFails: () => broken })
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: SIX.slice(0, 1) })
    await spawn($, 'w1', 'Read code')
    await step($, 'w1', { steps: ['a', 'b', 'c', 'd', 'e'].map(title => ({ title })) })
    clock.now = NOW + 5000
    await step($, 'w1', { next: true })
    clock.now = NOW + 7000
    await step($, 'w1', { done: ['d'] })
    broken = true
    await step($, 'w1', { done: ['b'] }) // no clock: saved without a time
    broken = false
    clock.now = NOW + 20_000
    await step($, 'w1', { done: ['c', 'e'] })
    clock.now = NOW + 21_000
    await complete($, 'w1')
    let p = await pane($, 'terminal', 'finished')
    await p.press({ key: 'agent-fold-w1' })
    await settle()
    await p.unmount()
    p = await pane($, 'terminal', 'finished')
    const lines = (await p.findAll({ type: 'Text' })).map((x: any) => String(x.text)).filter((t: string) => /^ {3}✓ [a-e]\b/.test(t))
    await p.unmount()
    expect(lines.length).toBe(5)
    for (const l of lines) expect(l).toMatch(/\d+s$/)
    p = await pane($, 'desktop', 'finished')
    const alts = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt)).filter((a: string) => /^[a-e]: Done /.test(a))
    await p.unmount()
    expect(alts.length).toBe(5)
    for (const a of alts) expect(a).toMatch(/ \d+s$/)
  })
})
