import { describe, expect, test } from 'claude-code/testing'

import { addEntry, groupLine as lineOf, isWorthKeeping, keyOf, parseArchive, parseSession, planEntry, snapshot } from '../hooks/archive'
import { recordOf, sessionName } from '../hooks/archive-index'
import type { AgentRun, ArchiveEntry, Flow, TaskPlan } from '../types'
import { fileOf, indexPath, records, seed, sessions } from './archive-files'
import { fakeFs } from './fake-fs'
import { acrossTabs, showTab } from './tabs'
import type { Tab } from './tabs'

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

  test('groupLine for a plan: the date then its step count in brackets, narrowing like a flow’s', () => {
    // the fold line is drawn from the session's index record, which carries the item count
    const groupLine = (x: ArchiveEntry, cols: number, tz?: string) => lineOf(recordOf(x, fileOf(x), 0), cols, tz)
    const e = planEntry(donePlan({ startedAt: Date.UTC(2026, 9, 26, 9, 0), endedAt: Date.UTC(2026, 9, 26, 10, 42) }), PROJECT, NOW)
    expect(groupLine(e, 40, 'UTC')).toBe('Oct 26, 2026 · 10:42 (3)')
    expect(groupLine(e, 24, 'UTC')).toBe('Oct 26, 2026 · 10:42 (3)')
    expect(groupLine(e, 20, 'UTC')).toBe('Oct 26, 2026 (3)')
    expect(groupLine(e, 5, 'UTC')).toBe('Oct 26, 2026 (3)')
    const one = planEntry(donePlan({ stages: [{ name: 'S', steps: [{ title: 'a', status: 'done', substeps: [] }] }], startedAt: Date.UTC(2026, 9, 26, 9, 0), endedAt: Date.UTC(2026, 9, 26, 10, 42) }), PROJECT, NOW)
    expect(groupLine(one, 40, 'UTC')).toBe('Oct 26, 2026 · 10:42 (1)')
    expect(groupLine(one, 20, 'UTC')).toBe('Oct 26, 2026 (1)')
    // a flow entry counts its rows the same way
    expect(groupLine(flowEntry(1, { endedAt: Date.UTC(2026, 9, 26, 10, 42), startedAt: Date.UTC(2026, 9, 26, 9, 0) }), 40, 'UTC')).toBe('Oct 26, 2026 · 10:42 (1)')
  })

  test('addEntry puts a plan where it belongs by its end, a flow too; a second save replaces the first', () => {
    const newer = flowEntry(0, { id: 'newer', endedAt: NOW + HOUR })
    const older = flowEntry(1)
    const e = planEntry(donePlan(), PROJECT, NOW)
    const list = addEntry([newer, older], e)
    expect(list.map(x => x.id)).toEqual(['newer', e.id, 'e1'])
    expect(addEntry(list, e).map(x => x.id)).toEqual(['newer', e.id, 'e1'])
    const again = planEntry(donePlan({ endedAt: NOW + 2 * HOUR }), PROJECT, NOW)
    expect(addEntry(list, again).map(x => x.id)).toEqual([e.id, 'newer', 'e1'])
    expect(addEntry(list, again).filter(x => x.id === e.id)[0]!.endedAt).toBe(NOW + 2 * HOUR)
    // one order for every entry: a flow saved now that ended before them all goes last, one that ended last goes first
    expect(addEntry(list, flowEntry(5, { id: 'flow' })).map(x => x.id)).toEqual(['newer', e.id, 'e1', 'flow'])
    expect(addEntry(list, flowEntry(5, { id: 'flow', endedAt: NOW + 3 * HOUR })).map(x => x.id)[0]).toBe('flow')
  })

  test('a plan entry is a session file of its own like any entry, intact, and its index record counts its steps', () => {
    const plans = Array.from({ length: 12 }, (_, i) => planEntry(donePlan({ id: `p${i}`, startedAt: NOW - (i + 1) * DAY, endedAt: NOW - (i + 1) * DAY + HOUR }), PROJECT, NOW))
    expect(new Set(plans.map(p => sessionName(p))).size).toBe(12)
    for (const p of plans) {
      const text = JSON.stringify(p)
      expect(sessionName(p)).toBe(`${keyOf(p.id)}-${p.startedAt}.json`)
      expect(parseSession(JSON.parse(text))).toEqual(p)
      expect(recordOf(p, sessionName(p), text.length)).toMatchObject({ id: p.id, kind: 'plan', title: 'Beta cleanup', itemCount: 3, taskCount: 3, cost: 0, tokens: 0, time: HOUR })
    }
  })
})

// --- in the panel (no fs hook: the shared-store fallback)

type Opts = { store?: Record<string, unknown> }

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
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { store, clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const mount = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const history = (store: Record<string, unknown>): ArchiveEntry[] => (store.history ?? []) as ArchiveEntry[]
const HEAD = /^Beta cleanup {2}Done$/

// What the named tabs draw (the Archive tab unless named), one after another; the tabs' own Buttons left out.
const terminal = async ($: any, bodyColumns = 80, tabs: Tab[] = ['archive']) => {
  const texts = await acrossTabs($, () => mount($, 'terminal', bodyColumns), p => p.findAll({ type: 'Text' }), tabs)
  const buttons = (await acrossTabs($, () => mount($, 'terminal', bodyColumns), p => p.findAll({ type: 'Button' }), tabs)).filter((b: any) => !/^tab-/.test(String(b.props.key)))
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
const desktop = async ($: any, tabs: Tab[] = ['archive']) => {
  const svgs = await acrossTabs($, () => mount($, 'desktop'), p => p.findAll({ type: 'Svg' }), tabs)
  const buttons = await acrossTabs($, () => mount($, 'desktop'), p => p.findAll({ type: 'Button' }), tabs)
  return { svgs, alts: svgs.map((s: any) => String(s.props.alt ?? '')), keys: buttons.map((b: any) => String(b.props.key)) }
}
const press = async ($: any, key: string, tab: Tab = 'archive') => {
  await showTab($, tab)
  const p = await mount($, 'terminal')
  await p.press({ key })
  await settle()
  await p.unmount()
}

// The Plans feature is gone (1.0.0035): no new plan is archived, and a plan an older flowdeck archived still draws.
describe('archived plans an older flowdeck saved', () => {
  test('an archived plan is its own group: the fold line counts steps, open it draws the plan with Done', async ($, on) => {
    const e = planEntry(donePlan(), PROJECT, NOW)
    engine(on, { store: { historyShown: true, history: [e] } })
    await start($)
    await settle()
    const t = await terminal($, 80, ['archive'])
    expect(t.group(e.id).text).toMatch(/^▾ [A-Z][a-z]{2} \d{1,2}, \d{4} · \d{2}:\d{2} \(3\)$/)
    expect(t.group(e.id).text).not.toMatch(/Beta/)
    // only the Archive group draws it: there is no Plans tab
    expect(t.texts.filter(x => HEAD.test(x))).toHaveLength(1)
    expect(t.texts.filter(x => /100%$/.test(x))).toHaveLength(1)
    // no tiles for a plan group
    expect(t.text).not.toMatch(/≈\$0\.00/)
    const d = await desktop($, ['archive'])
    expect(d.alts.filter(a => a === 'Beta cleanup: Done, 100%')).toHaveLength(1)
    // folded, the group keeps its fold line only
    await press($, `archive-${keyOf(e.id)}`)
    const folded = await terminal($, 80, ['archive'])
    expect(folded.group(e.id).text).toMatch(/^▸ .* \(3\)$/)
    expect(folded.texts.filter(x => HEAD.test(x))).toHaveLength(0)
  })

  test('plan groups sort with flow groups by their end, newest first', async ($, on) => {
    const later = flowEntry(0, { id: 'later', startedAt: NOW + HOUR, endedAt: NOW + 2 * HOUR })
    const earlier = flowEntry(1, { id: 'earlier' })
    const archived = planEntry(donePlan(), PROJECT, NOW)
    const id = archived.id
    const { store, clock } = engine(on, { store: { historyShown: true, history: [later, archived, earlier] } })
    await start($)
    await settle()
    const t = await terminal($)
    expect(t.groups).toEqual([`archive-${keyOf('later')}`, `archive-${keyOf(id)}`, `archive-${keyOf('earlier')}`])
    // a flow finished after it goes first
    clock.now = NOW + 3 * HOUR
    await progress($, { title: 'Next', total: 1, done: 1, phase: 'close', tasks: [{ title: 'a', tier: 'light' }] })
    await progress($, { finished: true })
    expect(history(store)[0]!.title).toBe('Next')
    expect(history(store).map(e => e.id).indexOf(id)).toBe(2)
  })

  test('the fold line counts 1 step as (1), and narrows with the panel', async ($, on) => {
    const solo = planEntry(donePlan({ id: 'solo', title: 'Solo', stages: [{ name: 'S', steps: [{ title: 'a', status: 'done', substeps: [] }] }] }), PROJECT, NOW)
    const id = solo.id
    engine(on, { store: { historyShown: true, history: [solo] } })
    await start($)
    await settle()
    expect((await terminal($, 40)).group(id).text).toMatch(/^▾ .* · \d{2}:\d{2} \(1\)$/)
    expect((await terminal($, 24)).group(id).text).toMatch(/^▾ [A-Z][a-z]{2} \d{1,2}, \d{4} \(1\)$/)
  })

  test('old entries without a plan are drawn as before', async ($, on) => {
    const old = { id: 'old', project: PROJECT, title: 'Old', startedAt: NOW - DAY, endedAt: NOW - DAY + HOUR, status: 'finished', done: 1, total: 2, tasks: [{ title: 'a', tier: 'light' }, { title: 'b', tier: 'light' }], cost: 1, tokens: 2, time: 3 }
    const { store } = engine(on, { store: { historyShown: true, history: [old] } })
    await start($)
    const t = await terminal($)
    expect(t.group('old').text).toMatch(/^▾ .* \(2\)$/)
    expect(t.text).toMatch(/✓ a \(light\)/)
    expect(t.text).toMatch(/○ b \(light\)/)
    expect(parseArchive(store.history)).toEqual([old as ArchiveEntry])
  })

  test('the live panel: the Active tab lists the open flow’s queued tasks', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Live', total: 3, done: 0, phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }, { title: 'two', tier: 'light' }, { title: 'three', tier: 'light' }] })
    const t = await terminal($, 80, ['active'])
    for (const row of [/1\. one ◷/, /2\. two ◷/, /3\. three ◷/]) expect(t.text).toMatch(row)
    expect(t.text).not.toMatch(/Planned ·/)
  })

  test('a finished flow is the only new session the Archive gets: no plan entry is saved', async ($, on) => {
    const { store } = engine(on, { store: { plans: { s: [{ ...donePlan(), state: 'done' }] } } })
    await start($)
    await progress($, { title: 'Ship', total: 1, done: 1, phase: 'close', tasks: [{ title: 'a', tier: 'light' }] })
    await progress($, { finished: true })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    await settle()
    expect(history(store).map(e => e.title)).toEqual(['Ship'])
    expect(history(store).some(e => e.plan)).toBe(false)
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
// The archive file before 1.0.0025: read once by the migration, never written.
const HISTORY = `${DIR}/history.json`

function diskEngine(on: any, files: Record<string, string> = {}) {
  const fs = fakeFs(on, { files })
  const clock = { now: NOW }
  const store: Record<string, unknown> = {}
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
  return { fs, clock, store }
}

describe('plan entries on disk', () => {
  test('an archived plan in archive/ draws from its file like a flow', async ($, on) => {
    const e = planEntry(donePlan(), PROJECT, NOW)
    const files: Record<string, string> = {}
    seed(files, DIR, [e])
    const { fs } = diskEngine(on, files)
    await start($)
    await settle()
    expect(records(fs.files, indexPath(DIR))).toEqual([expect.objectContaining({ id: e.id, file: fileOf(e), kind: 'plan', itemCount: 3 })])
    expect(parseSession(JSON.parse(fs.files[`${DIR}/archive/${fileOf(e)}`]!))).toEqual(e)
    const t = await terminal($, 80, ['archive'])
    expect(t.texts.filter(x => HEAD.test(x))).toHaveLength(1)
    expect(fs.writes).not.toContain(HISTORY)
  })

  test('plan entries in the old archive are imported into session files: every id once, each plan intact', async ($, on) => {
    const plans = Array.from({ length: 3 }, (_, i) => planEntry(donePlan({ id: `old${i}`, startedAt: NOW - (i + 2) * DAY, endedAt: NOW - (i + 2) * DAY + HOUR }), PROJECT, NOW))
    const seeded: ArchiveEntry[] = [...plans, ...Array.from({ length: 10 }, (_, i) => flowEntry(i + 10))]
    const legacy = JSON.stringify(seeded)
    const { fs } = diskEngine(on, { [HISTORY]: legacy })
    await start($)
    await settle()
    const all = sessions(fs.files, DIR)
    const ids = all.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(seeded.map(e => e.id).sort())
    for (const p of plans) expect(all.find(e => e.id === p.id)).toEqual(p)
    // the index lists them all, the newest plan (the latest end) first
    const recs = records(fs.files, indexPath(DIR))!
    expect(recs.map(r => r.id).sort()).toEqual([...ids].sort())
    expect(recs[0]!.id).toBe(plans[0]!.id)
    expect(recs.filter(r => r.kind === 'plan')).toHaveLength(3)
    // the old file is left as it was
    expect(fs.files[HISTORY]).toBe(legacy)
    expect(fs.writes).not.toContain(HISTORY)
  })
})
