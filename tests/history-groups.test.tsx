import { describe, expect, test } from 'claude-code/testing'

import { addEntry, entryDate, formatEntry, MAX_AGENTS, MAX_HISTORY_CHARS, parseHistory, snapshot, splitBySize } from '../hooks/history'
import { STATE_COLOR } from '../hooks/plan-view'
import type { AgentRun, Flow, HistoryEntry } from '../types'

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

describe('history entries hold the flow', () => {
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

  test('parseHistory: old entries without agents load as they are, and the new fields survive a round trip', () => {
    const old = { id: 'old', project: '/work/app', title: 'Old', startedAt: 1, endedAt: 2, status: 'finished', done: 1, total: 2, tasks: [{ title: 'a', tier: 'light' }], cost: 1, tokens: 2, time: 3 }
    const [o] = parseHistory([old])
    expect(o!.agents).toBeUndefined()
    expect(o!.tasks).toEqual([{ title: 'a', tier: 'light' }])
    const e = snap([run({ items: [{ title: 'one', status: 'active', startedAt: 5 }] }), run({ id: 'a2', agentId: undefined, effort: undefined, status: 'failed', stepDone: 1, stepTotal: 3, stepNote: 'two' })])
    expect(parseHistory(JSON.parse(JSON.stringify([e, old])))).toEqual([e, o!])
  })

  test('parseHistory drops broken agents and bad after numbers, keeps the entry', () => {
    const e = snap([run()])
    const raw = JSON.parse(JSON.stringify(e))
    raw.agents.push(null, 7, { id: 'x' }, { ...raw.agents[0], id: 'bad-status', status: 'weird' }, { ...raw.agents[0], id: 'bad-start', startedAt: 'soon' })
    raw.tasks[1].after = [1, 'two', -3, 2.5, 3]
    raw.tasks[2].after = 'nope'
    const [p] = parseHistory([raw, 'junk'])
    expect(p!.agents!.map(a => a.id)).toEqual(['a1'])
    expect(p!.tasks[1]!.after).toEqual([1, 3])
    expect(p!.tasks[2]!.after).toBeUndefined()
    const [noList] = parseHistory([{ ...raw, agents: 'nope' }])
    expect(noList!.agents).toBeUndefined()
  })
})

describe('history is never cut', () => {
  const big = (i: number): HistoryEntry => {
    const items = Array.from({ length: 12 }, (_, k) => ({ title: `item ${k} ${'y'.repeat(40)}`, status: 'done' as const, startedAt: k, doneAt: k + 1 }))
    const agents = Array.from({ length: 60 }, (_, k) => run({ id: `e${i}-r${k}`, startedAt: NOW + k, description: 'd'.repeat(200), stepNote: 'n'.repeat(200), items }))
    return snap(agents, { startedAt: NOW + i * MIN, endedAt: NOW + i * MIN + 1 })
  }

  test('addEntry keeps every flow: no cap on the count', () => {
    let h: HistoryEntry[] = []
    for (let i = 0; i < 120; i++) h = addEntry(h, snap([run()], { startedAt: NOW + i, endedAt: NOW + i + 1 }))
    expect(h.length).toBe(120)
    expect(h[0]!.startedAt).toBe(NOW + 119)
  })

  test('splitBySize keeps the newest under 3,000,000 characters and returns the rest as overflow', () => {
    const base = big(0)
    const list = Array.from({ length: 400 }, (_, i) => ({ ...base, id: `big-${399 - i}`, startedAt: NOW + (399 - i) * MIN })) // newest first
    const { kept, overflow } = splitBySize(list, MAX_HISTORY_CHARS)
    expect(MAX_HISTORY_CHARS).toBe(3_000_000)
    expect(JSON.stringify(kept).length).toBeLessThan(3_000_000)
    expect(kept.length).toBeGreaterThan(0)
    expect(overflow.length).toBeGreaterThan(0)
    expect(kept[0]!.id).toBe(list[0]!.id)
    expect([...kept, ...overflow].map(e => e.id)).toEqual(list.map(e => e.id))
    // one more would pass the limit
    expect(JSON.stringify([...kept, overflow[0]]).length).toBeGreaterThanOrEqual(3_000_000)
    const small = splitBySize(list.slice(0, 2), MAX_HISTORY_CHARS)
    expect(small.kept.length).toBe(2)
    expect(small.overflow).toEqual([])
  })

  test('addEntry on a history past the limit still keeps everything', () => {
    const base = big(0)
    const list = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `big-${29 - i}` }))
    const next = addEntry(list, { ...base, id: 'big-30' })
    expect(next.length).toBe(31)
    expect(JSON.stringify(next).length).toBeGreaterThan(3_000_000)
  })
})

describe('the group date', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi)
  const e = (startedAt: number, endedAt: number, status: 'finished' | 'open' = 'finished') => ({ ...snap([]), startedAt, endedAt, status }) as HistoryEntry

  test('same day: the end date and time', () => {
    expect(entryDate(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), 'UTC')).toBe('Oct 26, 2026 · 10:42 AM')
    expect(entryDate(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 22, 5)), 'UTC')).toBe('Oct 26, 2026 · 10:05 PM')
    expect(entryDate(e(at(2026, 10, 26, 0, 1), at(2026, 10, 26, 0, 30)), 'UTC')).toBe('Oct 26, 2026 · 12:30 AM')
  })

  test('a flow that started on an earlier day shows the range', () => {
    expect(entryDate(e(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 10, 42)), 'UTC')).toBe('Oct 25 → Oct 26, 2026 · 10:42 AM')
  })

  test('across the year boundary both dates carry their year', () => {
    expect(entryDate(e(at(2025, 12, 31, 23, 0), at(2026, 1, 1, 0, 30)), 'UTC')).toBe('Dec 31, 2025 → Jan 1, 2026 · 12:30 AM')
  })

  test('the day is the time zone’s day', () => {
    // 23:00 UTC on Oct 25 is already Oct 26 in Kolkata, the same day as the end
    expect(entryDate(e(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 5, 0)), 'Asia/Kolkata')).toBe('Oct 26, 2026 · 10:30 AM')
    expect(entryDate(e(at(2026, 10, 25, 23, 0), at(2026, 10, 26, 5, 0)), 'UTC')).toBe('Oct 25 → Oct 26, 2026 · 5:00 AM')
  })

  test('formatEntry: title, the short line with date, done/total and status, the task lines', () => {
    const f = formatEntry(e(at(2026, 10, 26, 9, 0), at(2026, 10, 26, 10, 42)), 'UTC')
    expect(f.head).toBe('Ship it')
    expect(f.line).toBe('Oct 26, 2026 · 10:42 AM · 2/3 · finished')
    expect(f.lines).toEqual(['✓ write tests (careful)', '✓ wire it (medium)', '○ polish (light)'])
    const open = formatEntry(e(at(2026, 10, 25, 9, 0), at(2026, 10, 26, 10, 42), 'open'), 'UTC')
    expect(open.line).toBe('Oct 25 → Oct 26, 2026 · 10:42 AM · 2/3 · ended with the session')
    expect(formatEntry({ ...e(1, 2), title: '  ' }, 'UTC').head).toBe('Untitled flow')
  })
})

// --- in the panel (no fs hook: the shared-store fallback, as in panel-history)

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
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const press = async ($: any, surface: 'terminal' | 'desktop', ...keys: string[]) => {
  for (const key of keys) {
    const p = await pane($, surface)
    await p.press({ key })
    await settle()
    await p.unmount()
  }
}
const terminal = async ($: any) => {
  const p = await pane($, 'terminal')
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { text: texts.map((t: any) => t.text).join('\n'), texts, buttons, keys: buttons.map((b: any) => String(b.props.key)) }
}
const desktop = async ($: any) => {
  const p = await pane($, 'desktop')
  const svgs = await p.findAll({ type: 'Svg' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { svgs, buttons, keys: buttons.map((b: any) => String(b.props.key)), alts: svgs.map((s: any) => String(s.props.alt ?? '')) }
}

// Two saved flows with their agents: the newer one has a done run, a failed run with items and an unstarted task.
const groupA = (): HistoryEntry =>
  ({
    ...snap(
      [
        run(),
        run({ id: 'a2', agentId: 'a2', description: 'wire it', type: 'flowdeck-medium', status: 'failed', startedAt: NOW - 2 * HOUR + MIN, endedAt: NOW - 2 * HOUR + 3 * MIN, tokens: 8000, costUsd: 0.25, items: [{ title: 'read code', status: 'done', startedAt: NOW - 2 * HOUR + MIN, doneAt: NOW - 2 * HOUR + 2 * MIN }, { title: 'patch it', status: 'error', startedAt: NOW - 2 * HOUR + 2 * MIN, doneAt: NOW - 2 * HOUR + 3 * MIN }] }),
      ],
      { flow: flow({ title: 'Flow A', done: 1 }) },
    ),
    id: 'gA',
    cost: 1.5,
    tokens: 12_000,
    time: 30 * MIN,
  }) as HistoryEntry
const groupB = (): HistoryEntry =>
  ({
    ...snap([run({ id: 'b1', agentId: 'b1', description: 'only task' })], { flow: flow({ title: 'Flow B', tasks: [{ title: 'only task', tier: 'careful', after: [] }], total: 1, done: 1 }), startedAt: NOW - 30 * HOUR, endedAt: NOW - 25 * HOUR }),
    id: 'gB',
    cost: 0.75,
    tokens: 3_000,
    time: 90_000,
  }) as HistoryEntry
const DATE = /[A-Z][a-z]{2} \d{1,2}.*, \d{4} · \d{1,2}:\d{2} [AP]M/

describe('history groups in the panel', () => {
  test('two groups show titles, dates and the three tiles, folded by default', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), groupB()] } })
    await start($)
    await settle()
    const t = await terminal($)
    const groups = t.buttons.filter((b: any) => /^history-g/.test(String(b.props.key)))
    expect(groups.map((b: any) => String(b.props.key))).toEqual(['history-gA', 'history-gB'])
    expect(JSON.stringify(groups[0])).toContain('▸ Flow A')
    expect(JSON.stringify(groups[0])).toContain(`${entryDate(groupA())} · 1/3 · finished`)
    expect(JSON.stringify(groups[1])).toContain(`${entryDate(groupB())} · 1/1 · finished`)
    expect(JSON.stringify(groups[0])).toMatch(DATE)
    expect(t.text).toContain('≈$1.50 · 12k tokens · 30:00')
    expect(t.text).toContain('≈$0.75 · 3k tokens · 1:30')
    expect(t.text).not.toMatch(/write tests/)
    expect(t.keys.some((k: string) => /finished/.test(k))).toBe(false)

    const d = await desktop($)
    const headers = d.svgs.filter((s: any) => Number(s.props.height) === 72 && /Flow [AB]/.test(String(s.props.alt)))
    expect(headers.length).toBe(2)
    expect(String(headers[0].props.source)).toContain('≈$1.50')
    expect(String(headers[0].props.source)).toContain('12k')
    expect(String(headers[0].props.source)).toContain('30:00')
    expect(String(headers[1].props.source)).toContain('1:30')
    expect(d.svgs.filter((s: any) => Number(s.props.height) === 66).length).toBe(0)
    expect(d.keys).toContain('history-gA')
  })

  test('opening a group shows Finished · N collapsed, then the rows with their final states and stats, and the unstarted task', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA(), groupB()] } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, 'history-gA')
      let t = await terminal($)
      const fin = t.buttons.find((b: any) => String(b.props.key) === 'history-finished-gA')
      expect(String(fin?.props.label)).toBe('▸ Finished · 2')
      expect(t.text).not.toMatch(/write tests/)
      expect(t.text).toMatch(/Planned · 1/)
      expect(t.text).toMatch(/3\. polish/)
      await press($, surface, 'history-finished-gA')
      t = await terminal($)
      expect(String(t.buttons.find((b: any) => String(b.props.key) === 'history-finished-gA')?.props.label)).toBe('▾ Finished · 2')
      expect(t.text).toMatch(/write tests/)
      expect(t.text).toMatch(/wire it/)
      expect(t.text).toMatch(/Done/)
      expect(t.text).toMatch(/Error/)
      expect(t.text).toMatch(/ctx 10% · 100k ≈\$0\.50 5:00/)
      const d = await desktop($)
      const done = d.svgs.find((s: any) => /^write tests:/.test(String(s.props.alt)))
      const failed = d.svgs.find((s: any) => /^wire it:/.test(String(s.props.alt)))
      expect(String(done?.props.source)).toContain(STATE_COLOR.done)
      expect(String(failed?.props.source)).toContain(STATE_COLOR.error)
      expect(String(done?.props.source)).toContain('5:00')
      expect(d.alts.some((a: string) => /^3\. polish: planned/.test(a))).toBe(true)
      // the other group stays folded
      expect(t.keys).not.toContain('history-finished-gB')
      await press($, surface, 'history-finished-gA', 'history-gA')
      t = await terminal($)
      expect(t.text).not.toMatch(/write tests/)
    }
  })

  test('chevrons and child items work inside a group', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [groupA()] } })
    await start($)
    await settle()
    await press($, 'terminal', 'history-gA', 'history-finished-gA')
    let t = await terminal($)
    expect(t.keys).toContain('history-gA-agent-fold-a2')
    expect(t.text).not.toMatch(/patch it/)
    await press($, 'terminal', 'history-gA-agent-fold-a2')
    t = await terminal($)
    expect(t.text).toMatch(/read code\s+1m 0s/)
    expect(t.text).toMatch(/patch it/)
    const d = await desktop($)
    const kids = d.svgs.filter((s: any) => Number(s.props.height) === 22)
    expect(kids.length).toBe(2)
    expect(String(kids[1].props.alt)).toMatch(/^patch it: Error/)
  })

  test('an entry saved without agents shows its task list when opened', async ($, on) => {
    const old = { id: 'old', project: '/work/app', title: 'Old flow', startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, status: 'open', done: 1, total: 2, tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }], cost: 1.5, tokens: 12_000, time: 30 * MIN }
    engine(on, { store: { historyShown: true, history: [old] } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      let t = await terminal($)
      expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === 'history-old'))).toContain('ended with the session')
      expect(t.text).toContain('≈$1.50 · 12k tokens · 30:00')
      expect(t.text).not.toMatch(/write tests/)
      await press($, surface, 'history-old')
      t = await terminal($)
      expect(t.text).toMatch(/✓ write tests \(careful\)/)
      expect(t.text).toMatch(/○ wire it \(medium\)/)
      expect(t.keys).not.toContain('history-finished-old')
      await press($, surface, 'history-old')
    }
  })

  test('a run saved while still running reads as ended: Error, its time fixed', async ($, on) => {
    const e = { ...snap([run({ status: 'running', endedAt: undefined, startedAt: NOW - HOUR - 2 * MIN })]), id: 'gR' }
    const { clock } = engine(on, { store: { historyShown: true, history: [e] } })
    await start($)
    await settle()
    await press($, 'terminal', 'history-gR', 'history-finished-gR')
    let t = await terminal($)
    expect(t.text).toMatch(/Error/)
    expect(t.text).toMatch(/2:00/)
    expect(t.text).not.toMatch(/Running/)
    clock.now = NOW + HOUR
    t = await terminal($)
    expect(t.text).toMatch(/2:00/)
  })

  test('twelve groups show the newest ten and Show older reveals the rest', async ($, on) => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...groupB(), id: `g${i}`, title: `Group ${i}` }))
    engine(on, { store: { historyShown: true, history: many } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      expect((await p.findAll({ type: 'Button' })).filter((b: any) => /^history-g\d+$/.test(String(b.props.key))).length).toBe(10)
      const more = await p.find({ type: 'Button', key: 'history-more' })
      expect(String(more?.props.label)).toBe('Show older (2)')
      await p.unmount()
    }
    await press($, 'terminal', 'history-more')
    const t = await terminal($)
    expect(t.buttons.filter((b: any) => /^history-g\d+$/.test(String(b.props.key))).length).toBe(12)
    expect(t.keys).not.toContain('history-more')
  })

  test('a flow finished through finishFlow is saved with its agents and appears as a group', async ($, on) => {
    const { store, clock } = engine(on, { store: { historyShown: true } })
    await start($)
    await progress($, { title: 'Live one', total: 2, done: 0, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })
    clock.now = NOW + 1000
    await $.agent.spawn({ subagentType: 'flowdeck-careful', description: 'write tests', tool_use_id: 'w1' } as any)
    clock.now = NOW + 61_000
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    await press($, 'terminal', 'flow-finish')
    const saved = (store.history as any[])[0]
    expect(saved.title).toBe('Live one')
    expect(saved.agents.map((a: any) => [a.id, a.status, a.endedAt])).toEqual([['w1', 'done', NOW + 61_000]])
    expect(saved.tasks[1]).toEqual({ title: 'wire it', tier: 'medium', after: [] })
    const id = saved.id
    await press($, 'terminal', `history-${id}`, `history-finished-${id}`)
    const t = await terminal($)
    expect(String(t.buttons.find((b: any) => String(b.props.key) === `history-finished-${id}`)?.props.label)).toBe('▾ Finished · 1')
    expect(t.text).toMatch(/2\. wire it/)
    expect(t.keys).toContain(`history-${id}`)
  })
})
