import { describe, expect, test } from 'claude-code/testing'

import { snapshot } from '../hooks/archive'
import { STATE_COLOR } from '../hooks/plan-view'
import { cleanAfter, linkRuns, taskOf, unstarted } from '../hooks/tasks'
import type { AgentRun } from '../types'

const NOW = Date.UTC(2026, 9, 29, 11, 0)

const t = (title: string, after?: number[]) => ({ title, tier: 'medium', after: after ?? [] })
const run = (id: string, description: string, over: Partial<AgentRun> = {}) => ({ id, description, status: 'running' as const, ...over })

describe('task waits: cleaned, linked to runs, ready', () => {
  test('cleanAfter drops itself, unknown numbers, non-integers, repeats and a wait that closes a cycle', () => {
    const out = cleanAfter([t('a', [1, 2]), t('b', [1, 1, 0, -2, 1.5, 9]), t('c', [2, 3]), t('d', [3, 1])])
    expect(out.map(x => x.after)).toEqual([[2], [], [2], [3, 1]])
    // a forward wait that closes no cycle is kept
    expect(cleanAfter([t('a', [2]), t('b')]).map(x => x.after)).toEqual([[2], []])
    // a longer cycle: 1 → 2 → 3 → 1, the last link is dropped
    expect(cleanAfter([t('a', [2]), t('b', [3]), t('c', [1])]).map(x => x.after)).toEqual([[2], [3], []])
  })

  test('a run belongs to the task whose title is its description; taskOf numbers it from 1 with its waits', () => {
    const tasks = [t('Read code'), t('Wire it', [1])]
    const links = linkRuns(tasks, [run('w1', 'wire IT'), run('w2', 'something else')])
    expect(taskOf(tasks, links, run('w1', 'wire IT'))).toEqual({ n: 2, after: [1] })
    expect(taskOf(tasks, links, run('w2', 'something else'))).toBeNull()
  })

  test('ready: no waits, or every waited-for task has a complete run; Incomplete, failed or running runs do not count', () => {
    const tasks = [t('one'), t('two', [1]), t('three', [2]), t('four', [1, 2])]
    const ready = (runs: any[]) => unstarted(tasks, runs).map(p => `${p.n}${p.ready ? '+' : ''}`)
    expect(ready([])).toEqual(['1+', '2', '3', '4'])
    expect(ready([run('w1', 'one')])).toEqual(['2', '3', '4'])
    expect(ready([run('w1', 'one', { status: 'done', stepDone: 1, stepTotal: 6 })])).toEqual(['2', '3', '4'])
    expect(ready([run('w1', 'one', { status: 'failed' })])).toEqual(['2', '3', '4'])
    expect(ready([run('w1', 'one', { status: 'done' })])).toEqual(['2+', '3', '4'])
    expect(ready([run('w1', 'one', { status: 'done' }), run('w2', 'two', { status: 'done', stepDone: 3, stepTotal: 3 })])).toEqual(['3+', '4+'])
    // a task the session's task list completed counts as done
    expect(unstarted([{ ...t('one'), counted: true }, t('two', [1])], []).map(p => p.ready)).toEqual([true, true])
  })
})

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store: Record<string, unknown> = opts.store ?? {}
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
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  return { store, clock, registered }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const spawn = ($: any, id: string, description: string, type = 'flowdeck-medium') => $.agent.spawn({ subagentType: type, description, tool_use_id: id } as any)
const turnStep = async ($: any, agentId: string) => {
  for await (const _ of $.turn.step({ agentId, model: 'claude-opus-5-5', effort: 'medium', turnId: 't', index: 0, messageCount: 1 } as any));
}
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const terminal = async ($: any, cols = 80) => {
  const p = await pane($, 'terminal', cols)
  const texts = await p.findAll({ type: 'Text' })
  await p.unmount()
  return { texts, text: texts.map((x: any) => x.text).join('\n') }
}
const desktop = async ($: any, cols = 80) => {
  const p = await pane($, 'desktop', cols)
  const svgs = await p.findAll({ type: 'Svg' })
  const texts = await p.findAll({ type: 'Text' })
  await p.unmount()
  const source = (alt: RegExp) => String(svgs.find((s: any) => alt.test(String(s.props.alt)))?.props.source ?? '')
  return { source, names: texts.filter((x: any) => x.props.bold).map((x: any) => x.text) }
}
// The right-aligned stats of a drawn agent row.
const statsOf = (src: string) => /text-anchor="end"[^>]*>([^<]*)</.exec(src)?.[1] ?? ''
const metaOf = (src: string) => /<tspan class="s">([^<]*)<\/tspan>/.exec(src)?.[1] ?? ''

const PLAN = [
  { title: 'Read code', tier: 'light' },
  { title: 'Wire it', tier: 'medium', after: [1] },
  { title: 'Polish', tier: 'light', after: [1, 2] },
  { title: 'Docs', tier: 'light' },
]

describe('task numbers and waits on the rows', () => {
  test('the progress tool cleans the waits it is given (self, unknown, cycle)', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'A', tier: 'light', after: [1, 2] }, { title: 'B', tier: 'light', after: [1, 7] }, { title: 'C', tier: 'light', after: [3] }] })
    const text = (await terminal($)).text
    expect(text).toContain('1. A')
    expect(text).toMatch(/light · Opus · low · after 2\b/)
    expect(text).not.toMatch(/after 1, 7|after 7|after 3/)
  })

  test('a run that belongs to a task leads with its number and shows its waits after the effort; an unmatched run shows neither', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    await spawn($, 'w2', 'Wire it')
    await spawn($, 'w9', 'Side quest')
    await turnStep($, 'w2')
    await turnStep($, 'w9')
    const t = (await terminal($)).text
    expect(t).toMatch(/^2\. Wire it$/m)
    expect(t).toMatch(/medium · Opus 5\.5 · medium · after 1 · ctx/)
    expect(t).toMatch(/^Side quest$/m)
    expect(t).not.toMatch(/\d\. Side quest/)
    const d = await desktop($)
    expect(d.names).toContain('2. Wire it')
    expect(d.names).toContain('Side quest')
    expect(metaOf(d.source(/^Wire it:/))).toBe('  Opus 5.5 · medium  ·  after 1')
    expect(metaOf(d.source(/^Side quest:/))).toBe('  Opus 5.5 · medium')
  })

  test('the wait is dropped first on a short line: the stats stay as they would be without it', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Read code', tier: 'light' }, { title: 'Wire the history module', tier: 'medium', after: [1] }] })
    await spawn($, 'w2', 'Wire the history module')
    await spawn($, 'w9', 'Some other job')
    await turnStep($, 'w2')
    await turnStep($, 'w9')
    clock.now = NOW + 61_000
    let dropped = false
    for (const cols of [31, 40, 46, 60, 80, 120]) {
      const d = await desktop($, cols)
      const mine = d.source(/^Wire the history module:/)
      expect(statsOf(mine)).toBe(statsOf(d.source(/^Some other job:/)))
      if (!metaOf(mine).includes('after 1')) dropped = true
      expect(mine).not.toContain('NaN')
    }
    expect(dropped).toBe(true)
    expect(metaOf((await desktop($, 120)).source(/^Wire the history module:/))).toContain('after 1')
    for (let cols = 24; cols <= 80; cols += 4) {
      const lines = (await terminal($, cols)).text.split('\n')
      // a row's texts: its mark, its name, its glyph, then the model line
      const mine = lines[lines.indexOf('2. Wire the history module') + 2]!
      const other = lines[lines.indexOf('Some other job') + 2]!
      expect(mine).toMatch(/^ {2}medium · Opus 5\.5/)
      expect(mine.includes('ctx')).toBe(other.includes('ctx'))
      if (mine.includes('after 1')) expect(mine.endsWith(other.slice(other.indexOf('Opus 5.5 · medium') + 'Opus 5.5 · medium'.length))).toBe(true)
    }
  })

  test('planned rows: number, waits and a ready mark once all they wait for is done; independent tasks are ready', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    let d = await desktop($)
    expect(d.source(/^1\. Read code/)).toContain('>ready</tspan>')
    expect(d.source(/^4\. Docs/)).toContain('>ready</tspan>')
    expect(d.source(/^2\. Wire it/)).not.toContain('ready')
    expect(d.source(/^2\. Wire it/)).toContain('after 1')
    expect(d.source(/^1\. Read code/)).toContain(`fill="${STATE_COLOR.running}" font-weight="600">ready`)
    let t = await terminal($)
    expect(t.text).toMatch(/light · Opus · low · after 1, 2$/m)
    expect(t.texts.filter((x: any) => x.text === 'ready').length).toBe(2)
    // task 1 runs and ends complete: task 2 is ready now, task 3 still waits for 2
    await spawn($, 'w1', 'Read code', 'flowdeck-light')
    clock.now = NOW + 30_000
    await complete($, 'w1')
    d = await desktop($)
    expect(d.source(/^2\. Wire it/)).toContain('>ready</tspan>')
    expect(d.source(/^3\. Polish/)).not.toContain('ready')
    t = await terminal($)
    expect(t.text).toMatch(/^ {2}medium · Opus · medium · after 1 · ready$/m)
    expect(t.texts.filter((x: any) => x.text === 'ready').length).toBe(2)
  })

  test('a narrow planned row drops the wait before ready, within its width', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'A', tier: 'careful' }, { title: 'B', tier: 'careful' }, { title: 'C', tier: 'careful', after: [1, 2] }] })
    await spawn($, 'w1', 'A', 'flowdeck-careful')
    await spawn($, 'w2', 'B', 'flowdeck-careful')
    await complete($, 'w1')
    await complete($, 'w2')
    const wide = (await desktop($, 120)).source(/^3\. C/)
    expect(wide).toContain('after 1, 2')
    expect(wide).toContain('>ready</tspan>')
    const narrow = (await desktop($, 31)).source(/^3\. C/)
    expect(narrow).toContain('>ready</tspan>')
    expect(narrow).not.toContain('after 1, 2')
    const lines = (await terminal($, 40)).text.split('\n')
    expect(lines).toContain('  careful · Opus · high · ready')
    expect(lines.every(l => l.length <= 40 || !/careful · Opus/.test(l))).toBe(true)
    expect((await terminal($, 80)).text.split('\n')).toContain('  careful · Opus · high · after 1, 2 · ready')
  })

  test('an Archive group row shows the number and the waits of its saved task', async ($, on) => {
    const base = { type: 'flowdeck-medium', model: 'claude-opus-5-5', effort: 'medium', startedAt: NOW - 600_000, endedAt: NOW - 300_000, contextTokens: 0, contextMax: 1_000_000, tokens: 10, costUsd: 0.1, steps: 1, round: 1, status: 'done' as const }
    const runs: AgentRun[] = [{ ...base, id: 'a1', agentId: 'a1', description: 'Wire it' }, { ...base, id: 'a2', agentId: 'a2', description: 'Unplanned' }]
    const flow = { title: 'Old', total: 2, done: 2, running: 0, phase: 'close' as const, isFinished: true, isLinked: true, tasks: [{ title: 'Read code', tier: 'light', after: [] }, { title: 'Wire it', tier: 'medium', after: [1] }] }
    const entry = { ...snapshot({ flow, agents: runs, project: '', startedAt: NOW - 700_000, endedAt: NOW - 200_000, status: 'finished' }), id: 'g1' }
    engine(on, { store: { historyShown: true, history: [entry] } })
    await start($)
    await settle()
    const t = (await terminal($)).text
    expect(t).toMatch(/^2\. Wire it$/m)
    expect(t).toMatch(/medium · Opus 5\.5 · medium · after 1 · ctx/)
    expect(t).toMatch(/^Unplanned$/m)
    const d = await desktop($)
    expect(d.names).toContain('2. Wire it')
    expect(metaOf(d.source(/^Wire it:/))).toContain('after 1')
  })

  test('the progress tool tells the orchestrator to pass after and to launch every ready task in parallel', async ($, on) => {
    const { registered } = engine(on)
    await start($)
    const tool = registered.find(r => r.name === 'progress')
    const tasks = tool.inputSchema.properties.tasks
    expect(tasks.description).toMatch(/after/)
    expect(tasks.description).toMatch(/ready/)
    expect(tasks.description).toMatch(/parallel/)
    expect(tasks.items.properties.after.items.type).toBe('integer')
    expect(tool.inputSchema.properties.add.items.properties.after.items.type).toBe('integer')
  })
})
