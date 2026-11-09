import { describe, expect, test } from 'claude-code/testing'

import { keyOf, snapshot } from '../hooks/archive'
import { archivedPlanned } from '../hooks/archive-view'
import { listed, orchestrated } from '../hooks/orchestrator'
import type { AgentItem, AgentRun, ArchiveEntry, Flow, PlannedTask } from '../types'
import { showTab } from './tabs'

// An archived flow draws the orchestrator's own tasks as the live panel does: an Orchestrator row with its steps (their
// states and times), `Accepted · Orchestrator` once accepted, the task's notes behind ⓘ; in a group with or without runs.

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const NOW = Date.UTC(2026, 9, 26, 12, 40)
const END = NOW - HOUR // when the saved flow ended
const SURFACES = ['desktop', 'terminal'] as const

const item = (title: string, status: AgentItem['status'], from?: number, to?: number): AgentItem => ({
  title,
  status,
  ...(from === undefined ? {} : { startedAt: from }),
  ...(to === undefined ? {} : { doneAt: to }),
})
const task = (title: string, over: Partial<PlannedTask> = {}): PlannedTask => ({ title, tier: 'careful', after: [], ...over })

// Task 1 accepted with its steps and notes, task 2 a list that ended with a step in error (Incomplete) and was not
// accepted, task 3 a list with a step still open at the save, task 4 never started.
const ORCH_TASKS = (): PlannedTask[] => [
  task('Fetch history', {
    startedAt: END - 10 * MIN,
    items: [item('fetch candles', 'done', END - 10 * MIN, END - 9 * MIN), item('check units', 'done', END - 9 * MIN, END - 8 * MIN)],
    result: 'history saved',
    feedback: 'units checked',
  }),
  task('Run backtest', { startedAt: END - 6 * MIN, items: [item('run it', 'done', END - 6 * MIN, END - 5 * MIN), item('check output', 'error', END - 5 * MIN, END - 4 * MIN)] }),
  task('Tune settings', { startedAt: END - 3 * MIN, items: [item('sweep', 'done', END - 3 * MIN, END - 2 * MIN), item('pick best', 'active', END - 2 * MIN), item('save', 'pending')] }),
  task('Write report'),
]

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'w1',
  agentId: 'w1',
  type: 'flowdeck-careful',
  description: '#5 Wire the API',
  model: 'claude-opus-5-5',
  effort: 'high',
  status: 'done',
  startedAt: END - 30 * MIN,
  endedAt: END - 20 * MIN,
  contextTokens: 100_000,
  contextMax: 1_000_000,
  tokens: 12_000,
  costUsd: 0.5,
  steps: 3,
  round: 1,
  ...over,
})

const flow = (tasks: PlannedTask[], accepted: number[]): Flow => ({
  title: 'Backtest',
  total: tasks.length,
  done: accepted.length,
  running: 0,
  phase: 'close',
  isFinished: true,
  isLinked: true,
  tasks,
  accepted,
  acceptedAt: { '1': END - 7 * MIN },
})

// Saved without a day, as an earlier release saved them, so the Archive lists it whatever the date.
const saved = (tasks: PlannedTask[], accepted: number[], agents: AgentRun[] = []): ArchiveEntry => {
  const { day: _, ...e } = snapshot({ flow: flow(tasks, accepted), agents, project: '/work/app', startedAt: END - HOUR, endedAt: END, status: 'finished' })
  return e
}

function engine(on: any, history: ArchiveEntry[]) {
  const store: Record<string, unknown> = { historyShown: true, history }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))

async function look($: any, surface: 'terminal' | 'desktop', ...presses: string[]) {
  await showTab($, 'archive')
  const mount = () => $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  for (const key of presses) {
    const p = await mount()
    await p.press({ key })
    await settle()
    await p.unmount()
  }
  const p = await mount()
  const texts = (await p.findAll({ type: 'Text' })).map((x: any) => String(x.text))
  const svgs = await p.findAll({ type: 'Svg' })
  const keys = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))
  await p.unmount()
  const alts = svgs.map((s: any) => String(s.props.alt ?? ''))
  return { text: texts.join('\n'), alts, keys, source: (alt: RegExp) => String(svgs.find((s: any) => alt.test(String(s.props.alt)))?.props.source ?? '') }
}

// The keys of one group's rows: `archive-<keyOf(id)>-…`.
const kp = (e: ArchiveEntry) => `archive-${keyOf(e.id)}-`

describe('the planned tasks of a saved flow', () => {
  test('a task with a list is an Orchestrator row, as orchestrated draws it without the task the orchestrator was on', () => {
    const tasks = ORCH_TASKS()
    const rows = listed(tasks, [], [1])
    expect([...rows.keys()]).toEqual([2, 3])
    expect(rows.get(2)).toMatchObject({ state: 'done', startedAt: END - 6 * MIN, endedAt: END - 4 * MIN })
    expect(rows.get(3)).toMatchObject({ state: 'running', startedAt: END - 3 * MIN })
    expect(orchestrated(tasks, [], [1], 'close')).toEqual(rows)
  })

  test('without runs every task left is drawn (the others queued, never ready); with runs only the Orchestrator rows', () => {
    const tasks = ORCH_TASKS()
    const none = archivedPlanned(tasks, [], [1])
    expect(none.map(pl => [pl.n, pl.orch?.state ?? 'queued', pl.ready])).toEqual([
      [2, 'done', false],
      [3, 'running', false],
      [4, 'queued', false],
    ])
    const mixed = archivedPlanned([...tasks, task('Wire the API')], [run()], [1])
    expect(mixed.map(pl => pl.n)).toEqual([2, 3])
  })
})

describe('an archived flow with no worker runs', () => {
  test('Orchestrator rows with their state and time, Accepted · Orchestrator, and the queued task', async ($, on) => {
    const e = saved(ORCH_TASKS(), [1])
    engine(on, [e])
    await start($)
    await settle()
    const d = await look($, 'desktop')
    expect(d.alts).toContain('1. Fetch history: Accepted · Orchestrator')
    expect(d.alts).toContain('2. Run backtest: Orchestrator, Incomplete')
    expect(d.alts).toContain('3. Tune settings: Orchestrator, Running')
    expect(d.alts).toContain('4. Write report: planned')
    expect(d.source(/^2\. Run backtest: Orchestrator/)).toContain('>2:00</text>')
    // A step was open at the save: its clock stops at the save.
    expect(d.source(/^3\. Tune settings: Orchestrator/)).toContain('2/3 · pick best')
    expect(d.source(/^3\. Tune settings: Orchestrator/)).toContain('>3:00</text>')
    // Latest completion first: the one open at the save, the list that ended 4 minutes before, the task accepted 7
    // minutes before; the queued task last.
    const order = ['3. Tune settings:', '2. Run backtest:', '1. Fetch history:', '4. Write report:'].map(t => d.alts.findIndex(a => a.startsWith(t)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(i => i >= 0)).toBe(true)
    // No tiles: the group's summary line stays.
    expect(d.text).toContain('≈$0.00')
    const t = await look($, 'terminal')
    expect(t.text).toMatch(/careful · Accepted · Orchestrator/)
    expect(t.text).toMatch(/careful · Orchestrator · 2:00/)
    expect(t.text).toMatch(/careful · Orchestrator · 3:00/)
    expect(t.text).toMatch(/Running · 2\/3 pick best/)
    expect(t.text).toMatch(/4\. Write report ◷/)
    expect(t.text).not.toMatch(/ready/)
    expect(t.text).not.toMatch(/○ |\(careful\)/)
  })

  test('the steps fold out with their marks and times, on the accepted row too, and the notes open', async ($, on) => {
    const e = saved(ORCH_TASKS(), [1])
    engine(on, [e])
    await start($)
    await settle()
    const folds = [`${kp(e)}orch-fold-1`, `${kp(e)}orch-fold-2`, `${kp(e)}orch-fold-3`]
    const d = await look($, 'desktop', ...folds, `${kp(e)}note-task-1`)
    expect(d.alts).toContain('fetch candles: Done 1m 0s')
    expect(d.alts).toContain('check units: Done 1m 0s')
    expect(d.alts).toContain('run it: Done 1m 0s')
    expect(d.alts).toContain('check output: Error 1m 0s')
    expect(d.alts).toContain('sweep: Done 1m 0s')
    expect(d.alts).toContain('pick best: Running 2m 0s')
    expect(d.alts).toContain('save: Planned')
    expect(d.alts.join('\n')).toMatch(/history saved/)
    expect(d.alts.join('\n')).toMatch(/units checked/)
    for (const surface of SURFACES) {
      const v = await look($, surface)
      for (const k of folds) expect(v.keys).toContain(k)
    }
    const t = await look($, 'terminal')
    expect(t.text).toMatch(/✓ fetch candles {2}1m 0s/)
    expect(t.text).toMatch(/✗ check output {2}1m 0s/)
    expect(t.text).toMatch(/pick best {2}2m 0s/)
    expect(t.text).toMatch(/history saved/)
    expect(t.text).toMatch(/units checked/)
  })

  test('folding a group\'s Orchestrator row never opens the same task elsewhere', async ($, on) => {
    const a = saved(ORCH_TASKS(), [1])
    const b = { ...saved(ORCH_TASKS(), [1]), id: 'other', startedAt: END - 2 * HOUR, endedAt: END - HOUR }
    engine(on, [a, b])
    await start($)
    await settle()
    const v = await look($, 'desktop', `archive-${keyOf('other')}`, `${kp(a)}orch-fold-2`)
    expect(v.alts.filter(x => x === 'run it: Done 1m 0s')).toHaveLength(1)
  })
})

describe('an archived flow with worker runs and orchestrator tasks', () => {
  test('the worker rows and the Orchestrator rows in one list; a task never started stays out', async ($, on) => {
    const e = saved([...ORCH_TASKS(), task('Wire the API')], [1, 5], [run()])
    engine(on, [e])
    await start($)
    await settle()
    for (const surface of SURFACES) {
      const v = await look($, surface)
      const all = v.text + '\n' + v.alts.join('\n')
      expect(all).toMatch(/5\. Wire the API/)
      expect(all).toMatch(/Accepted · Orchestrator/)
      expect(all).not.toMatch(/Write report/)
    }
    const d = await look($, 'desktop')
    expect(d.alts).toContain('1. Fetch history: Accepted · Orchestrator')
    expect(d.alts).toContain('2. Run backtest: Orchestrator, Incomplete')
    expect(d.alts).toContain('3. Tune settings: Orchestrator, Running')
    expect(d.alts.some(a => a.startsWith('#5 Wire the API:'))).toBe(true)
    expect(d.alts.some(a => /: planned$/.test(a))).toBe(false)
    const t = await look($, 'terminal')
    expect(t.text).toMatch(/careful · Orchestrator · 2:00/)
  })

  test('a worker-only group is drawn as before: its runs, no Orchestrator or queued rows for its unstarted tasks', async ($, on) => {
    const e = saved([task('Wire the API'), task('Polish')], [], [run({ description: 'Wire the API' })])
    engine(on, [e])
    await start($)
    await settle()
    for (const surface of SURFACES) {
      const v = await look($, surface)
      const all = v.text + '\n' + v.alts.join('\n')
      expect(all).toMatch(/1\. Wire the API/)
      expect(all).not.toMatch(/Orchestrator|Polish|◷/)
    }
  })
})
