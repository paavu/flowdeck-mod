import { describe, expect, test } from 'claude-code/testing'

import { formatEntry, parseArchive, snapshot } from '../hooks/archive'
import { STATE_COLOR } from '../hooks/plan-view'
import { asFlow, asArchive } from '../hooks/shapes'
import { acceptedOf, acceptedOnly, linkRuns, unstarted } from '../hooks/tasks'
import type { AgentRun } from '../types'
import { acrossTabs, showTab } from './tabs'
import type { Tab } from './tabs'

const NOW = Date.UTC(2026, 9, 29, 14, 0)
const TICK = 'l3.5 3.5 6.5-7'
const t = (title: string, after: number[] = []) => ({ title, tier: 'medium', after })

describe('accepted tasks: which ones', () => {
  test('acceptedOf: the named numbers, or the first done tasks for a bare count; never past the list', () => {
    const tasks = [t('a'), t('b'), t('c')]
    expect(acceptedOf({ accepted: [3, 1], done: 2, tasks })).toEqual([3, 1])
    expect(acceptedOf({ done: 2, tasks })).toEqual([1, 2])
    expect(acceptedOf({ done: 9, tasks })).toEqual([1, 2, 3])
    expect(acceptedOf({ accepted: [0, 4, 2], done: 0, tasks })).toEqual([2])
  })

  test('an accepted task is no longer planned and counts as done for the tasks waiting on it', () => {
    const tasks = [t('a'), t('b', [1]), t('c', [2])]
    expect(unstarted(tasks, [], [1]).map(p => `${p.n}${p.ready ? '+' : ''}`)).toEqual(['2+', '3'])
  })

  test('acceptedOnly: accepted tasks no run belongs to, in plan order', () => {
    const tasks = [t('a'), t('b'), t('c')]
    const runs = [{ id: 'w2', description: 'b', status: 'done' as const }]
    expect(acceptedOnly(tasks, linkRuns(tasks, runs), [3, 2, 1, 3]).map(p => p.n)).toEqual([1, 3])
  })

  test('held flows and archive entries from before load: no accepted list, or a cleaned one', () => {
    const old = { title: 'x', total: 2, done: 1, running: 0, phase: 'delegate', isFinished: false, isLinked: true, tasks: [t('a')] }
    expect(asFlow(old)?.accepted).toBeUndefined()
    expect(asFlow({ ...old, accepted: [1, 'x', -2, 2.5, 2] })?.accepted).toEqual([1, 2])
    const flow = { ...old, phase: 'close' as const, tasks: [t('a'), t('b')], accepted: [2] }
    const e = snapshot({ flow, agents: [], project: '', startedAt: NOW - 5000, endedAt: NOW, status: 'finished' })
    expect(e.accepted).toEqual([2])
    expect(parseArchive(JSON.parse(JSON.stringify([e])))[0]?.accepted).toEqual([2])
    const { accepted: _, ...older } = e
    expect(asArchive([older])[0]?.accepted).toBeUndefined()
    expect(asArchive([{ ...e, accepted: ['x'] }])[0]?.accepted).toEqual([])
    expect(formatEntry(e).lines).toEqual(['○ a (medium)', '✓ b (medium)'])
    expect(formatEntry({ ...older, done: 1 }).lines).toEqual(['✓ a (medium)', '○ b (medium)'])
  })
})

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store: Record<string, unknown> = opts.store ?? { historyShown: false }
  const clock = { now: NOW }
  const registered: any[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', (_$: any, e: any) => {
    registered.push(e)
    return { value: undefined }
  })
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
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { clock, registered }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
// What the Active and Finished tabs draw (or the tabs named), one after the other.
const all = ($: any, surface: 'terminal' | 'desktop', type: string, tabs?: Tab[]) => acrossTabs($, () => pane($, surface), p => p.findAll({ type }), tabs)
const tabLabel = (buttons: any[], tab: Tab) => buttons.find((b: any) => String(b.props.key) === `tab-${tab}`)?.text
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-medium', description, tool_use_id: id } as any)
const step = ($: any, agentId: string, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__step', agentId, ...input } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const terminal = async ($: any, tabs?: Tab[]) => {
  const texts = await all($, 'terminal', 'Text', tabs)
  const buttons = await all($, 'terminal', 'Button', tabs)
  return { texts, text: texts.map((x: any) => x.text).join('\n'), buttons }
}
const desktop = async ($: any) => {
  const svgs = await all($, 'desktop', 'Svg')
  const buttons = await all($, 'desktop', 'Button')
  return { svgs, keys: buttons.map((b: any) => String(b.props.key)), source: (alt: RegExp) => String(svgs.find((s: any) => alt.test(String(s.props.alt)))?.props.source ?? '') }
}
const PLAN = [
  { title: 'Read code', tier: 'light' },
  { title: 'Wire it', tier: 'medium' },
  { title: 'Polish', tier: 'medium', after: [1] },
  { title: 'Docs', tier: 'light' },
]

describe('accepted tasks in the panel', () => {
  test('done as task numbers: the count is the number accepted, and they add up', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    expect(await progress($, { done: [1, 4, 9, 0] })).toBe('ok: Tasks 2/4')
    expect(await progress($, { done: [2] })).toBe('ok: Tasks 3/4')
    expect(await progress($, { done: [2] })).toBe('ok: Tasks 3/4')
  })

  test('a bare count still means the first N; a list after it adds to those', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    expect(await progress($, { done: 1 })).toBe('ok: Tasks 1/4')
    expect((await terminal($)).text).toMatch(/✓ {3}1\. Read code/)
    expect(await progress($, { done: [4] })).toBe('ok: Tasks 2/4')
    const t = await terminal($)
    expect(t.text).toMatch(/1\. Read code/)
    expect(t.text).toMatch(/4\. Docs/)
    expect(tabLabel(t.buttons, 'active')).toBe('● Active (2)')
    expect(tabLabel(t.buttons, 'finished')).toBe('Finished (2)')
  })

  test('an accepted task with no worker run is an Accepted row: tick, no bar, no archive icon, counted in Finished', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    await progress($, { done: [1] })
    const d = await desktop($)
    const row = d.source(/^1\. Read code: Accepted · no worker run$/)
    expect(row).toContain(TICK)
    expect(row).toContain(`fill="${STATE_COLOR.done}">  Accepted · no worker run`)
    expect(row).not.toContain('height="4" rx="2"') // no step bar
    expect(d.keys.some(k => k.startsWith('archive-item-'))).toBe(false)
    expect(d.svgs.some((s: any) => /^1\. Read code: planned/.test(String(s.props.alt)))).toBe(false)
    // task 3 waits for task 1: ready now
    expect(d.source(/^3\. Polish/)).toContain('>ready</tspan>')
    const t = await terminal($)
    expect(t.text).toMatch(/Accepted · no worker run/)
    expect(tabLabel(t.buttons, 'finished')).toBe('Finished (1)')
    expect(tabLabel(t.buttons, 'active')).toBe('● Active (3)')
  })

  test('an accepted task with a complete run is the normal Done row, no Accepted row', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    await spawn($, 'w2', '#2 Wire it')
    await complete($, 'w2')
    await progress($, { done: [2] })
    const d = await desktop($)
    expect(d.source(/^#2 Wire it:/)).toContain('>Done</tspan>')
    expect(d.svgs.some((s: any) => /Accepted/.test(String(s.props.alt)))).toBe(false)
    expect(d.keys.some(k => k.startsWith('archive-item-'))).toBe(false)
  })

  test('an accepted task whose run stays Incomplete reads Incomplete · accepted; a bare count never hides it either', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    await spawn($, 'w1', 'Read code')
    await step($, 'w1', { steps: [{ title: 'one' }, { title: 'two' }, { title: 'three' }] })
    await complete($, 'w1')
    for (const done of [[1], 4]) {
      await progress($, { done })
      const d = await desktop($)
      const src = d.source(/^Read code:/)
      expect(src).toContain('>Incomplete · accepted</tspan>')
      expect(src).not.toContain(TICK)
      expect(d.keys).not.toContain('archive-item-w1')
      expect((await terminal($)).text).toMatch(/Incomplete · accepted · 1\/3/)
    }
  })

  test('an Archive group draws Accepted rows from the saved list, and an older entry from its count', async ($, on) => {
    const base = { agentId: 'a1', type: 'flowdeck-medium', model: 'claude-opus-5-5', startedAt: NOW - 600_000, endedAt: NOW - 300_000, contextTokens: 0, contextMax: 1_000_000, tokens: 10, costUsd: 0.1, steps: 1, round: 1, status: 'done' as const }
    const runs: AgentRun[] = [{ ...base, id: 'a1', description: 'Wire it' }]
    const flow = { title: 'Old', total: 3, done: 2, running: 0, phase: 'close' as const, isFinished: true, isLinked: true, tasks: [t('Read code'), t('Wire it'), t('Polish')] }
    const named = { ...snapshot({ flow: { ...flow, accepted: [2, 3] }, agents: runs, project: '', startedAt: NOW - 700_000, endedAt: NOW - 200_000, status: 'finished' }), id: 'g1' }
    const older = { ...snapshot({ flow, agents: runs, project: '', startedAt: NOW - 900_000, endedAt: NOW - 800_000, status: 'finished' }), id: 'g2' }
    engine(on, { store: { historyShown: true, history: [named, older] } })
    await start($)
    await settle()
    await showTab($, 'archive')
    const p = await pane($, 'terminal')
    await p.press({ key: (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key)).filter((k: string) => /^archive-k[a-z0-9]+$/.test(k))[1] })
    await settle()
    await p.unmount()
    const txt = (await terminal($, ['archive'])).text
    const [first, second] = txt.split(/▼ /).slice(1)
    expect(first).toMatch(/✓ {3}3\. Polish/)
    expect(first).not.toMatch(/1\. Read code/)
    expect(second).toMatch(/✓ {3}1\. Read code/)
    expect(second).not.toMatch(/3\. Polish/)
  })

  test('the progress tool takes done as a count or a list of task numbers and says so', async ($, on) => {
    const { registered } = engine(on)
    await start($)
    const done = registered.find(r => r.name === 'progress').inputSchema.properties.done
    expect(done.anyOf.map((x: any) => x.type).sort()).toEqual(['array', 'integer'])
    expect(done.description).toMatch(/numbers/)
    expect(done.description).toMatch(/Accepted/)
  })
})
