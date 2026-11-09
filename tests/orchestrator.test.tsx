import { describe, expect, mock, test } from 'claude-code/testing'

import { parseArchive, snapshot } from '../hooks/archive'
import { isOwnWork, orchestrated, ownTask, stepsOfTask, stepTask } from '../hooks/orchestrator'
import { STATE_COLOR } from '../hooks/plan-view'
import { asFlow } from '../hooks/shapes'
import type { AgentItem, Flow } from '../types'
import { sessions } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

// A planned task no worker run belongs to is the orchestrator's own: an Orchestrator row while it works on it, with its
// time and its own step list (the `step` tool called from the main session), `Accepted · Orchestrator` once accepted.

const SEC = 1000
const MIN = 60 * SEC
const NOW = new Date(2026, 10, 9, 10, 0).getTime() // 10:00 local: no date change within a test
const PROJECT = '/work/app'
const DIR = `${PROJECT}/.claude/flowdeck`
const LIVE = `${DIR}/flow-live.json`
const SURFACES = ['desktop', 'terminal'] as const

const task = (title: string, after: number[] = [], over: Record<string, unknown> = {}) => ({ title, tier: 'careful', after, ...over })
const item = (title: string, status: AgentItem['status'], over: Partial<AgentItem> = {}): AgentItem => ({ title, status, ...over })
const run = (id: string, description: string, status: 'running' | 'done' | 'failed' = 'done') => ({
  id,
  description,
  status,
  type: 'flowdeck-careful',
  startedAt: NOW - 10 * MIN,
  ...(status === 'running' ? {} : { endedAt: NOW - 5 * MIN }),
})

describe('which task an orchestrator step call goes to', () => {
  test('by default the task whose list has a step left, else the lowest ready task without a list, else the lowest ready one', () => {
    const open = [task('a'), task('b', [], { items: [item('x', 'done')] }), task('c', [], { items: [item('y', 'active')] }), task('d')]
    expect(stepTask(open, [], [])).toEqual({ i: 2 })
    expect(stepTask([task('a', [], { items: [item('x', 'done')] }), task('b')], [], [])).toEqual({ i: 1 })
    expect(stepTask([task('a', [], { items: [item('x', 'done')] })], [], [])).toEqual({ i: 0 })
  })

  test('the default passes over accepted tasks, tasks a worker run covers, completed ones and ones still waiting', () => {
    const tasks = [task('a'), task('b'), task('c', [2]), task('d', [], { counted: true }), task('e')]
    expect(stepTask(tasks, [run('r2', '#2 b', 'running')], [1])).toEqual({ i: 4 })
    expect(stepTask([task('a', [2]), task('b')], [run('r2', '#2 b', 'running')], [])).toEqual({ error: 'no open task without a worker run is ready; name the task with task' })
  })

  test('task names any task no worker run covers, an accepted one too; a worker\'s task and a missing number are refused', () => {
    const tasks = [task('a'), task('b'), task('c')]
    const runs = [run('r2', '#2 b', 'running')]
    expect(stepTask(tasks, runs, [1], 1)).toEqual({ i: 0 })
    expect(stepTask(tasks, runs, [], 3)).toEqual({ i: 2 })
    expect(stepTask(tasks, runs, [], 2)).toEqual({ error: 'task 2 has a worker run; its worker reports its own steps' })
    expect(stepTask(tasks, runs, [], 9)).toEqual({ error: 'the flow has no task 9' })
    expect(stepTask(tasks, runs, [], 'x')).toEqual({ error: 'the flow has no task "x"' })
    expect(stepTask(tasks, runs, [], null)).toEqual({ i: 0 })
  })
})

describe('the task the orchestrator is on without a list', () => {
  test('the lowest ready open task, in the delegate and review phases only', () => {
    const tasks = [task('a', [2]), task('b'), task('c')]
    expect(ownTask(tasks, [], [], 'delegate')).toBe(1)
    expect(ownTask(tasks, [], [], 'review')).toBe(1)
    for (const phase of ['plan', 'design', 'close'] as const) expect(ownTask(tasks, [], [], phase)).toBeNull()
  })

  test('none while a run is live or a worker result waits for review; the next one once that task is accepted', () => {
    const tasks = [task('a'), task('b')]
    expect(ownTask(tasks, [run('r1', '#1 a', 'running')], [], 'delegate')).toBeNull()
    expect(ownTask(tasks, [run('r1', '#1 a')], [], 'review')).toBeNull()
    expect(ownTask(tasks, [run('r1', '#1 a')], [1], 'delegate')).toBe(1)
  })

  test('none while one of its lists has a step left; a task with a list or completed in the task list is passed over', () => {
    expect(ownTask([task('a', [], { items: [item('s', 'active')] }), task('b')], [], [], 'delegate')).toBeNull()
    expect(ownTask([task('a', [], { items: [item('s', 'done')] }), task('b', [], { counted: true }), task('c')], [], [], 'delegate')).toBe(2)
  })

  test('own work is an edit or a shell, not a worker launch, the session task list or a look', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'TaskOutput']) expect(isOwnWork(tool)).toBe(true)
    for (const tool of ['Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'Read', 'Grep', 'mcp__flowdeck__step', 'mcp__flowdeck__progress']) expect(isOwnWork(tool)).toBe(false)
  })
})

describe('the Orchestrator rows of a flow', () => {
  test('a list runs while a step is left and is done once every step ended, with when it started and ended', () => {
    const tasks = [
      task('a', [], { startedAt: NOW - 3 * MIN, items: [item('one', 'done', { startedAt: NOW - 3 * MIN, doneAt: NOW - 2 * MIN }), item('two', 'active', { startedAt: NOW - 2 * MIN })] }),
      task('b', [], { items: [item('one', 'done', { startedAt: NOW - 4 * MIN, doneAt: NOW - MIN }), item('two', 'error', { doneAt: NOW })] }),
    ]
    const rows = orchestrated(tasks, [], [], 'delegate')
    expect(rows.get(1)).toMatchObject({ state: 'running', startedAt: NOW - 3 * MIN })
    expect(rows.get(1)?.endedAt).toBeUndefined()
    expect(rows.get(2)).toMatchObject({ state: 'done', startedAt: NOW - 4 * MIN, endedAt: NOW })
  })

  test('the task the orchestrator is on runs once its start is dated; a task a worker run covers never has a row', () => {
    expect(orchestrated([task('a'), task('b')], [], [], 'delegate').size).toBe(0)
    expect(orchestrated([task('a', [], { startedAt: NOW }), task('b')], [], [], 'delegate').get(1)).toEqual({ state: 'running', items: [], startedAt: NOW })
    expect(orchestrated([task('a', [], { startedAt: NOW })], [], [], 'plan').size).toBe(0)
    expect(orchestrated([task('a', [], { startedAt: NOW, items: [item('s', 'active')] })], [run('r1', '#1 a', 'running')], [], 'delegate').size).toBe(0)
    expect(orchestrated([task('a', [], { startedAt: NOW, items: [item('s', 'active')] })], [], [1], 'delegate').size).toBe(0) // accepted: Finished
  })
})

describe('the list is saved with the flow', () => {
  test('stepsOfTask keeps the cleaned list and a numeric start, nothing else', () => {
    expect(stepsOfTask({ items: [item('a', 'done'), null, { title: '' }, 'x'], startedAt: NOW })).toEqual({ items: [item('a', 'done')], startedAt: NOW })
    expect(stepsOfTask({ startedAt: NOW })).toEqual({ startedAt: NOW })
    expect(stepsOfTask({ items: 'x', startedAt: 'y' })).toEqual({})
    expect(stepsOfTask(null)).toEqual({})
    expect(stepsOfTask({ items: Array.from({ length: 20 }, (_, i) => item(`s${i}`, 'pending')) }).items?.length).toBe(12)
  })

  test('flow-live.json and the archive keep the list and its start: asFlow, snapshot and parseArchive', () => {
    const items = [item('one', 'done', { startedAt: NOW - MIN, doneAt: NOW }), item('two', 'active', { startedAt: NOW })]
    const flow: Flow = { title: 'f', total: 2, done: 1, running: 0, phase: 'close', isFinished: true, isLinked: true, tasks: [task('a', [], { items, startedAt: NOW - MIN }), task('b')], accepted: [1] }
    const held = asFlow(JSON.parse(JSON.stringify(flow)))
    expect(held?.tasks[0]).toMatchObject({ items, startedAt: NOW - MIN })
    expect(held?.tasks[1]?.items).toBeUndefined()
    const e = snapshot({ flow, agents: [], project: PROJECT, startedAt: NOW - 2 * MIN, endedAt: NOW, status: 'finished' })
    const back = parseArchive(JSON.parse(JSON.stringify([e])))[0]
    expect(back?.tasks[0]).toMatchObject({ items, startedAt: NOW - MIN })
    expect(back?.tasks[1]?.items).toBeUndefined()
  })
})

function engine(on: any, opts: { files?: Record<string, string> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const fs = fakeFs(on, { files: opts.files })
  const store: Record<string, unknown> = {}
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('classic.SessionStart', () => ({}))
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
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
  return { clock, files: fs.files }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
// A step call from the main session (no agentId), or from a worker.
const step = async ($: any, input: Record<string, unknown>, agentId?: string) =>
  String((await $.tool.call({ tool: 'mcp__flowdeck__step', ...(agentId ? { agentId } : {}), ...input } as any)).result)
const shell = ($: any) => $.tool.call({ tool: 'Bash', command: 'python backtest.py' } as any)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-careful', description, tool_use_id: id } as any)
const PLAN = [task('Fetch history'), task('Run backtest', [1]), task('Write report', [2])]
const plan = ($: any) => progress($, { title: 'Backtest', phase: 'delegate', tasks: PLAN })

async function look($: any, tab: Tab, surface: 'terminal' | 'desktop', press?: string) {
  await showTab($, tab)
  const mount = () => $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  if (press) {
    const p = await mount()
    await p.press({ key: press })
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
const bandSays = async ($: any): Promise<string> => {
  const b = await $.ui.mount({ plugin: 'flowdeck', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } } as any)
  const alts = (await b.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt ?? ''))
  await b.unmount()
  return alts.find((a: string) => /: .*%$/.test(a)) ?? ''
}

describe('an Orchestrator row for a task no worker runs', () => {
  test('a planned task stays queued until the orchestrator works on it, then runs as Orchestrator with its live time', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    const queued = await look($, 'active', 'desktop')
    expect(queued.alts).toContain('1. Fetch history: planned')
    expect(queued.text).not.toMatch(/Orchestrator/)
    await shell($) // the orchestrator's own work call dates the task's start
    await clock.set(NOW + 2 * MIN + 5 * SEC) // the 5 s tick moves the row's clock on
    const d = await look($, 'active', 'desktop')
    const row = d.source(/^1\. Fetch history: Orchestrator, Running$/)
    expect(row).toContain('Orchestrator')
    expect(row).toContain('>2:05</text>')
    expect(row).toContain(`fill="${STATE_COLOR.running}">Running</tspan>`)
    expect(row).toContain(' run"') // the sprite walks
    expect(d.keys).toContain('orch-fold-1')
    expect(d.alts).toContain('2. Run backtest: planned')
    const t = await look($, 'active', 'terminal')
    expect(t.text).toMatch(/1\. Fetch history/)
    expect(t.text).toMatch(/careful · Orchestrator · 2:05/)
    expect(t.text).toMatch(/Running/)
    expect(await bandSays($)).toMatch(/^Fetch history: /)
    // Opened with no list: when it started, then that no steps came.
    const open = await look($, 'active', 'terminal', 'orch-fold-1')
    expect(open.text).toMatch(/Orchestrator · started 10:00/)
    expect(open.text).toMatch(/No steps reported yet/)
  })

  test('no row while the plan waits for the user, or while a worker runs; a worker launch dates nothing', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    await $.tool.call({ tool: 'Agent', subagent_type: 'flowdeck-careful', description: '#1 Fetch history', prompt: 'p' } as any)
    await spawn($, 'w1', '#1 Fetch history')
    await shell($) // a worker runs: the orchestrator is not on a task of its own
    for (const surface of SURFACES) {
      const v = await look($, 'active', surface)
      expect(v.text + v.alts.join('\n')).not.toMatch(/Orchestrator/)
    }
  })

  test('its own step list: the default task, live steps folded out, then Accepted · Orchestrator with the steps kept', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    expect(await step($, { steps: [{ title: 'fetch candles' }, { title: 'check units' }, { title: 'save history' }] })).toBe('ok: task 1')
    await clock.set(NOW + MIN)
    expect(await step($, { next: true })).toBe('ok: task 1')
    await clock.set(NOW + MIN + 30 * SEC)
    const d = await look($, 'active', 'desktop', 'orch-fold-1')
    const row = d.source(/^1\. Fetch history: Orchestrator, Running$/)
    expect(row).toContain('2/3 · check units')
    expect(row).toContain('>1:30</text>')
    expect(d.alts).toContain('fetch candles: Done 1m 0s')
    expect(d.alts).toContain('check units: Running 30s')
    expect(d.alts).toContain('save history: Planned')
    const t = await look($, 'active', 'terminal')
    expect(t.text).toMatch(/Running · 2\/3 check units/)
    expect(t.text).toMatch(/✓ fetch candles {2}1m 0s/)
    expect(await step($, { done: ['check units', 'save history'] })).toBe('ok: task 1')
    const done = await look($, 'active', 'desktop')
    expect(done.alts).toContain('1. Fetch history: Orchestrator, Done')
    await progress($, { done: [1], notes: [{ task: 1, result: 'history saved', feedback: 'units checked' }] })
    for (const surface of SURFACES) {
      const f = await look($, 'finished', surface)
      expect(f.keys).toContain('orch-fold-1') // still unfolded: the same fold state as while it ran
      expect(f.text + f.alts.join('\n')).toMatch(/Accepted · Orchestrator/)
      expect(f.text + f.alts.join('\n')).toMatch(/fetch candles/)
      expect(f.text + f.alts.join('\n')).not.toMatch(/no worker run/)
    }
    expect((await look($, 'finished', 'desktop')).alts).toContain('1. Fetch history: Accepted · Orchestrator')
    // The next ready task is the default now.
    expect(await step($, { steps: [{ title: 'run it' }] })).toBe('ok: task 2')
  })

  test('task names the task; a worker\'s task is refused; a worker\'s own call keeps to its row', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Backtest', phase: 'delegate', tasks: [task('Fetch history'), task('Tune settings'), task('Write report')] })
    await spawn($, 'w1', '#1 Fetch history')
    expect(await step($, { task: 1, steps: [{ title: 'x' }] })).toBe('ignored: task 1 has a worker run; its worker reports its own steps')
    expect(await step($, { task: 3, steps: [{ title: 'draft' }, { title: 'review' }] })).toBe('ok: task 3')
    expect(await step($, { next: true })).toBe('ok: task 3') // the default follows the open list
    expect(await step($, { task: 2, steps: [{ title: 'worker step' }] }, 'w1')).toBe('ok')
    const d = await look($, 'active', 'desktop')
    expect(d.alts).toContain('3. Write report: Orchestrator, Running')
    expect(d.source(/^3\. Write report: Orchestrator/)).toContain('2/2 · review')
    expect(d.alts).toContain('2. Tune settings: planned')
    expect(d.source(/^#1 Fetch history:/)).toContain('1/1 · worker step')
    expect(await bandSays($)).toMatch(/^Fetch history \+1: /) // the worker's task and the Orchestrator row both run
  })

  test('a count without a list, or a call with no planned task, is ignored with the reason', async ($, on) => {
    engine(on)
    await start($)
    expect(await step($, { steps: [{ title: 'x' }] })).toBe('ignored: no open flow with planned tasks; plan it with mcp__flowdeck__progress first')
    await plan($)
    expect(await step($, { done: 1, total: 3 })).toBe('ignored: report your own steps as a list (steps), then next: true as each one finishes')
    expect(await step($, { task: 7, steps: [{ title: 'x' }] })).toBe('ignored: the flow has no task 7')
    expect(await step($, { steps: [{ title: 'one' }] })).toBe('ok: task 1')
    expect(await step($, { done: ['nope'] })).toBe('ok: task 1 (unknown step "nope" ignored)')
  })
})

describe('the orchestrator\'s list across a restart', () => {
  test('it is written to flow-live.json with the flow', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await plan($)
    await step($, { steps: [{ title: 'fetch candles' }, { title: 'check units' }] })
    await settle()
    const t0 = JSON.parse(files[LIVE]!).sessions.s.flow.tasks[0]
    expect(t0.startedAt).toBe(NOW)
    expect(t0.items.map((x: AgentItem) => `${x.title}:${x.status}`)).toEqual(['fetch candles:active', 'check units:pending'])
  })

  test('the same session started again gets its Orchestrator row back, steps and all', async ($, on) => {
    const flow = {
      title: 'Backtest',
      total: 2,
      done: 0,
      running: 0,
      phase: 'delegate',
      isFinished: false,
      isLinked: true,
      tasks: [task('Fetch history', [], { startedAt: NOW - 2 * MIN, items: [item('fetch candles', 'done', { startedAt: NOW - 2 * MIN, doneAt: NOW - MIN }), item('check units', 'active', { startedAt: NOW - MIN })] }), task('Run backtest', [1])],
    }
    const rec = { sessionId: 's', flow, agents: [], meta: { startedAt: NOW - 3 * MIN, project: PROJECT }, lastActivityAt: NOW - MIN, beatAt: NOW - MIN }
    engine(on, { files: { [LIVE]: JSON.stringify({ version: 1, sessions: { s: rec } }) } })
    await start($)
    await settle()
    const d = await look($, 'active', 'desktop')
    expect(d.source(/^1\. Fetch history: Orchestrator, Running$/)).toContain('2/2 · check units')
    expect(d.alts).toContain('2. Run backtest: planned')
  })

  test('the archived session keeps an accepted task\'s list and its start', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await progress($, { title: 'Backtest', phase: 'delegate', tasks: [task('Fetch history')] })
    await step($, { steps: [{ title: 'fetch candles' }, { title: 'check units' }] })
    await step($, { done: ['fetch candles', 'check units'] })
    await progress($, { done: [1], finished: true })
    await settle()
    const saved = sessions(files, DIR)
    expect(saved).toHaveLength(1)
    expect(saved[0].tasks[0].items.map((x: AgentItem) => x.status)).toEqual(['done', 'done'])
    expect(saved[0].tasks[0].startedAt).toBe(NOW)
  })
})
