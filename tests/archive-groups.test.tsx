import { describe, expect, test } from 'claude-code/testing'

import { addEntry, entryDate, formatEntry, groupLine, keyOf, MAX_AGENTS, MAX_ARCHIVE_BYTES, parseArchive, snapshot } from '../hooks/archive'
import { recordOf } from '../hooks/archive-index'
import { dataDir, saveSession } from '../hooks/archive-store'
import type { Io } from '../hooks/archive-store'
import { STATE_COLOR } from '../hooks/plan-view'
import { doneText } from '../hooks/time'
import { fileOf, indexPath, records, sessionPaths, sessions } from './archive-files'
import { laterDay, showTab } from './tabs'
import type { Tab } from './tabs'
import type { AgentRun, Flow, ArchiveEntry } from '../types'
import { utf8 } from './fake-fs'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.UTC(2026, 9, 26, 12, 40)

const flow = (over: Partial<Flow> = {}): Flow => ({
  title: 'Ship it',
  total: 3,
  done: 2,
  running: 0,
  phase: 'close',
  isFinished: true,
  isLinked: true,
  tasks: [
    { title: 'write tests', tier: 'careful', after: [] },
    { title: 'wire it', tier: 'medium', after: [1] },
    { title: 'polish', tier: 'light', after: [1, 2] },
  ],
  ...over,
})

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'a1',
  agentId: 'a1',
  type: 'flowdeck-careful',
  description: 'write tests',
  model: 'claude-opus-5-5',
  effort: 'high',
  status: 'done',
  startedAt: NOW - 2 * HOUR,
  endedAt: NOW - 2 * HOUR + 5 * MIN,
  contextTokens: 100_000,
  contextMax: 1_000_000,
  tokens: 12_000,
  costUsd: 0.5,
  steps: 3,
  round: 1,
  ...over,
})

const snap = (agents: AgentRun[], over: Partial<Parameters<typeof snapshot>[0]> = {}) =>
  snapshot({ flow: flow(), agents, project: '/work/app', startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, status: 'finished', ...over })

describe('archive entries hold the flow', () => {
  test('snapshot stores the agents without the live fields, and the tasks with their after', () => {
    const e = snap([run({ tool: 'Bash', isAsked: true, items: [{ title: 'one', status: 'done', startedAt: 1, doneAt: 2 }] })])
    expect(e.agents?.length).toBe(1)
    const a = e.agents![0]! as Record<string, unknown>
    expect('tool' in a).toBe(false)
    expect('isAsked' in a).toBe(false)
    expect(a).toEqual({
      id: 'a1',
      agentId: 'a1',
      type: 'flowdeck-careful',
      description: 'write tests',
      model: 'claude-opus-5-5',
      effort: 'high',
      status: 'done',
      startedAt: NOW - 2 * HOUR,
      endedAt: NOW - 2 * HOUR + 5 * MIN,
      contextTokens: 100_000,
      contextMax: 1_000_000,
      tokens: 12_000,
      costUsd: 0.5,
      steps: 3,
      round: 1,
      items: [{ title: 'one', status: 'done', startedAt: 1, doneAt: 2 }],
    })
    expect(e.tasks).toEqual([
      { title: 'write tests', tier: 'careful', after: [] },
      { title: 'wire it', tier: 'medium', after: [1] },
      { title: 'polish', tier: 'light', after: [1, 2] },
    ])
  })

  test('a run still going when the flow is saved gets the save time as its end', () => {
    const e = snap([run({ status: 'running', endedAt: undefined })])
    expect(e.agents![0]!.status).toBe('running')
    expect(e.agents![0]!.endedAt).toBe(NOW - HOUR)
  })

  test('caps: the newest 60 runs by start, 12 items each, strings at 200', () => {
    const long = 'x'.repeat(500)
    const items = Array.from({ length: 20 }, (_, i) => ({ title: `step ${i}`, status: 'pending' as const }))
    const agents = Array.from({ length: 80 }, (_, i) => run({ id: `r${i}`, agentId: `r${i}`, startedAt: NOW - 2 * HOUR + (79 - i) * 1000, description: long, model: long, type: long, stepNote: long, items }))
    const e = snap(agents)
    expect(MAX_AGENTS).toBe(60)
    expect(e.agents!.length).toBe(60)
    const ids = new Set(e.agents!.map(a => a.id))
    // r0 started last, r79 first: the 20 that started first are dropped
    expect(ids.has('r0')).toBe(true)
    expect(ids.has('r59')).toBe(true)
    expect(ids.has('r60')).toBe(false)
    for (const a of e.agents!) {
      expect(a.description.length).toBe(200)
      expect(a.model.length).toBe(200)
      expect(a.type.length).toBe(200)
      expect(a.stepNote!.length).toBe(200)
      expect(a.items!.length).toBe(12)
    }
    // the totals still count every run
    expect(e.tokens).toBe(80 * 12_000)
  })

  test('snapshot caps what it writes: the title, each task title and tier at 200, the first 100 tasks, 100 waits each', () => {
    const long = 'x'.repeat(500)
    const tasks = Array.from({ length: 150 }, (_, i) => ({ title: `${i} ${long}`, tier: long, after: Array.from({ length: 300 }, (_, k) => k + 1) }))
    const e = snap([run()], { flow: flow({ title: long, tasks }) })
    expect(e.title).toHaveLength(200)
    expect(e.tasks).toHaveLength(100)
    expect(e.tasks[99]!.title.startsWith('99 ')).toBe(true)
    for (const t of e.tasks) {
      expect(t.title).toHaveLength(200)
      expect(t.tier).toHaveLength(200)
      expect(t.after).toHaveLength(100)
    }
    // what is written is what a read gives back
    expect(parseArchive(JSON.parse(JSON.stringify([e])))).toEqual([e])
  })

  test('parseArchive: old entries without agents load as they are, and the new fields survive a round trip', () => {
    const old = { id: 'old', project: '/work/app', title: 'Old', startedAt: 1, endedAt: 2, status: 'finished', done: 1, total: 2, tasks: [{ title: 'a', tier: 'light' }], cost: 1, tokens: 2, time: 3 }
    const [o] = parseArchive([old])
    expect(o!.agents).toBeUndefined()
    expect(o!.tasks).toEqual([{ title: 'a', tier: 'light' }])
    const e = snap([run({ items: [{ title: 'one', status: 'active', startedAt: 5 }] }), run({ id: 'a2', agentId: undefined, effort: undefined, status: 'failed', stepDone: 1, stepTotal: 3, stepNote: 'two' })])
    expect(parseArchive(JSON.parse(JSON.stringify([e, old])))).toEqual([e, o!])
  })

  test('parseArchive drops broken agents and bad after numbers, keeps the entry', () => {
    const e = snap([run()])
    const raw = JSON.parse(JSON.stringify(e))
    raw.agents.push(null, 7, { id: 'x' }, { ...raw.agents[0], id: 'bad-status', status: 'weird' }, { ...raw.agents[0], id: 'bad-start', startedAt: 'soon' })
    raw.tasks[1].after = [1, 'two', -3, 2.5, 3]
    raw.tasks[2].after = 'nope'
    const [p] = parseArchive([raw, 'junk'])
    expect(p!.agents!.map(a => a.id)).toEqual(['a1'])
    expect(p!.tasks[1]!.after).toEqual([1, 3])
    expect(p!.tasks[2]!.after).toBeUndefined()
    const [noList] = parseArchive([{ ...raw, agents: 'nope' }])
    expect(noList!.agents).toBeUndefined()
  })
})

describe('the archive is never cut', () => {
  const big = (i: number): ArchiveEntry => {
    const items = Array.from({ length: 12 }, (_, k) => ({ title: `item ${k} ${'y'.repeat(40)}`, status: 'done' as const, startedAt: k, doneAt: k + 1 }))
    const agents = Array.from({ length: 60 }, (_, k) => run({ id: `e${i}-r${k}`, startedAt: NOW + k, description: 'd'.repeat(200), stepNote: 'n'.repeat(200), items }))
    return snap(agents, { startedAt: NOW + i * MIN, endedAt: NOW + i * MIN + 1 })
  }

  test('addEntry keeps every flow: no cap on the count', () => {
    let h: ArchiveEntry[] = []
    for (let i = 0; i < 120; i++) h = addEntry(h, snap([run()], { startedAt: NOW + i, endedAt: NOW + i + 1 }))
    expect(h.length).toBe(120)
    expect(h[0]!.startedAt).toBe(NOW + 119)
  })

  test('each session is its own file: an archive far past 2,500,000 bytes is saved whole, no file near the limit', async () => {
    // the project folder's files in memory, as the engine's fs keeps them
    const files: Record<string, string> = {}
    const names = (dir: string) => Object.keys(files).filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    const missing = () => {
      throw new Error('ENOENT')
    }
    const io: Io = {
      read: p => (p in files ? files[p] : missing()),
      write: (p, text) => void (files[p] = text),
      stat: p => (p in files ? { kind: 'file', size: utf8(files[p]!) } : missing()),
      list: dir => (names(dir).length ? names(dir).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })) : missing()),
      exists: p => p in files,
      storeGet: async () => undefined,
      storeSet: async () => undefined,
    }
    const base = big(0)
    const list = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `big-${i}`, startedAt: NOW + i * MIN, endedAt: NOW + i * MIN + 1 }))
    expect(MAX_ARCHIVE_BYTES).toBe(2_500_000)
    expect(utf8(JSON.stringify(list))).toBeGreaterThan(2_500_000)
    for (const e of list) expect((await saveSession(io, '/work/app', e, e.endedAt)).isSaved).toBe(true)
    const DIR = dataDir('/work/app')
    expect(sessionPaths(files, DIR)).toEqual(list.map(e => `${DIR}/archive/${fileOf(e)}`).sort())
    for (const p of sessionPaths(files, DIR)) expect(utf8(files[p]!)).toBeLessThan(MAX_ARCHIVE_BYTES / 10)
    expect(utf8(files[indexPath(DIR)]!)).toBeLessThan(MAX_ARCHIVE_BYTES / 100)
    // every session kept as saved, the index listing each once, newest first
    expect(sessions(files, DIR).map(e => e.id)).toEqual([...list].reverse().map(e => e.id))
    expect(records(files, indexPath(DIR))!.map(r => r.id)).toEqual([...list].reverse().map(e => e.id))
    expect(sessions(files, DIR)[39]).toEqual(list[0])
  })

  test('addEntry on an archive past the limit still keeps everything', () => {
    const base = big(0)
    const list = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `big-${29 - i}` }))
    const next = addEntry(list, { ...base, id: 'big-30' })
    expect(next.length).toBe(31)
    expect(utf8(JSON.stringify(next))).toBeGreaterThan(2_500_000)
  })
})

describe('the group date', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi)
  const e = (startedAt: number, endedAt: number, status: 'finished' | 'open' = 'finished') => ({ ...snap([]), startedAt, endedAt, status }) as ArchiveEntry

  test('same day: the end date and time', () => {
    expect(entryDate(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), 'UTC')).toBe('Oct 26, 2026 · 10:42')
    expect(entryDate(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 22, 5)), 'UTC')).toBe('Oct 26, 2026 · 22:05')
    expect(entryDate(e(at(2026, 10, 26, 0, 1), at(2026, 10, 26, 0, 30)), 'UTC')).toBe('Oct 26, 2026 · 00:30')
  })

  test('a flow that started on an earlier day shows the range', () => {
    expect(entryDate(e(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 10, 42)), 'UTC')).toBe('Oct 25 → Oct 26, 2026 · 10:42')
  })

  test('across the year boundary both dates carry their year', () => {
    expect(entryDate(e(at(2025, 12, 31, 23, 0), at(2026, 1, 1, 0, 30)), 'UTC')).toBe('Dec 31, 2025 → Jan 1, 2026 · 00:30')
  })

  test('the day is the time zone’s day', () => {
    // 23:00 UTC on Oct 25 is already Oct 26 in Kolkata, the same day as the end
    expect(entryDate(e(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 5, 0)), 'Asia/Kolkata')).toBe('Oct 26, 2026 · 10:30')
    expect(entryDate(e(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 5, 0)), 'UTC')).toBe('Oct 25 → Oct 26, 2026 · 05:00')
  })

  test('formatEntry: title, the short line with date, done/total and status, the task lines', () => {
    const f = formatEntry(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), 'UTC')
    expect(f.head).toBe('Ship it')
    expect(f.line).toBe('Oct 26, 2026 · 10:42 · 2/3 · finished')
    expect(f.lines).toEqual(['✓ write tests (careful)', '✓ wire it (medium)', '○ polish (light)'])
    const open = formatEntry(e(at(2026, 10, 25, 9, 0), at(2026, 10, 26, 10, 42), 'open'), 'UTC')
    expect(open.line).toBe('Oct 25 → Oct 26, 2026 · 10:42 · 2/3 · ended with the session')
    expect(formatEntry({ ...e(1, 2), title: '  ' }, 'UTC').head).toBe('Untitled flow')
  })

  test('entryDate compact drops the time of day', () => {
    expect(entryDate(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), 'UTC', true)).toBe('Oct 26, 2026')
  })

  // The fold line is drawn from the session's index record, which carries the item count.
  const lineOf = (x: ArchiveEntry, cols: number, tz?: string) => groupLine(recordOf(x, fileOf(x), 0), cols, tz)

  test('groupLine: the session name (end date and time) and its item count in brackets, on one line', () => {
    const x = { ...e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), agents: Array.from({ length: 17 }, (_, i) => run({ id: `a${i}` })) } as ArchiveEntry
    expect(lineOf(x, 90, 'UTC')).toBe('Oct 26, 2026 · 10:42 (17)')
    expect(lineOf({ ...x, agents: [run()] }, 90, 'UTC')).toBe('Oct 26, 2026 · 10:42 (1)')
    expect(lineOf({ ...x, startedAt: at(2026, 10, 25, 23, 0) }, 90, 'UTC')).toBe('Oct 25 → Oct 26, 2026 · 10:42 (17)')
    expect(lineOf({ ...x, partial: true }, 90, 'UTC')).toBe('Oct 26, 2026 · 10:42 (17) · running')
    // an entry saved without agents counts its tasks
    expect(lineOf({ ...x, agents: undefined }, 90, 'UTC')).toBe('Oct 26, 2026 · 10:42 (3)')
    expect(lineOf({ ...x, tasks: [x.tasks[0]!], agents: undefined }, 90, 'UTC')).toBe('Oct 26, 2026 · 10:42 (1)')
    for (const status of ['finished', 'open'] as const) expect(lineOf({ ...x, status }, 90, 'UTC')).not.toMatch(/items|finished|ended|17\/17|Ship it/)
  })

  test('groupLine narrows: the time of day goes first, then the running mark; the count stays', () => {
    const x = { ...e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), agents: Array.from({ length: 17 }, (_, i) => run({ id: `a${i}` })) } as ArchiveEntry
    expect(lineOf(x, 25, 'UTC')).toBe('Oct 26, 2026 · 10:42 (17)')
    expect(lineOf(x, 24, 'UTC')).toBe('Oct 26, 2026 (17)')
    expect(lineOf({ ...x, partial: true }, 35, 'UTC')).toBe('Oct 26, 2026 · 10:42 (17) · running')
    expect(lineOf({ ...x, partial: true }, 30, 'UTC')).toBe('Oct 26, 2026 (17) · running')
    expect(lineOf({ ...x, partial: true }, 20, 'UTC')).toBe('Oct 26, 2026 (17)')
    for (const w of [90, 25, 17]) expect(lineOf(x, w, 'UTC').length).toBeLessThanOrEqual(w)
    // too narrow for anything: the shortest form, truncated by the view
    expect(lineOf(x, 5, 'UTC')).toBe('Oct 26, 2026 (17)')
  })
})

// --- in the panel (no fs hook: the shared-store fallback, as in panel-archive)

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
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

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
// The Archive tab, unless another is named.
const pane = async ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80, tab: Tab = 'archive') => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
}
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const pressOn = async ($: any, tab: Tab, surface: 'terminal' | 'desktop', ...keys: string[]) => {
  for (const key of keys) {
    const p = await pane($, surface, 80, tab)
    await p.press({ key })
    await settle()
    await p.unmount()
  }
}
const press = ($: any, surface: 'terminal' | 'desktop', ...keys: string[]) => pressOn($, 'archive', surface, ...keys)
// The pane's own Buttons, the tabs left out.
const own = async (p: any) => (await p.findAll({ type: 'Button' })).filter((b: any) => !/^tab-/.test(String(b.props.key)))
const terminal = async ($: any, tab: Tab = 'archive') => {
  const p = await pane($, 'terminal', 80, tab)
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await own(p)
  await p.unmount()
  return { text: texts.map((t: any) => t.text).join('\n'), texts, buttons, keys: buttons.map((b: any) => String(b.props.key)) }
}
const desktop = async ($: any) => {
  const p = await pane($, 'desktop')
  const svgs = await p.findAll({ type: 'Svg' })
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await own(p)
  await p.unmount()
  return { svgs, texts, buttons, keys: buttons.map((b: any) => String(b.props.key)), alts: svgs.map((s: any) => String(s.props.alt ?? '')) }
}

// Two saved flows with their agents: the newer one has a done run, a failed run with items and an unstarted task. Saved
// without a day, as an earlier release saved them, so the Archive lists them whatever the date (the Finished tab keeps
// a flow saved with today's date: tests/finished-day.test.tsx).
const undated = ({ day: _, ...e }: ArchiveEntry): ArchiveEntry => e
const groupA = (): ArchiveEntry =>
  ({
    ...undated(snap(
      [
        run(),
        run({ id: 'a2', agentId: 'a2', description: 'wire it', type: 'flowdeck-medium', status: 'failed', startedAt: NOW - 2 * HOUR + MIN, endedAt: NOW - 2 * HOUR + 3 * MIN, tokens: 8000, costUsd: 0.25, items: [{ title: 'read code', status: 'done', startedAt: NOW - 2 * HOUR + MIN, doneAt: NOW - 2 * HOUR + 2 * MIN }, { title: 'patch it', status: 'error', startedAt: NOW - 2 * HOUR + 2 * MIN, doneAt: NOW - 2 * HOUR + 3 * MIN }] }),
      ],
      { flow: flow({ title: 'Flow A', done: 1 }) },
    )),
    id: 'gA',
    cost: 1.5,
    tokens: 12_000,
    time: 30 * MIN,
  }) as ArchiveEntry
const groupB = (): ArchiveEntry =>
  ({
    ...undated(snap([run({ id: 'b1', agentId: 'b1', description: 'only task' })], { flow: flow({ title: 'Flow B', tasks: [{ title: 'only task', tier: 'careful', after: [] }], total: 1, done: 1 }), startedAt: NOW - 30 * HOUR, endedAt: NOW - 25 * HOUR })),
    id: 'gB',
    cost: 0.75,
    tokens: 3_000,
    time: 90_000,
  }) as ArchiveEntry
const DATE = /[A-Z][a-z]{2} \d{1,2}.*, \d{4} · \d{2}:\d{2}/

describe('archive groups in the panel', () => {
  test('two groups show their date and item count and a dim summary line; the newest is open, the other folded', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), groupB()] } })
    await start($)
    await settle()
    const t = await terminal($)
    const groups = t.buttons.filter((b: any) => [`archive-${keyOf('gA')}`, `archive-${keyOf('gB')}`].includes(String(b.props.key)))
    expect(groups.map((b: any) => String(b.props.key))).toEqual([`archive-${keyOf('gA')}`, `archive-${keyOf('gB')}`])
    expect(groups[0].text).toMatch(/^▼ .* \(2\)$/)
    expect(groups[1].text).toMatch(/^▶︎ .* \(1\)$/)
    expect(groups[0].text).toContain(entryDate(groupA()))
    expect(t.text).toMatch(DATE)
    // no title, done/total or status words anywhere in the Archive
    expect(t.text).not.toMatch(/Flow [AB]|1\/3|1\/1|finished|ended with the session/)
    // the open group starts with its summary right under the fold
    const lines = t.text.split('\n')
    const at = lines.findIndex((l: string) => l.startsWith('▼ '))
    expect(lines[at + 1]).toContain('≈$1.50 · 12k tokens · 30:00')
    expect(t.text).toContain('≈$1.50 · 12k tokens · 30:00')
    expect(t.text).toContain('≈$0.75 · 3k tokens · 1:30')
    expect(t.text).toMatch(/write tests/)
    // the folded group shows only its header
    expect(t.text).not.toMatch(/only task/)
    expect(t.keys.some((k: string) => /finished/.test(k))).toBe(false)

    const d = await desktop($)
    expect(d.svgs.some((s: any) => /Flow [AB]/.test(String(s.props.alt)) || /Flow [AB]/.test(String(s.props.source)))).toBe(false)
    // the open group draws the three tiles of the Active tab; the folded one keeps its dim summary line
    const tiled = d.svgs.filter((s: any) => String(s.props.source).includes('class="tile"'))
    expect(tiled.length).toBe(1)
    expect(String(tiled[0].props.source)).toContain('≈$1.50')
    expect(String(tiled[0].props.source)).not.toContain('≈$0.75')
    const summaries = d.texts.filter((x: any) => /≈\$/.test(String(x.text)))
    expect(summaries.map((x: any) => String(x.text))).toEqual(['  ≈$0.75 · 3k tokens · 1:30'])
    for (const x of summaries) expect(x.props.dimColor).toBe(true)
    expect(d.buttons.find((b: any) => String(b.props.key) === `archive-${keyOf('gA')}`).text).toMatch(/^▼ .* \(2\)$/)
    // (a row's own alt may say its run finished; the group itself never does)
    expect(d.alts.filter((a: string) => /Flow [AB]|1\/3|ended with the session/.test(a))).toEqual([])
    expect(d.buttons.filter((b: any) => [`archive-${keyOf('gA')}`, `archive-${keyOf('gB')}`].includes(String(b.props.key))).some((b: any) => /finished/.test(b.text))).toBe(false)
    expect(d.svgs.filter((s: any) => Number(s.props.height) === 48).length).toBe(2)
    expect(d.alts.some((a: string) => /^only task:/.test(a))).toBe(false)
    expect(d.keys).toContain(`archive-${keyOf('gA')}`)
  })

  test('the open group shows its rows flat, latest completion first, with their final states and stats; no planned task and no Finished toggle', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), groupB()] } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const t = await terminal($)
      expect(t.text).toMatch(/write tests/)
      expect(t.text).toMatch(/wire it/)
      // write tests started first but completed last (2:05 after the start, wire it at 2:03): it is on top
      expect(t.text.indexOf('write tests')).toBeLessThan(t.text.indexOf('wire it'))
      expect(t.text).toMatch(/Done/)
      expect(t.text).toMatch(/Error/)
      expect(t.text).toMatch(/ctx 10% · 100k ≈\$0\.50 5:00/)
      expect(t.text).not.toMatch(/Planned/)
      expect(t.text).not.toMatch(/3\. polish/)
      expect(t.text).not.toMatch(/Finished|Running ·/)
      expect(JSON.stringify(t.buttons)).not.toMatch(/Finished/)
      expect(t.keys.some((k: string) => /finished/.test(k))).toBe(false)
      const d = await desktop($)
      const done = d.svgs.find((s: any) => /^write tests:/.test(String(s.props.alt)))
      const failed = d.svgs.find((s: any) => /^wire it:/.test(String(s.props.alt)))
      expect(String(done?.props.source)).toContain(STATE_COLOR.done)
      expect(String(failed?.props.source)).toContain(STATE_COLOR.error)
      expect(String(done?.props.source)).toContain('5:00')
      const rows = d.alts.filter((a: string) => /^(write tests|wire it):/.test(a))
      expect(rows.map((a: string) => a.split(':')[0])).toEqual(['write tests', 'wire it'])
      expect(d.alts.some((a: string) => /^3\. polish: planned/.test(a))).toBe(false)
      expect(d.svgs.some((s: any) => /Finished/.test(String(s.props.source)) || /Finished/.test(String(s.props.alt)))).toBe(false)
      expect(JSON.stringify(d.buttons)).not.toMatch(/Finished/)
      const p = await pane($, surface)
      expect((await p.findAll({ type: 'Text' })).some((x: any) => /Finished/.test(String(x.text)))).toBe(false)
      await p.unmount()
    }
  })

  test('desktop: a group row has the live layout, the task name natively on line 1 and the drawing below, with no archive icon', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), groupB()] } })
    await start($)
    await settle()
    const kidsOf = (n: any): any[] => (Array.isArray(n?.children) ? n.children : Array.isArray(n?.props?.children) ? n.props.children : []).filter((c: any) => c && typeof c === 'object')
    const walk = (n: any, out: any[] = []): any[] => {
      if (!n || typeof n !== 'object') return out
      out.push(n)
      for (const c of kidsOf(n)) walk(c, out)
      return out
    }
    const keyOfNode = (n: any) => String(n?.props?.key ?? n?.key ?? '')
    const has = (n: any, key: string) => walk(n).some(c => keyOfNode(c) === key)
    const says = (n: any, s: string) => JSON.stringify(n).includes(s)
    const kp = `archive-${keyOf('gA')}-`
    const p = await pane($, 'desktop')
    const root = await p.drawn()
    await p.unmount()
    // line 1: the fold chevron at the far left (every row folds; dim on a row with no step list), the indent that puts the
    // name at the drawing's text column, the name, a spacer and when the row finished at the far end
    for (const [id, name, want] of [
      ['a2', 'wire it', ['chevron', 'indent', 'title', 'spacer', 'time']],
      ['a1', 'write tests', ['chevron', 'indent', 'title', 'spacer', 'time']],
    ] as const) {
      const r = walk(root).find(n => keyOfNode(n) === `${kp}${id}`)
      expect(r?.props?.flexDirection).toBe('column')
      const [first, drawing] = kidsOf(r)
      expect(first?.props?.flexDirection).toBe('row')
      const time = doneText(groupA().agents!.find(a => a.id === id)!.endedAt!, NOW)
      const part = (c: any) =>
        c?.props?.source !== undefined
          ? 'indent'
          : has(c, `${kp}agent-fold-${id}`)
            ? 'chevron'
            : says(c, name)
              ? 'title'
              : c?.props?.flexGrow === 1 && kidsOf(c).length === 0
                ? 'spacer'
                : says(c, time)
                  ? 'time'
                  : kidsOf(c).length === 0
                    ? 'no chevron'
                    : '?'
      const parts = kidsOf(first).flatMap(c => (c?.props?.flexDirection === 'row' ? kidsOf(c) : [c])).map(part)
      expect(parts).toEqual([...want])
      expect(walk(r).some(n => keyOfNode(n).startsWith('archive-item-'))).toBe(false)
      expect(Number(drawing?.props?.height)).toBe(48)
      expect(String(drawing?.props?.alt).startsWith(`${name}:`)).toBe(true)
      expect(String(drawing?.props?.source)).not.toContain(name)
    }
  })

  test('pressing the open newest group folds it and it stays folded; pressing a folded group opens it', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), groupB()] } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, `archive-${keyOf('gA')}`)
      let t = await terminal($)
      expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === `archive-${keyOf('gA')}`))).toContain('▶︎ ')
      expect(t.text).not.toMatch(/write tests/)
      expect(t.text).toContain('≈$1.50 · 12k tokens · 30:00')
      // a re-render keeps the choice
      t = await terminal($)
      expect(t.text).not.toMatch(/write tests/)
      const d = await desktop($)
      expect(d.svgs.filter((s: any) => Number(s.props.height) === 48).length).toBe(0)
      await press($, surface, `archive-${keyOf('gB')}`)
      t = await terminal($)
      expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === `archive-${keyOf('gB')}`))).toContain('▼ ')
      expect(t.text).toMatch(/only task/)
      expect(t.text).not.toMatch(/write tests/)
      expect(t.text).not.toMatch(/Finished/)
      await press($, surface, `archive-${keyOf('gA')}`, `archive-${keyOf('gB')}`)
      t = await terminal($)
      expect(t.text).toMatch(/write tests/)
      expect(t.text).not.toMatch(/only task/)
    }
  })

  test('the fold line shortens at narrow widths: the time of day goes first, the count stays', async ($, on) => {
    const g = { ...groupA(), title: 'T'.repeat(200), status: 'open', done: 17, total: 17, startedAt: groupA().endedAt - 30 * HOUR, agents: Array.from({ length: 17 }, (_, i) => run({ id: `a${i}` })) } as ArchiveEntry
    engine(on, { store: { historyShown: true, history: [g] } })
    await start($)
    await settle()
    // the chevron and its space take 2 columns, the ✕ at the far end 4 more
    const date = (cols: number) => groupLine(recordOf(g, fileOf(g), 0), cols - 6)
    for (const [cols, time] of [[90, true], [30, false], [24, false]] as const) {
      const p = await pane($, 'terminal', cols)
      const texts = await p.findAll({ type: 'Text' })
      const buttons = await p.findAll({ type: 'Button' })
      await p.unmount()
      const fold = buttons.find((b: any) => String(b.props.key) === `archive-${keyOf(g.id)}`)
      expect(fold.text).toBe(`▼ ${date(cols)}`)
      expect(fold.text).toMatch(/ \(17\)$/)
      expect(/\d\d:\d\d/.test(fold.text)).toBe(time)
      expect(fold.text).not.toContain('items')
      expect(JSON.stringify(fold)).toContain('truncate-end')
      expect(texts.some((x: any) => /TTTT|17\/17|ended/.test(String(x.text)))).toBe(false)
    }
    expect(date(90)).toContain('→')
    expect(date(90)).toMatch(/\d\d:\d\d/)
    expect(date(30)).not.toMatch(/\d\d:\d\d/)
  })

  test('with one group it is open', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupB()] } })
    await start($)
    await settle()
    const t = await terminal($)
    expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === `archive-${keyOf('gB')}`))).toContain('▼ ')
    expect(t.text).toMatch(/only task/)
    const d = await desktop($)
    expect(d.alts.some((a: string) => /^only task:/.test(a))).toBe(true)
  })

  test('a group of 60 agents draws flat without overflow', async ($, on) => {
    const agents = Array.from({ length: 60 }, (_, k) => run({ id: `m${k}`, agentId: `m${k}`, description: `task ${k} ${'d'.repeat(150)}`, startedAt: NOW - 2 * HOUR + k * 1000, endedAt: NOW - 2 * HOUR + k * 1000 + MIN }))
    const e = { ...undated(snap(agents)), id: 'gL' } as ArchiveEntry
    engine(on, { store: { historyShown: true, history: [e] } })
    await start($)
    await settle()
    // 60 drawn rows are past the panel's size limit (panel-size.test.tsx): the desktop draws the group's text rows and says so.
    const d = await desktop($)
    expect(d.texts.some((t: any) => /^Archive is drawn as text/.test(String(t.text)))).toBe(true)
    expect(d.svgs.filter((s: any) => /^task \d+ /.test(String(s.props.alt)))).toHaveLength(0)
    const drawnText = d.texts.map((t: any) => String(t.text)).join('\n')
    expect(drawnText.split('d'.repeat(10)).length - 1).toBeGreaterThanOrEqual(60)
    expect(drawnText.indexOf('task 59 ')).toBeLessThan(drawnText.indexOf('task 58 '))
    for (const s of d.svgs) expect(Number(s.props.width)).toBeLessThanOrEqual(900)
    for (const cols of [24, 40, 80]) {
      const p = await pane($, 'terminal', cols)
      const texts = await p.findAll({ type: 'Text' })
      await p.unmount()
      const text = texts.map((x: any) => x.text).join('\n')
      expect(text).not.toContain('NaN')
      expect(text).not.toContain('undefined')
      expect(text).not.toMatch(/Finished/)
      expect(text.split('d'.repeat(10)).length - 1).toBeGreaterThanOrEqual(60) // `task 1 …` may lead with its task's number instead
    }
  })

  test('chevrons and child items work inside a group', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA()] } })
    await start($)
    await settle()
    let t = await terminal($)
    expect(t.keys).toContain(`archive-${keyOf('gA')}-agent-fold-a2`)
    expect(t.text).not.toMatch(/patch it/)
    await press($, 'terminal', `archive-${keyOf('gA')}-agent-fold-a2`)
    t = await terminal($)
    expect(t.text).toMatch(/read code\s+1m 0s/)
    expect(t.text).toMatch(/patch it/)
    const d = await desktop($)
    const kids = d.svgs.filter((s: any) => Number(s.props.height) === 22)
    expect(kids.length).toBe(2)
    expect(String(kids[1].props.alt)).toMatch(/^patch it: Error/)
  })

  test('an entry saved without agents shows its tasks when open: Accepted · Orchestrator rows and queued rows', async ($, on) => {
    const old = { id: 'old', project: '/work/app', title: 'Old flow', startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, status: 'open', done: 1, total: 2, tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }], cost: 1.5, tokens: 12_000, time: 30 * MIN }
    engine(on, { store: { historyShown: true, history: [old] } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      let t = await terminal($)
      expect(t.text).not.toContain('ended with the session')
      expect(t.text).toMatch(/^▼ .* \(2\)$/m)
      expect(t.text).toContain('≈$1.50 · 12k tokens · 30:00')
      expect(t.text).toMatch(/✓ {3}1\. write tests/)
      expect(t.text).toMatch(/careful · Accepted · Orchestrator/)
      expect(t.text).toMatch(/2\. wire it ◷/)
      expect(t.keys).not.toContain('archive-finished-old')
      await press($, surface, `archive-${keyOf('old')}`)
      t = await terminal($)
      expect(t.text).not.toMatch(/write tests/)
      await press($, surface, `archive-${keyOf('old')}`)
    }
  })

  test('a run saved while still running keeps its status and reads Running at finish in blue-violet, its time fixed', async ($, on) => {
    const e = { ...undated(snap([run({ status: 'running', endedAt: undefined, startedAt: NOW - HOUR - 2 * MIN })])), id: 'gR' }
    expect(e.agents![0]!.status).toBe('running')
    const { clock } = engine(on, { store: { historyShown: true, history: [e] } })
    await start($)
    await settle()
    let t = await terminal($)
    expect(t.text).toMatch(/Running at finish/)
    expect(t.text).toMatch(/2:00/)
    expect(t.text).not.toMatch(/Error/)
    clock.now = NOW + HOUR
    t = await terminal($)
    expect(t.text).toMatch(/2:00/)
    const d = await desktop($)
    const row = d.svgs.find((s: any) => /^write tests:/.test(String(s.props.alt)))
    expect(String(row?.props.source)).toContain('Running at finish')
    expect(String(row?.props.source)).toContain(`fill="${STATE_COLOR.running}"`)
    expect(String(row?.props.source)).toContain('2:00')
    expect(String(row?.props.source)).not.toContain(STATE_COLOR.error)
  })

  test('a flow finished while a worker still runs saves the run as running, ended at the save, and the group draws it Running at finish', async ($, on) => {
    const { store, clock } = engine(on, { store: { historyShown: true } })
    laterDay(on) // the flow finished today is looked at in the Archive as on a later day (tabs.ts)
    await start($)
    await progress($, { title: 'Live one', total: 1, done: 0, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }] })
    clock.now = NOW + 1000
    await $.agent.spawn({ subagentType: 'flowdeck-careful', description: 'write tests', tool_use_id: 'w1' } as any)
    clock.now = NOW + 61_000
    await progress($, { finished: true })
    const saved = (store.history as any[])[0]
    expect(saved.agents.map((a: any) => [a.id, a.status, a.endedAt])).toEqual([['w1', 'running', NOW + 61_000]])
    const t = await terminal($)
    expect(t.text).toMatch(/Running at finish/)
    expect(t.text).toMatch(/1:00/)
  })

  test('folding a row in a group folds only that group’s row, never the same agent in another group or the live panel', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), { ...groupA(), id: 'gC', title: 'Flow C' }] } })
    await start($)
    await settle()
    // a live run with the same id as the groups' a2, with its own steps (one row's line counts once as `✗ patch it`)
    await progress($, { title: 'Live', total: 1, done: 0, phase: 'delegate', tasks: [{ title: 'wire it', tier: 'medium' }] })
    await $.agent.spawn({ subagentType: 'flowdeck-medium', description: 'wire it', tool_use_id: 'a2' } as any)
    await $.tool.call({ tool: 'mcp__flowdeck__step', agentId: 'a2', steps: [{ title: 'live one' }, { title: 'live two' }] } as any)
    await press($, 'terminal', `archive-${keyOf('gC')}`, `archive-${keyOf('gA')}-agent-fold-a2`)
    const count = (text: string, word: string) => text.split(word).length - 1
    let t = await terminal($)
    expect(count(t.text, '✗ patch it')).toBe(1)
    // the live row's second step shows only when that row is unfolded
    expect(t.text).not.toMatch(/live two/)
    const label = (key: string) => String(t.buttons.find((b: any) => String(b.props.key) === key)?.props.label)
    expect(label(`archive-${keyOf('gA')}-agent-fold-a2`)).toBe('▼')
    expect(label(`archive-${keyOf('gC')}-agent-fold-a2`)).toBe('▶︎')
    expect(t.keys).not.toContain('agent-fold-a2')
    // the live row is on the Active tab, folded
    const live = await terminal($, 'active')
    expect(live.text).not.toMatch(/live two|patch it/)
    expect(String(live.buttons.find((b: any) => String(b.props.key) === 'agent-fold-a2')?.props.label)).toBe('▶︎')
    await pressOn($, 'active', 'terminal', 'agent-fold-a2')
    expect((await terminal($, 'active')).text).toMatch(/live two/)
    t = await terminal($)
    expect(count(t.text, '✗ patch it')).toBe(1)
    expect(label(`archive-${keyOf('gC')}-agent-fold-a2`)).toBe('▶︎')
  })

  test('52 groups show the newest 50 and Show more reveals the rest', async ($, on) => {
    // g0 ended last, g51 first
    const many = Array.from({ length: 52 }, (_, i) => ({ ...groupB(), id: `g${i}`, title: `Group ${i}`, endedAt: groupB().endedAt - i * MIN }))
    engine(on, { store: { historyShown: true, history: many } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const shown = (await p.findAll({ type: 'Button' })).filter((b: any) => /^archive-k[a-z0-9]+$/.test(String(b.props.key)))
      expect(shown.map((b: any) => String(b.props.key))).toEqual(many.slice(0, 50).map(e => `archive-${keyOf(e.id)}`))
      const more = await p.find({ type: 'Button', key: 'archive-more' })
      expect(String(more?.props.label)).toBe('Show more (2)')
      await p.unmount()
    }
    await press($, 'terminal', 'archive-more')
    const t = await terminal($)
    const groups = t.buttons.filter((b: any) => /^archive-k[a-z0-9]+$/.test(String(b.props.key)))
    expect(groups.length).toBe(52)
    expect(t.keys).not.toContain('archive-more')
    // the newest is still the only group open by default
    expect(groups.map((b: any) => (JSON.stringify(b).includes('▼ ') ? 'open' : 'folded'))).toEqual(['open', ...Array(51).fill('folded')])
    expect(t.text.split('only task').length - 1).toBe(1)
  })

  test('a flow finished through finishFlow is saved with its agents and appears as a group', async ($, on) => {
    const { store, clock } = engine(on, { store: { historyShown: true } })
    laterDay(on) // the flow finished today is looked at in the Archive as on a later day (tabs.ts)
    await start($)
    await progress($, { title: 'Live one', total: 2, done: 0, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })
    clock.now = NOW + 1000
    await $.agent.spawn({ subagentType: 'flowdeck-careful', description: 'write tests', tool_use_id: 'w1' } as any)
    clock.now = NOW + 61_000
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    await progress($, { finished: true })
    const saved = (store.history as any[])[0]
    expect(saved.title).toBe('Live one')
    expect(saved.agents.map((a: any) => [a.id, a.status, a.endedAt])).toEqual([['w1', 'done', NOW + 61_000]])
    expect(saved.tasks[1]).toEqual({ title: 'wire it', tier: 'medium', after: [] })
    const id = saved.id
    const t = await terminal($)
    expect(t.keys).not.toContain(`archive-finished-${id}`)
    expect(t.text).toMatch(/write tests/)
    // the unstarted task is not drawn: the Archive holds finished work only
    expect(t.text).not.toMatch(/2\. wire it/)
    expect(t.keys).toContain(`archive-${keyOf(id)}`)
  })

  test('keyOf makes a short, stable key of any id', () => {
    const ids = ['1792904027277-/Users/me/work/project/', '1792904027277-/Users/me/work/project', 'gA', '', 'a b/c_d', 'café über 日本', '1-/work/app', '2-/work/app']
    const keys = ids.map(keyOf)
    for (const k of keys) expect(k).toMatch(/^k[a-z0-9]+$/)
    for (const k of keys) expect(k).not.toMatch(/[/_\s]|[^\x00-\x7f]/)
    expect(ids.map(keyOf)).toEqual(keys)
    expect(new Set(keys).size).toBe(ids.length)
    expect(keyOf('gA')).toBe(keyOf('g' + 'A'))
    expect(keys.every(k => k.length <= 12)).toBe(true)
  })

  test('an entry id with a path and spaces gives every Button a safe key, and its fold still toggles', async ($, on) => {
    const odd = { ...groupA(), id: '1792904027277-/Users/me/www/my app/' } as ArchiveEntry
    const other = { ...groupB(), id: '1700000000000-/Users/me/other proj/' } as ArchiveEntry
    engine(on, { store: { historyShown: true, history: [odd, other] } })
    await start($)
    await settle()
    const SAFE = /^[A-Za-z0-9_-]+$/
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const keys = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))
      await p.unmount()
      expect(keys).toContain(`archive-${keyOf(odd.id)}`)
      expect(keys).toContain(`archive-${keyOf(other.id)}`)
      expect(keys).toContain(`archive-${keyOf(odd.id)}-agent-fold-a2`)
      for (const k of keys) expect(k).toMatch(SAFE)
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, `archive-${keyOf(other.id)}`)
      let t = await terminal($)
      expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === `archive-${keyOf(other.id)}`))).toContain('▼ ')
      expect(t.text).toMatch(/only task/)
      await press($, surface, `archive-${keyOf(other.id)}`)
      t = await terminal($)
      expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === `archive-${keyOf(other.id)}`))).toContain('▶︎ ')
      expect(t.text).not.toMatch(/only task/)
    }
  })
})
