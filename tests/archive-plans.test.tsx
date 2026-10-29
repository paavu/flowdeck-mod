import { describe, expect, test } from 'claude-code/testing'

import { addEntry, groupLine, isWorthKeeping, keyOf, parseArchive, planEntry, rotate, snapshot } from '../hooks/archive'
import type { AgentRun, ArchiveEntry, Flow, TaskPlan } from '../types'
import { fakeFs } from './fake-fs'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 26, 12, 40)
const PROJECT = '/work/app'

const donePlan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
  id: 'beta',
  title: 'Beta cleanup',
  kind: 'plan',
  stages: [
    { name: 'Build', steps: [{ title: 'write tests', status: 'done', substeps: [], doneAt: NOW - 20 * MIN }, { title: 'wire tool', status: 'done', substeps: [{ title: 'hook', status: 'done' }], doneAt: NOW - 10 * MIN }] },
    { name: 'Ship', steps: [{ title: 'commit', status: 'skipped', substeps: [] }] },
  ],
  state: 'done',
  note: 'shipped',
  startedAt: NOW - HOUR,
  endedAt: NOW,
  ...over,
})

const flowEntry = (i: number, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  id: `e${i}`,
  project: PROJECT,
  title: `Flow ${i}`,
  startedAt: NOW - i * DAY - HOUR,
  endedAt: NOW - i * DAY,
  status: 'finished',
  done: 1,
  total: 2,
  tasks: [{ title: 'write tests', tier: 'careful' }],
  cost: 1.5,
  tokens: 12_000,
  time: 30 * MIN,
  ...over,
})

// --- pure

describe('plan entries, pure', () => {
  test('planEntry: its own id, the plan’s title and times, finished, done and total steps, no tasks, runs or cost', () => {
    const e = planEntry(donePlan(), PROJECT, NOW + MIN)
    expect(e).toEqual({
      id: `plan-beta-${NOW - HOUR}-${PROJECT}`,
      project: PROJECT,
      title: 'Beta cleanup',
      startedAt: NOW - HOUR,
      endedAt: NOW,
      status: 'finished',
      done: 3,
      total: 3,
      tasks: [],
      cost: 0,
      tokens: 0,
      time: HOUR,
      plan: donePlan(),
    })
    expect(e.agents).toBeUndefined()
    expect(keyOf(e.id)).toMatch(/^k[a-z0-9]+$/)
    // without an end the save time is used, in the entry and its plan
    const open = planEntry(donePlan({ endedAt: null }), PROJECT, NOW + MIN)
    expect(open.endedAt).toBe(NOW + MIN)
    expect(open.plan!.endedAt).toBe(NOW + MIN)
    expect(open.time).toBe(HOUR + MIN)
    // an end before the start never makes a negative time
    expect(planEntry(donePlan({ endedAt: NOW - 2 * HOUR }), PROJECT, NOW).time).toBe(0)
  })

  test('isWorthKeeping takes a plan with a step, not one without', () => {
    expect(isWorthKeeping(planEntry(donePlan(), PROJECT, NOW))).toBe(true)
    const pending = donePlan({ stages: [{ name: 'S', steps: [{ title: 'a', status: 'pending', substeps: [] }] }], startedAt: NOW, endedAt: NOW })
    expect(isWorthKeeping(planEntry(pending, PROJECT, NOW))).toBe(true)
    expect(isWorthKeeping(planEntry(donePlan({ stages: [] }), PROJECT, NOW))).toBe(false)
  })

  test('parseArchive keeps a plan entry as written and caps it: 100 steps, 200 characters a string', () => {
    const e = planEntry(donePlan(), PROJECT, NOW)
    expect(parseArchive(JSON.parse(JSON.stringify([e])))).toEqual([e])
    const long = 'x'.repeat(500)
    const big = donePlan({
      title: long,
      note: long,
      stages: [{ name: long, steps: Array.from({ length: 150 }, (_, i) => ({ title: `${i} ${long}`, status: 'done' as const, substeps: [{ title: long, status: 'done' as const }] })) }],
    })
    const capped = planEntry(big, PROJECT, NOW)
    const steps = capped.plan!.stages.flatMap(s => s.steps)
    expect(steps).toHaveLength(100)
    expect(capped.total).toBe(100)
    expect(capped.title).toHaveLength(200)
    expect(capped.plan!.title).toHaveLength(200)
    expect(capped.plan!.note).toHaveLength(200)
    expect(capped.plan!.stages[0]!.name).toHaveLength(200)
    for (const st of steps) expect(st.title.length).toBeLessThanOrEqual(200)
    expect(parseArchive(JSON.parse(JSON.stringify([capped])))).toEqual([capped])
  })

  test('parseArchive drops a garbage plan field, keeps the entry and its other data; broken stages and steps go', () => {
    const e = planEntry(donePlan(), PROJECT, NOW)
    const { plan: _plan, ...rest } = e
    for (const junk of [7, 'plan', null, [], { id: 3 }, { id: 'p', stages: 'none', startedAt: 1 }, { id: 'p', title: 't', stages: [{ name: 'S', steps: [{ title: 1, status: 'done' }] }], startedAt: 1, state: 'done', kind: 'plan', note: null }]) {
      const [got] = parseArchive([{ ...JSON.parse(JSON.stringify(e)), plan: junk }])
      expect(got).toBeDefined()
      expect(got!.plan).toBeUndefined()
      expect(got).toEqual(rest as ArchiveEntry)
    }
    const raw = JSON.parse(JSON.stringify(e))
    raw.plan.stages.push(null, { name: 7, steps: [] }, { name: 'Empty', steps: [] }, { name: 'Bad', steps: [{ title: 'x', status: 'weird' }] })
    raw.plan.stages[0].steps.push({ title: 'odd', status: 'nope' }, 5)
    raw.plan.stages[0].steps[1].substeps.push({ title: 9, status: 'done' })
    const [got] = parseArchive([raw])
    expect(got!.plan).toEqual(e.plan)
  })

  test('groupLine for a plan: the date then N steps (1 step), narrowing like a flow’s', () => {
    const e = planEntry(donePlan({ startedAt: Date.UTC(2026, 9, 26, 9, 0), endedAt: Date.UTC(2026, 9, 26, 10, 42) }), PROJECT, NOW)
    expect(groupLine(e, 40, 'UTC')).toBe('Oct 26, 2026 · 10:42 · 3 steps')
    expect(groupLine(e, 24, 'UTC')).toBe('Oct 26, 2026 · 3 steps')
    expect(groupLine(e, 20, 'UTC')).toBe('Oct 26, 2026 · 3')
    expect(groupLine(e, 5, 'UTC')).toBe('Oct 26, 2026 · 3')
    const one = planEntry(donePlan({ stages: [{ name: 'S', steps: [{ title: 'a', status: 'done', substeps: [] }] }], startedAt: Date.UTC(2026, 9, 26, 9, 0), endedAt: Date.UTC(2026, 9, 26, 10, 42) }), PROJECT, NOW)
    expect(groupLine(one, 40, 'UTC')).toBe('Oct 26, 2026 · 10:42 · 1 step')
    expect(groupLine(one, 24, 'UTC')).toBe('Oct 26, 2026 · 1 step')
    // a flow entry is as before
    expect(groupLine(flowEntry(1, { endedAt: Date.UTC(2026, 9, 26, 10, 42), startedAt: Date.UTC(2026, 9, 26, 9, 0) }), 40, 'UTC')).toBe('Oct 26, 2026 · 10:42 · 1 item')
  })

  test('addEntry puts a plan where it belongs by its end; a flow still goes first; a second save replaces the first', () => {
    const newer = flowEntry(0, { id: 'newer', endedAt: NOW + HOUR })
    const older = flowEntry(1)
    const e = planEntry(donePlan(), PROJECT, NOW)
    const list = addEntry([newer, older], e)
    expect(list.map(x => x.id)).toEqual(['newer', e.id, 'e1'])
    expect(addEntry(list, e).map(x => x.id)).toEqual(['newer', e.id, 'e1'])
    const again = planEntry(donePlan({ endedAt: NOW + 2 * HOUR }), PROJECT, NOW)
    expect(addEntry(list, again).map(x => x.id)).toEqual([e.id, 'newer', 'e1'])
    expect(addEntry(list, again).filter(x => x.id === e.id)[0]!.endedAt).toBe(NOW + 2 * HOUR)
    expect(addEntry(list, flowEntry(5, { id: 'flow' })).map(x => x.id)[0]).toBe('flow')
  })

  test('rotation moves plan entries into volumes like any entry, intact', () => {
    const plans = Array.from({ length: 12 }, (_, i) => planEntry(donePlan({ id: `p${i}`, startedAt: NOW - (i + 1) * DAY, endedAt: NOW - (i + 1) * DAY + HOUR }), PROJECT, NOW))
    const { kept, volumes } = rotate(plans, 3000)
    expect(volumes.length).toBeGreaterThan(0)
    expect([...kept, ...[...volumes].reverse().flat()]).toEqual(plans)
  })
})

// --- in the panel (no fs hook: the shared-store fallback)

type Opts = { store?: Record<string, unknown>; failHistory?: boolean; tool?: (e: any) => unknown }

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    if (opts.failHistory && e.key === 'history') throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', (_$: any, e: any) => (opts.tool ? opts.tool(e) : { result: 'ok' }))
  return { store, clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const plan = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__plan', ...input } as any)).result)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const endTurn = ($: any) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
const saved = (store: Record<string, unknown>): any[] => ((store.plans as any)?.s ?? []) as any[]
const history = (store: Record<string, unknown>): ArchiveEntry[] => (store.history ?? []) as ArchiveEntry[]
const planEntries = (store: Record<string, unknown>) => history(store).filter(e => e.plan)

const STAGES = [
  { name: 'Build', steps: [{ title: 'write tests' }, { title: 'wire tool' }] },
  { name: 'Ship', steps: [{ title: 'commit' }] },
]
const create = ($: any, id = 'beta', title = 'Beta cleanup') => plan($, { id, title, stages: STAGES })
const finish = ($: any, id = 'beta') => plan($, { id, done: ['write tests', 'wire tool', 'commit'] })
const HEAD = /^Beta cleanup {2}Done$/

const terminal = async ($: any, bodyColumns = 80) => {
  const p = await pane($, 'terminal', bodyColumns)
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  const keys = buttons.map((b: any) => String(b.props.key))
  return {
    text: texts.map((t: any) => t.text).join('\n'),
    texts: texts.map((t: any) => String(t.text)),
    buttons,
    keys,
    group: (id: string) => buttons.find((b: any) => String(b.props.key) === `archive-${keyOf(id)}`),
    groups: keys.filter((k: string) => /^archive-k[a-z0-9]+$/.test(k)),
  }
}
const desktop = async ($: any) => {
  const p = await pane($, 'desktop')
  const svgs = await p.findAll({ type: 'Svg' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { svgs, alts: svgs.map((s: any) => String(s.props.alt ?? '')), keys: buttons.map((b: any) => String(b.props.key)) }
}
const press = async ($: any, key: string) => {
  const p = await pane($, 'terminal')
  await p.press({ key })
  await settle()
  await p.unmount()
}

describe('finished plans in the Archive', () => {
  test('a plan finished by the tool op is archived once, as its own group: the fold line counts steps, open it draws the plan with Done', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($)
    expect(planEntries(store)).toHaveLength(0)
    await finish($)
    const list = planEntries(store)
    expect(list).toHaveLength(1)
    const e = list[0]!
    expect(e.id).toBe(`plan-beta-${NOW}-${PROJECT}`)
    expect(e.title).toBe('Beta cleanup')
    expect(e.status).toBe('finished')
    expect([e.done, e.total, e.tasks.length, e.cost, e.tokens]).toEqual([3, 3, 0, 0, 0])
    expect(e.plan!.state).toBe('done')
    expect(e.plan!.stages.flatMap(s => s.steps.map(st => st.status))).toEqual(['done', 'done', 'done'])
    const t = await terminal($)
    expect(t.group(e.id).text).toMatch(/^▾ [A-Z][a-z]{2} \d{1,2}, \d{4} · \d{2}:\d{2} · 3 steps$/)
    expect(t.group(e.id).text).not.toMatch(/Beta/)
    // the Plans section and the Archive group each draw it
    expect(t.texts.filter(x => HEAD.test(x))).toHaveLength(2)
    expect(t.texts.filter(x => /100%$/.test(x))).toHaveLength(2)
    // no tiles for a plan group
    expect(t.text).not.toMatch(/≈\$0\.00/)
    const d = await desktop($)
    expect(d.alts.filter(a => a === 'Beta cleanup: Done, 100%')).toHaveLength(2)
  })

  test('the auto-close at the end of the main turn archives the plan', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($)
    await plan($, { id: 'beta', done: ['write tests', 'wire tool', 'commit'], state: 'running' })
    expect(planEntries(store)).toHaveLength(0)
    await endTurn($)
    expect(saved(store)[0].state).toBe('done')
    expect(planEntries(store)).toHaveLength(1)
    expect(planEntries(store)[0]!.plan!.state).toBe('done')
  })

  test('a plan-mode plan is archived when it finishes, by the tool op or the auto-close', async ($, on) => {
    const MD = ['# Hook work', '', '## Build', '- [x] read code', '- write tests', '', '## Ship', '1. commit'].join('\n')
    const ALL = ['# All done', '', '- [x] one', '- [x] two'].join('\n')
    let md = MD
    const { store, clock } = engine(on, { tool: e => (e.tool === 'ExitPlanMode' ? { result: { plan: md, isAgent: false } } : { result: 'ok' }) })
    await start($)
    await $.tool.call({ tool: 'ExitPlanMode' } as any)
    expect(saved(store)[0].id).toBe('plan')
    expect(planEntries(store)).toHaveLength(0)
    await plan($, { id: 'plan', done: ['write tests', 'commit'] })
    expect(planEntries(store).map(e => e.title)).toEqual(['Hook work'])
    // a new plan-mode plan with every step checked closes at the end of the turn and is archived as a new snapshot
    clock.now += HOUR
    md = ALL
    await $.tool.call({ tool: 'ExitPlanMode' } as any)
    await endTurn($)
    const titles = planEntries(store).map(e => e.title)
    expect(titles).toContain('All done')
  })

  test('saving twice keeps one entry; a plan reopened and finished again upserts a newer snapshot', async ($, on) => {
    const { store, clock } = engine(on)
    await start($)
    await create($)
    await finish($)
    await plan($, { id: 'beta', note: 'checked' })
    await endTurn($)
    expect(planEntries(store)).toHaveLength(1)
    const first = planEntries(store)[0]!
    clock.now += 10 * MIN
    await plan($, { id: 'beta', active: 'commit' })
    expect(saved(store)[0].state).toBe('running')
    expect(planEntries(store)).toHaveLength(1)
    clock.now += 10 * MIN
    await plan($, { id: 'beta', done: ['commit'] })
    const list = planEntries(store)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(first.id)
    expect(list[0]!.endedAt).toBe(NOW + 20 * MIN)
    await press($, 'plans-clear')
    expect(planEntries(store)).toHaveLength(1)
  })

  test('a plan that never finishes is not archived', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($)
    await plan($, { id: 'beta', next: true })
    await endTurn($)
    await plan($, { id: 'beta', failed: 'wire tool' })
    await endTurn($)
    expect(planEntries(store)).toHaveLength(0)
    const t = await terminal($)
    expect(t.groups).toEqual([])
  })

  test('Clear finished removes the plan from the Plans section only; the Archive still shows it', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($)
    await create($, 'alpha', 'Alpha rollout')
    await finish($)
    await press($, 'plans-clear')
    expect(saved(store).map(x => x.id)).toEqual(['alpha'])
    expect(planEntries(store)).toHaveLength(1)
    const t = await terminal($)
    expect(t.keys).not.toContain('plans-clear')
    expect(t.texts.filter(x => HEAD.test(x))).toHaveLength(1)
    expect(t.group(planEntries(store)[0]!.id)).toBeDefined()
    // folded, the group keeps its fold line only
    await press($, `archive-${keyOf(planEntries(store)[0]!.id)}`)
    const folded = await terminal($)
    expect(folded.group(planEntries(store)[0]!.id).text).toMatch(/^▸ .* · 3 steps$/)
    expect(folded.texts.filter(x => HEAD.test(x))).toHaveLength(0)
  })

  test('a failing archive save keeps the plan in the Plans list, Clear finished too, and nothing throws', async ($, on) => {
    const { store } = engine(on, { failHistory: true })
    await start($)
    await create($)
    expect(await finish($)).toMatch(/^beta: 3\/3, done/)
    expect(store.history).toBeUndefined()
    await press($, 'plans-clear')
    expect(saved(store).map(x => x.id)).toEqual(['beta'])
    const t = await terminal($)
    expect(t.keys).toContain('plans-clear')
    expect(t.texts.filter(x => HEAD.test(x)).length).toBeGreaterThanOrEqual(1)
  })

  test('Clear finished archives a done plan not archived yet before removing it', async ($, on) => {
    const opts: Opts = { failHistory: true }
    const { store } = engine(on, opts)
    await start($)
    await create($)
    await finish($)
    expect(store.history).toBeUndefined()
    opts.failHistory = false
    await press($, 'plans-clear')
    expect(saved(store)).toEqual([])
    expect(planEntries(store)).toHaveLength(1)
  })

  test('plan groups sort with flow groups by their end, newest first', async ($, on) => {
    const later = flowEntry(0, { id: 'later', startedAt: NOW + HOUR, endedAt: NOW + 2 * HOUR })
    const earlier = flowEntry(1, { id: 'earlier' })
    const { store, clock } = engine(on, { store: { historyShown: true, history: [later, earlier] } })
    await start($)
    await create($)
    await finish($)
    const id = planEntries(store)[0]!.id
    expect(history(store).map(e => e.id)).toEqual(['later', id, 'earlier'])
    const t = await terminal($)
    expect(t.groups).toEqual([`archive-${keyOf('later')}`, `archive-${keyOf(id)}`, `archive-${keyOf('earlier')}`])
    // a flow finished after it goes first
    clock.now = NOW + 3 * HOUR
    await progress($, { title: 'Next', total: 1, done: 1, phase: 'close', tasks: [{ title: 'a', tier: 'light' }] })
    await progress($, { finished: true })
    expect(history(store)[0]!.title).toBe('Next')
    expect(history(store).map(e => e.id).indexOf(id)).toBe(2)
  })

  test('the fold line says 1 step, and narrows with the panel', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($, { id: 'solo', title: 'Solo', stages: [{ name: 'S', steps: [{ title: 'a' }] }] })
    await plan($, { id: 'solo', done: ['a'] })
    const id = planEntries(store)[0]!.id
    expect((await terminal($, 40)).group(id).text).toMatch(/^▾ .* · \d{2}:\d{2} · 1 step$/)
    expect((await terminal($, 24)).group(id).text).toMatch(/^▾ [A-Z][a-z]{2} \d{1,2}, \d{4} · 1 step$/)
  })

  test('old entries without a plan are drawn as before', async ($, on) => {
    const old = { id: 'old', project: PROJECT, title: 'Old', startedAt: NOW - DAY, endedAt: NOW - DAY + HOUR, status: 'finished', done: 1, total: 2, tasks: [{ title: 'a', tier: 'light' }, { title: 'b', tier: 'light' }], cost: 1, tokens: 2, time: 3 }
    const { store } = engine(on, { store: { historyShown: true, history: [old] } })
    await start($)
    const t = await terminal($)
    expect(t.group('old').text).toMatch(/^▾ .* · 2 items$/)
    expect(t.text).toMatch(/✓ a \(light\)/)
    expect(t.text).toMatch(/○ b \(light\)/)
    expect(parseArchive(store.history)).toEqual([old as ArchiveEntry])
  })

  test('the live panel is unchanged: the open flow keeps its Planned block, plans their section', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Live', total: 3, done: 0, phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }, { title: 'two', tier: 'light' }, { title: 'three', tier: 'light' }] })
    await create($)
    const t = await terminal($)
    expect(t.text).toMatch(/Planned · 3/)
    expect(t.text).toMatch(/Beta cleanup {2}Running/)
  })
})

// --- Part A: no planned rows in an Archive group

const NAMES = Array.from({ length: 10 }, (_, i) => `task ${i + 1}`)
const tenFlow: Flow = {
  title: 'Ten',
  total: 10,
  done: 7,
  running: 0,
  phase: 'delegate',
  isFinished: false,
  isLinked: true,
  tasks: NAMES.map(title => ({ title, tier: 'light', after: [] })),
}
const runOf = (i: number): AgentRun => ({
  id: `r${i}`,
  agentId: `r${i}`,
  type: 'flowdeck-light',
  description: NAMES[i]!,
  model: 'claude-opus-5-5',
  status: 'done',
  startedAt: NOW - HOUR + i * MIN,
  endedAt: NOW - HOUR + i * MIN + 30_000,
  contextTokens: 1000,
  contextMax: 1_000_000,
  tokens: 100,
  costUsd: 0.01,
  steps: 1,
  round: 1,
})

describe('an Archive group draws no planned block', () => {
  test('an entry with 10 tasks and 7 archived runs shows the 7 rows and no Planned', async ($, on) => {
    const entry = { ...snapshot({ flow: tenFlow, agents: Array.from({ length: 7 }, (_, i) => runOf(i)), project: PROJECT, startedAt: NOW - HOUR, endedAt: NOW - 10 * MIN, status: 'open' }), partial: true }
    engine(on, { store: { historyShown: true, history: [entry] } })
    await start($)
    await settle()
    const t = await terminal($)
    expect(t.texts.filter(x => x === '▣')).toHaveLength(7)
    expect(t.text).not.toMatch(/Planned/)
    for (const n of [8, 9, 10]) expect(t.text).not.toMatch(new RegExp(`task ${n}\\b`))
    const d = await desktop($)
    expect(d.alts.filter(a => /^task \d+:/.test(a))).toHaveLength(7)
    expect(d.alts.some(a => /planned/i.test(a))).toBe(false)
    expect(d.svgs.some((s: any) => /Planned/.test(String(s.props.source)))).toBe(false)
  })
})

// --- on disk: the plan save takes the flows' path

const DIR = `${PROJECT}/.claude/flowdeck`
const HISTORY = `${DIR}/history.json`
const LIMIT = 2000

function diskEngine(on: any, files: Record<string, string> = {}) {
  const fs = fakeFs(on, { files })
  const clock = { now: NOW }
  const store: Record<string, unknown> = {}
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'FLOWDECK_HISTORY_SEGMENT_MAX' ? String(LIMIT) : undefined }))
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
  return { fs, clock, store }
}

const idsIn = (text: string | undefined): string[] => (text === undefined ? [] : (JSON.parse(text) as any[]).map(e => e.id))

describe('plan entries on disk', () => {
  test('the plan save writes its side file first, then history.json; the store is not used', async ($, on) => {
    const { fs, store } = diskEngine(on)
    await start($)
    await create($)
    await finish($)
    const order = fs.writes.filter(w => /history/.test(w))
    expect(order[0]).toBe(`${DIR}/history-extra-${NOW}.json`)
    expect(order).toContain(HISTORY)
    const [e] = parseArchive(JSON.parse(fs.files[HISTORY]!))
    expect(e!.plan!.title).toBe('Beta cleanup')
    expect(store.history).toBeUndefined()
  })

  test('plan entries survive a volume rotation: every id is kept once, each plan intact', async ($, on) => {
    const plans = Array.from({ length: 3 }, (_, i) => planEntry(donePlan({ id: `old${i}`, startedAt: NOW - (i + 2) * DAY, endedAt: NOW - (i + 2) * DAY + HOUR }), PROJECT, NOW))
    const seeded: ArchiveEntry[] = [...plans]
    for (let i = 10; JSON.stringify([...seeded, flowEntry(i)]).length < LIMIT; i++) seeded.push(flowEntry(i))
    const { fs } = diskEngine(on, { [HISTORY]: JSON.stringify(seeded) })
    await start($)
    await create($)
    await finish($)
    const volumes = Object.keys(fs.files).filter(p => /\/history-\d+\.json$/.test(p))
    expect(volumes.length).toBeGreaterThan(0)
    const all = [HISTORY, ...volumes].flatMap(p => parseArchive(JSON.parse(fs.files[p]!)))
    const ids = all.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual([...seeded.map(e => e.id), `plan-beta-${NOW}-${PROJECT}`].sort())
    for (const p of plans) expect(all.find(e => e.id === p.id)).toEqual(p)
    expect(idsIn(fs.files[HISTORY])[0]).toBe(`plan-beta-${NOW}-${PROJECT}`)
  })
})
