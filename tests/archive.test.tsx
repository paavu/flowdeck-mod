import { describe, expect, test } from 'claude-code/testing'

import { addEntry, formatEntry, isWorthKeeping, parseArchive, snapshot } from '../hooks/archive'
import type { AgentRun, Flow, ArchiveEntry } from '../types'

const MIN = 60_000
const START = Date.UTC(2026, 9, 25, 10, 0)
const END = START + 30 * MIN

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

const flow = (over: Partial<Flow> = {}): Flow => ({
  title: 'Ship it',
  total: 3,
  done: 2,
  running: 1,
  phase: 'delegate',
  isFinished: false,
  isLinked: true,
  tasks: [
    { title: 'Write tests', tier: 'light', after: [] },
    { title: 'Build module', tier: 'medium', after: [1] },
    { title: 'Review', tier: 'heavy', after: [2] },
  ],
  ...over,
})

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'a',
  type: 'flowdeck-light',
  description: 'x',
  model: 'opus',
  status: 'done',
  startedAt: START,
  endedAt: START + 5 * MIN,
  contextTokens: 0,
  contextMax: 1,
  tokens: 20_000,
  costUsd: 0.5,
  steps: 0,
  round: 1,
  ...over,
})

const agents = [run(), run({ id: 'b', startedAt: START + 5 * MIN, endedAt: undefined, tokens: 25_000, costUsd: 0.7 })]
const snap = (over: Partial<Parameters<typeof snapshot>[0]> = {}) =>
  snapshot({ flow: flow(), agents, project: '/Users/me/proj', startedAt: START, endedAt: END, status: 'finished', ...over })

const entry = (i: number, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  ...snap({ startedAt: START + i, endedAt: END + i }),
  ...over,
})

describe('snapshot', () => {
  test('sums cost, tokens and time; a running agent counts up to the end', () => {
    const e = snap()
    expect(near(e.cost, 1.2, 1e-9)).toBe(true)
    expect(e.tokens).toBe(45_000)
    expect(e.time).toBe(5 * MIN + 25 * MIN)
    expect(e.status).toBe('finished')
    expect(e.done).toBe(2)
    expect(e.total).toBe(3)
    expect(e.tasks).toEqual([
      { title: 'Write tests', tier: 'light', after: [] },
      { title: 'Build module', tier: 'medium', after: [1] },
      { title: 'Review', tier: 'heavy', after: [2] },
    ])
    expect(e.project).toBe('/Users/me/proj')
    expect(snap({ status: 'open' }).status).toBe('open')
  })

  test('a run that ends before it starts adds no time', () => {
    const e = snap({ agents: [run({ endedAt: START - MIN })] })
    expect(e.time).toBe(0)
  })

  test('the id is stable across snapshots of the same flow', () => {
    const a = snap({ endedAt: END })
    const b = snap({ endedAt: END + MIN, status: 'open' })
    expect(a.id).toBe(`${START}-/Users/me/proj`)
    expect(b.id).toBe(a.id)
  })
})

describe('isWorthKeeping', () => {
  test('an empty flow is not kept', () => {
    const e = snap({ flow: flow({ tasks: [], total: 0, done: 0 }), agents: [] })
    expect(isWorthKeeping(e)).toBe(false)
  })

  test('tasks, done tasks or agent spend make it worth keeping', () => {
    expect(isWorthKeeping(snap())).toBe(true)
    expect(isWorthKeeping(snap({ agents: [] }))).toBe(true)
    expect(isWorthKeeping(snap({ flow: flow({ tasks: [], total: 0, done: 0 }) }))).toBe(true)
    expect(isWorthKeeping(snap({ flow: flow({ tasks: [], total: 1, done: 1 }), agents: [] }))).toBe(true)
  })
})

describe('addEntry', () => {
  test('newest first', () => {
    const h = addEntry(addEntry([], entry(1)), entry(2))
    expect(h.map(e => e.id)).toEqual([entry(2).id, entry(1).id])
  })

  test('a later snapshot of the same flow replaces it and moves to where its later end puts it, the front', () => {
    const h = [entry(3), entry(2), entry(1)]
    const next = addEntry(h, entry(1, { status: 'open', done: 3, endedAt: END + 10 }))
    expect(next.map(e => e.id)).toEqual([entry(1).id, entry(3).id, entry(2).id])
    expect(next[0]!.done).toBe(3)
    expect(next.length).toBe(3)
    // a snapshot that ends no later stays where its end puts it
    const same = addEntry(h, entry(1, { done: 0 }))
    expect(same.map(e => e.id)).toEqual([entry(3).id, entry(2).id, entry(1).id])
    expect(same[2]!.done).toBe(0)
  })

  test('never drops an entry', () => {
    let h: ArchiveEntry[] = []
    for (let i = 0; i < 60; i++) h = addEntry(h, entry(i))
    expect(h.length).toBe(60)
    expect(h[0]!.id).toBe(entry(59).id)
    expect(h.at(-1)!.id).toBe(entry(0).id)
  })

  test('never mutates the input', () => {
    const h = [entry(2), entry(1)]
    const copy = JSON.parse(JSON.stringify(h))
    addEntry(h, entry(1, { done: 0 }))
    addEntry(h, entry(9))
    expect(h).toEqual(copy)
  })

  test('ignores an empty entry', () => {
    const h = [entry(1)]
    const empty = snap({ flow: flow({ tasks: [], total: 0, done: 0 }), agents: [], startedAt: START + 7 })
    expect(addEntry(h, empty)).toEqual(h)
  })
})

describe('parseArchive', () => {
  test('anything that is not an array gives an empty archive', () => {
    expect(parseArchive(null)).toEqual([])
    expect(parseArchive('nope')).toEqual([])
    expect(parseArchive({ a: 1 })).toEqual([])
    expect(parseArchive(undefined)).toEqual([])
  })

  test('drops bad items and keeps good ones', () => {
    const good = entry(1)
    const out = parseArchive([null, 4, { id: 'x' }, { ...good, status: 'weird' }, good])
    expect(out).toEqual([good])
  })

  test('clamps numbers, caps task lists, trims and caps strings', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({ title: `t${i}`, tier: 'light' }))
    const raw = { ...entry(1), cost: -3, tokens: -1, time: -5, title: `  ${'x'.repeat(300)}  `, project: '  /p  ', tasks }
    const [e] = parseArchive(JSON.parse(JSON.stringify([raw])))
    expect(e!.cost).toBe(0)
    expect(e!.tokens).toBe(0)
    expect(e!.time).toBe(0)
    expect(e!.tasks.length).toBe(100)
    expect(e!.title.length).toBe(200)
    expect(e!.project).toBe('/p')
  })

  test('a round trip through JSON gives the same archive', () => {
    const h = [entry(2), entry(1)]
    expect(parseArchive(JSON.parse(JSON.stringify(h)))).toEqual(h)
  })
})

describe('formatEntry', () => {
  test('a finished flow', () => {
    const f = formatEntry(snap({ flow: flow({ done: 3 }) }), 'UTC')
    expect(f.head).toBe('Ship it')
    expect(f.line).toBe('Oct 25, 2026 · 10:30 · 3/3 · finished')
    expect(f.lines).toEqual(['✓ Write tests (light)', '✓ Build module (medium)', '✓ Review (heavy)'])
  })

  test('an open flow marks the first done tasks and says it ended with the session', () => {
    const f = formatEntry(snap({ status: 'open' }), 'UTC')
    expect(f.head).toBe('Ship it')
    expect(f.line).toBe('Oct 25, 2026 · 10:30 · 2/3 · ended with the session')
    expect(f.lines).toEqual(['✓ Write tests (light)', '✓ Build module (medium)', '○ Review (heavy)'])
  })

  test('an entry from an earlier year always shows its year', () => {
    const old = Date.UTC(2025, 11, 31, 23, 0)
    const e = snap({ startedAt: old - 30 * MIN, endedAt: old })
    expect(formatEntry(e, 'UTC').line).toBe('Dec 31, 2025 · 23:00 · 2/3 · finished')
  })

  test('an empty title still reads', () => {
    const f = formatEntry(snap({ flow: flow({ title: '   ' }) }), 'UTC')
    expect(f.head).toBe('Untitled flow')
  })

  test('time is the span of the runs, not their sum, so parallel runs match the panel header', () => {
    const run = (id: string, startedAt: number, endedAt: number) => ({ id, type: 'flowdeck-light', description: id, model: 'opus', status: 'done', startedAt, endedAt, contextTokens: 0, contextMax: 1, tokens: 0, costUsd: 0, steps: 0, round: 1 }) as any
    const flow = { title: 'T', total: 2, done: 2, running: 0, phase: 'close', isFinished: true, isLinked: true, tasks: [{ title: 'a', tier: 'light', after: [] }] } as any
    const e = snapshot({ flow, agents: [run('a', 1000, 61_000), run('b', 1000, 61_000)], project: '/p', startedAt: 1000, endedAt: 61_000, status: 'finished' })
    expect(e.time).toBe(60_000)
  })
})
