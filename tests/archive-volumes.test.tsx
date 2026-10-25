import { describe, expect, test } from 'claude-code/testing'

import { byteLength, mergeEntries, parseIndex, placeByEnd, rotate, spanText, summarize, withoutCopies, WRITE_MAX } from '../hooks/archive'
import type { ArchiveEntry } from '../types'
import { ENGINE_MAX, fakeFs, utf8 } from './fake-fs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const DIR = '/work/app/.claude/flowdeck'
const WARNING = 'history.json could not be read; showing recovered entries (the file is untouched)'
const HISTORY = `${DIR}/history.json`
const INDEX = `${DIR}/history-index.json`
const vol = (n: number) => `${DIR}/history-${n}.json`
const LIMIT = 2000

// e1 is the newest, a day before NOW; each next one a day older.
const entry = (i: number, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  id: `e${i}`,
  project: '/work/app',
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
const seed = (n: number, from = 1): ArchiveEntry[] => Array.from({ length: n }, (_, k) => entry(from + k))
const size = (list: unknown) => JSON.stringify(list).length
// The most entries whose file stays under the limit, so one more flow makes the save rotate.
const FULL = (() => {
  let n = 1
  while (size(seed(n + 1)) < LIMIT) n++
  return n
})()

// --- pure

describe('rotation, pure', () => {
  test('over the limit keeps the newest within half of it and cuts the rest into volumes, oldest first, each under the limit', () => {
    const list = seed(20)
    const { kept, volumes } = rotate(list, LIMIT)
    expect(kept[0]!.id).toBe('e1')
    expect(size(kept)).toBeLessThan(LIMIT / 2)
    expect(size([...kept, list[kept.length]])).toBeGreaterThanOrEqual(LIMIT / 2)
    expect(volumes.length).toBeGreaterThan(1)
    for (const a of volumes) expect(size(a)).toBeLessThan(LIMIT)
    expect(volumes[0]!.at(-1)!.id).toBe('e20')
    expect([...kept, ...[...volumes].reverse().flat()].map(e => e.id)).toEqual(list.map(e => e.id))
    expect(rotate(seed(FULL), LIMIT)).toEqual({ kept: seed(FULL), volumes: [] })
    expect(rotate([], LIMIT)).toEqual({ kept: [], volumes: [] })
  })

  test('an entry bigger than the limit still moves on, alone', () => {
    const big = entry(2, { title: 'x'.repeat(150), tasks: Array.from({ length: 30 }, () => ({ title: 'y'.repeat(150), tier: 'light' })) })
    expect(size([big])).toBeGreaterThan(LIMIT)
    const { kept, volumes } = rotate([entry(1), big, entry(3)], LIMIT)
    expect(kept.map(e => e.id)).toEqual(['e1'])
    expect(volumes.map(a => a.map(e => e.id))).toEqual([['e3'], ['e2']])
    expect(rotate([big], LIMIT)).toEqual({ kept: [big], volumes: [] })
  })

  test('summarize counts the span, sums, size in bytes and each flow’s start and end', () => {
    const list = seed(3)
    expect(summarize('history-1.json', list)).toEqual({
      file: 'history-1.json',
      count: 3,
      from: NOW - 3 * DAY - HOUR,
      to: NOW - DAY,
      cost: 4.5,
      tokens: 36_000,
      time: 90 * MIN,
      size: size(list),
      flows: list.map(e => [e.startedAt, e.endedAt]),
    })
    const wide = [entry(1, { title: 'Ж'.repeat(100) })]
    expect(summarize('history-1.json', wide).size).toBe(utf8(JSON.stringify(wide)))
  })

  test('parseIndex keeps valid volumes and merged side files only', () => {
    const good = summarize('history-2.json', seed(2))
    expect(parseIndex({ segments: [good, { file: '../x.json', count: 1 }, null], merged: ['history-extra-12.json', 'evil.json', 3] })).toEqual({ volumes: [good], merged: ['history-extra-12.json'] })
    expect(parseIndex({ segments: [] })).toEqual({ volumes: [], merged: [] })
    expect(parseIndex('nope')).toBeNull()
    expect(parseIndex({ segments: 'x' })).toBeNull()
    expect(parseIndex([])).toBeNull()
  })

  test('mergeEntries keeps each id once, the later-ended copy, in first-seen order', () => {
    const newer = entry(2, { endedAt: NOW, title: 'newer' })
    expect(mergeEntries([entry(1), entry(2)], [newer, entry(3)]).map(e => [e.id, e.title])).toEqual([
      ['e1', 'Flow 1'],
      ['e2', 'newer'],
      ['e3', 'Flow 3'],
    ])
  })

  test('placeByEnd keeps the list’s own order and puts each flow it lacks, or holds older, where it ended', () => {
    const list = [entry(1), entry(3), entry(5)]
    expect(placeByEnd(list, [entry(4), entry(2), entry(9)]).map(e => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e9'])
    expect(placeByEnd(list, [entry(3, { title: 'older', endedAt: 0 })]).map(e => e.title)).toEqual(['Flow 1', 'Flow 3', 'Flow 5'])
    expect(placeByEnd(list, [entry(5, { title: 'newer', endedAt: NOW })]).map(e => e.title)).toEqual(['newer', 'Flow 1', 'Flow 3'])
    expect(placeByEnd([entry(2), entry(1)], []).map(e => e.id)).toEqual(['e2', 'e1'])
  })

  test('withoutCopies drops only exact copies of entries in a volume', () => {
    const changed = entry(2, { title: 'resaved' })
    const r = withoutCopies([entry(1), changed, entry(3)], [entry(2), entry(3)])
    expect(r.list.map(e => e.title)).toEqual(['Flow 1', 'resaved'])
    expect(r.removed).toBe(1)
  })

  test('spanText', () => {
    const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 10)
    expect(spanText(at(2026, 10, 20), at(2026, 10, 26), 'UTC')).toBe('Oct 20 – Oct 26, 2026')
    expect(spanText(at(2025, 12, 28), at(2026, 1, 3), 'UTC')).toBe('Dec 28, 2025 – Jan 3, 2026')
    expect(spanText(at(2026, 10, 26), at(2026, 10, 26) + HOUR, 'UTC')).toBe('Oct 26, 2026')
  })
})

// --- on disk

type Opts = { store?: Record<string, unknown>; files?: Record<string, string>; unreadable?: string[]; max?: string; env?: Record<string, string> }

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const fs = fakeFs(on, { files: opts.files, unreadable: opts.unreadable })
  const { files, writes, reads, unreadable } = fs
  const clock = { now: NOW }
  const ctl = {
    set failWrite(f: null | ((path: string) => boolean)) {
      fs.fail.write = f ?? false
    },
  }
  on('env.get', (_$: any, e: any) => ({ value: opts.env ? opts.env[e.name] : e.name === 'FLOWDECK_HISTORY_SEGMENT_MAX' ? (opts.max ?? String(LIMIT)) : undefined }))
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
  return { store, files, writes, reads, clock, ctl, unreadable, fs }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
// One finished flow a minute after the last, so each gets its own id (`<startedAt>-/work/app`).
const flow = async ($: any, env: { clock: { now: number } }, title = 'Ship it') => {
  env.clock.now += MIN
  await progress($, { title, total: 2, done: 1, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })
  return String((await progress($, { finished: true })).result)
}
const idsOf = (text: string | undefined): string[] => (text === undefined ? [] : (JSON.parse(text) as any[]).map(e => e.id))
const volumePaths = (files: Record<string, string>) =>
  Object.keys(files)
    .filter(p => /\/history-\d+\.json$/.test(p))
    .sort((a, b) => Number(/(\d+)\.json$/.exec(a)![1]) - Number(/(\d+)\.json$/.exec(b)![1]))
// Every id kept in the folder, with how many files hold it.
const counts = (files: Record<string, string>) => {
  const c = new Map<string, number>()
  for (const p of [HISTORY, ...volumePaths(files)]) for (const id of idsOf(files[p])) c.set(id, (c.get(id) ?? 0) + 1)
  return c
}
const pane = ($: any, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const view = async ($: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  const p = await pane($, surface)
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  const keys = buttons.map((b: any) => String(b.props.key))
  return {
    text: texts.map((t: any) => t.text).join('\n'),
    buttons,
    keys,
    groups: keys.filter((k: string) => /^archive-(e\d+|\d+-\/work\/app)$/.test(k)).map((k: string) => k.slice('archive-'.length)),
    label: (key: string) => String(buttons.find((b: any) => String(b.props.key) === key)?.props.label ?? ''),
  }
}
const press = async ($: any, surface: 'terminal' | 'desktop', ...keys: string[]) => {
  for (const key of keys) {
    const p = await pane($, surface)
    await p.press({ key })
    await settle()
    await p.unmount()
  }
}

describe('rotation on save', () => {
  test('a save over the limit moves the oldest to history-1.json, indexes it, then rewrites history.json; no id is lost', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    const { files, writes } = env
    expect(volumePaths(files)).toEqual([vol(1)])
    const active = idsOf(files[HISTORY])
    const inVolume = idsOf(files[vol(1)])
    expect(active[0]).toBe(`${NOW + MIN}-/work/app`)
    expect(active[1]).toBe('e1')
    expect(inVolume.at(-1)).toBe(`e${FULL}`)
    // the active file holds the newest, the volume the oldest, together exactly every id
    expect([...active, ...inVolume]).toEqual([`${NOW + MIN}-/work/app`, ...seed(FULL).map(e => e.id)])
    expect(files[HISTORY]!.length).toBeLessThan(LIMIT)
    expect(files[vol(1)]!.length).toBeLessThan(LIMIT)
    const kept = JSON.parse(files[vol(1)]!) as ArchiveEntry[]
    expect(JSON.parse(files[INDEX]!)).toEqual({
      segments: [
        {
          file: 'history-1.json',
          count: kept.length,
          from: Math.min(...kept.map(e => e.startedAt)),
          to: Math.max(...kept.map(e => e.endedAt)),
          cost: kept.reduce((s, e) => s + e.cost, 0),
          tokens: kept.reduce((s, e) => s + e.tokens, 0),
          time: kept.reduce((s, e) => s + e.time, 0),
          size: files[vol(1)]!.length,
          flows: kept.map(e => [e.startedAt, e.endedAt]),
        },
      ],
      merged: [`history-extra-${NOW + MIN}.json`],
    })
    // the flow's own side file first, then the volume, the index, history.json, and the index marking the side file merged
    const order = writes.filter(w => !w.endsWith('/.gitignore'))
    expect(order).toEqual([`${DIR}/history-extra-${NOW + MIN}.json`, vol(1), INDEX, HISTORY, INDEX])
  })

  test('FLOWDECK_ARCHIVE_VOLUME_MAX sets the limit too, and wins over the old FLOWDECK_HISTORY_SEGMENT_MAX', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) }, env: { FLOWDECK_ARCHIVE_VOLUME_MAX: String(LIMIT), FLOWDECK_HISTORY_SEGMENT_MAX: '2500000' } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(volumePaths(env.files)).toEqual([vol(1)])
    expect(env.files[HISTORY]!.length).toBeLessThan(LIMIT)
  })

  test('a second rotation creates history-2.json and leaves history-1.json as it was', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    await start($)
    await flow($, env)
    const first = env.files[vol(1)]
    const all = new Set([...seed(FULL).map(e => e.id), `${NOW + MIN}-/work/app`])
    for (let i = 0; i < 30 && !(vol(2) in env.files); i++) {
      await flow($, env, `More ${i}`)
      all.add(`${env.clock.now}-/work/app`)
    }
    expect(volumePaths(env.files)).toEqual([vol(1), vol(2)])
    expect(env.files[vol(1)]).toBe(first)
    expect(env.writes.filter(w => w === vol(1))).toHaveLength(1)
    const index = JSON.parse(env.files[INDEX]!)
    expect(index.segments.map((s: any) => s.file)).toEqual(['history-1.json', 'history-2.json'])
    expect(index.segments[0].to).toBeLessThanOrEqual(index.segments[1].from)
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(all)
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('an overflow bigger than the limit is cut over several volumes, oldest in history-1.json', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(20)) } })
    await start($)
    await flow($, env)
    const paths = volumePaths(env.files)
    expect(paths.length).toBeGreaterThan(1)
    for (const p of [HISTORY, ...paths]) expect(env.files[p]!.length).toBeLessThan(LIMIT)
    expect(idsOf(env.files[vol(1)])).toContain('e20')
    const index = JSON.parse(env.files[INDEX]!)
    expect(index.segments.map((s: any) => s.file)).toEqual(paths.map(p => p.slice(DIR.length + 1)))
    for (let i = 1; i < index.segments.length; i++) expect(index.segments[i - 1].to).toBeLessThanOrEqual(index.segments[i].from)
    const c = counts(env.files)
    expect(c.size).toBe(21)
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('forty flows: every file stays under the limit, volumes are written once, and every id is kept exactly once', async ($, on) => {
    const env = engine(on)
    await start($)
    const all: string[] = []
    for (let i = 0; i < 40; i++) {
      await flow($, env, `Flow n${i}`)
      all.push(`${env.clock.now}-/work/app`)
    }
    const paths = volumePaths(env.files)
    expect(paths.length).toBeGreaterThan(2)
    for (const p of [HISTORY, ...paths]) expect(env.files[p]!.length).toBeLessThan(LIMIT)
    // volumes are not one flow each: a rotation moves about half the limit
    expect(paths.length).toBeLessThan(40 / 2)
    // the index grows by one short summary per volume (under 200 bytes) and under 80 bytes per flow (its start and end, its
    // side file's name), far below the real 2,500,000-byte limit
    expect(env.files[INDEX]!.length).toBeLessThan(200 * paths.length + 80 * 40 + 50)
    for (const p of paths) expect(env.writes.filter(w => w === p)).toHaveLength(1)
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(new Set(all))
    expect([...c.values()].every(n => n === 1)).toBe(true)
    expect(JSON.parse(env.files[INDEX]!).segments).toHaveLength(paths.length)
  })
})

describe('a write failing during rotation', () => {
  const every = (env: { files: Record<string, string>; store: Record<string, unknown> }) =>
    new Set([...counts(env.files).keys(), ...((env.store.history as any[]) ?? []).map(e => e.id)])
  const expected = () => new Set([...seed(FULL).map(e => e.id), `${NOW + MIN}-/work/app`])

  test('(a) the volume write fails: history.json keeps everything, no index', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    env.ctl.failWrite = p => p === vol(1)
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(vol(1) in env.files).toBe(false)
    expect(INDEX in env.files).toBe(false)
    expect(new Set(idsOf(env.files[HISTORY]))).toEqual(expected())
  })

  test('(b) the index write fails: history.json keeps everything; the next save indexes the volume and leaves no copy', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    env.ctl.failWrite = p => p === INDEX
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(vol(1) in env.files).toBe(true)
    expect(INDEX in env.files).toBe(false)
    expect(new Set(idsOf(env.files[HISTORY]))).toEqual(expected())
    const orphan = env.files[vol(1)]
    env.ctl.failWrite = null
    await flow($, env, 'Next')
    expect(env.files[vol(1)]).toBe(orphan)
    expect(JSON.parse(env.files[INDEX]!).segments[0].file).toBe('history-1.json')
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(new Set([...expected(), `${env.clock.now}-/work/app`]))
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('(c) the history.json write fails: the volume and index stay, the entry goes to the store, nothing is lost', async ($, on) => {
    const before = JSON.stringify(seed(FULL))
    const env = engine(on, { files: { [HISTORY]: before } })
    env.ctl.failWrite = p => p === HISTORY
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[HISTORY]).toBe(before)
    expect(vol(1) in env.files).toBe(true)
    expect(INDEX in env.files).toBe(true)
    expect(every(env)).toEqual(expected())
  })

  test('every write failing never throws and keeps the entry in the store', async ($, on) => {
    const before = JSON.stringify(seed(FULL))
    const env = engine(on, { files: { [HISTORY]: before } })
    env.ctl.failWrite = () => true
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[HISTORY]).toBe(before)
    expect(every(env)).toEqual(expected())
  })
})

describe('copies left by a cut-short rotation', () => {
  const crashed = (withIndex: boolean) => {
    const list = seed(10)
    const files: Record<string, string> = { [HISTORY]: JSON.stringify(list), [vol(1)]: JSON.stringify(list.slice(7)) }
    if (withIndex) files[INDEX] = JSON.stringify({ segments: [summarize('history-1.json', list.slice(7))] })
    return files
  }

  for (const withIndex of [true, false]) {
    test(`after a crash ${withIndex ? 'before history.json was rewritten' : 'before the index was written'}, the copies are hidden on load and dropped by the next save`, async ($, on) => {
      const env = engine(on, { store: { historyShown: true }, files: crashed(withIndex) })
      await start($)
      await settle()
      const v = await view($)
      expect(v.groups.slice(0, 7)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
      expect(v.groups).not.toContain('e8')
      expect(v.label('archive-older')).toBe('▸ Older volumes (1 file)')
      expect(env.writes).toEqual([])
      await flow($, env)
      expect(JSON.parse(env.files[INDEX]!).segments[0].file).toBe('history-1.json')
      const c = counts(env.files)
      expect(new Set(c.keys())).toEqual(new Set([...seed(10).map(e => e.id), `${NOW + MIN}-/work/app`]))
      expect([...c.values()].every(n => n === 1)).toBe(true)
    })
  }

  for (const isLegacy of [false, true]) {
    test(`a copy of a flow in a volume is hidden from the latest view even with history.json under the limit${isLegacy ? ' (an index without flows: the volume is read for them)' : ''}`, async ($, on) => {
      const resaved = entry(4, { title: 'Resaved', endedAt: NOW })
      const list = [resaved, entry(1), entry(2), entry(3)]
      const inVolume = [entry(3), entry(4)]
      const summary = summarize('history-1.json', inVolume)
      if (isLegacy) delete summary.flows
      const env = engine(on, {
        store: { historyShown: true },
        files: { [HISTORY]: JSON.stringify(list), [vol(1)]: JSON.stringify(inVolume), [INDEX]: JSON.stringify({ segments: [summary] }) },
      })
      expect(size(list)).toBeLessThan(LIMIT)
      await start($)
      await settle()
      const v = await view($)
      // e3 is an exact copy: hidden; e4 was saved again after it went into a volume: its newer snapshot shows
      expect(v.groups).toEqual(['e4', 'e1', 'e2'])
      expect(v.text).toContain('· 3 flows')
      expect(env.writes).toEqual([])
    })
  }

  test('a re-saved flow whose old copy went into a volume keeps both copies', async ($, on) => {
    const list = seed(FULL)
    const changed = { ...list.at(-1)!, title: 'Resaved', endedAt: NOW }
    const env = engine(on, { files: { [HISTORY]: JSON.stringify([changed, ...list.slice(0, -1)]), [vol(1)]: JSON.stringify([list.at(-1)]), [INDEX]: JSON.stringify({ segments: [summarize('history-1.json', [list.at(-1)!])] }) } })
    await start($)
    await flow($, env)
    const titles = [HISTORY, ...volumePaths(env.files)].flatMap(p => (JSON.parse(env.files[p]!) as any[]).filter(e => e.id === changed.id).map(e => e.title))
    expect(titles.sort()).toEqual([`Flow ${FULL}`, 'Resaved'])
  })
})

describe('a history.json that is there but cannot be used', () => {
  test('unreadable (stat ok, read rejects): never overwritten, the entry goes to a side file and the store, and shows on the next load', async ($, on) => {
    const before = JSON.stringify(seed(3))
    const env = engine(on, { store: { historyShown: true }, files: { [HISTORY]: before }, unreadable: [HISTORY] })
    await start($)
    expect(await flow($, env)).toContain('ok')
    const id = `${NOW + MIN}-/work/app`
    expect(env.files[HISTORY]).toBe(before)
    expect(env.writes).not.toContain(HISTORY)
    expect(idsOf(env.files[`${DIR}/history-extra-${NOW + MIN}.json`])).toEqual([id])
    expect((env.store.history as any[]).map(e => e.id)).toEqual([id])
    await start($)
    await settle()
    let v = await view($)
    expect(v.groups).toEqual([id])
    expect(v.text).toContain(WARNING)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const drawn = JSON.stringify(await p.drawn())
      await p.unmount()
      // a dim line above the groups
      expect(drawn.indexOf(WARNING)).toBeGreaterThan(-1)
      expect(drawn.indexOf(WARNING)).toBeLessThan(drawn.indexOf(`"archive-${id}"`))
    }
    // readable again: the next save merges the side file in, and it is not merged twice
    env.unreadable.clear()
    await flow($, env, 'Later')
    expect(idsOf(env.files[HISTORY])).toEqual([`${env.clock.now}-/work/app`, id, 'e1', 'e2', 'e3'])
    expect((await view($)).text).not.toContain(WARNING)
    // every flow has its own side file now: the earlier one and this save's are both marked merged
    expect([...JSON.parse(env.files[INDEX]!).merged].sort()).toEqual([`history-extra-${NOW + MIN}.json`, `history-extra-${env.clock.now}.json`])
    expect(idsOf(env.files[`${DIR}/history-extra-${NOW + MIN}.json`])).toEqual([id])
    await start($)
    await settle()
    v = await view($)
    expect(v.groups).toEqual([`${env.clock.now}-/work/app`, id, 'e1', 'e2', 'e3'])
    expect(v.text).not.toContain(WARNING)
  })

  test('read, stat and the listing failing: `exists` says it is there, so it is never overwritten', async ($, on) => {
    const before = JSON.stringify(seed(3))
    const env = engine(on, { files: { [HISTORY]: before }, unreadable: [HISTORY] })
    env.fs.fail.stat = true
    env.fs.fail.list = true
    await start($)
    expect(await flow($, env)).toContain('ok')
    const id = `${NOW + MIN}-/work/app`
    expect(env.files[HISTORY]).toBe(before)
    expect(env.fs.tried.map(t => t.path)).not.toContain(HISTORY)
    expect(idsOf(env.files[`${DIR}/history-extra-${NOW + MIN}.json`])).toEqual([id])
    expect((env.store.history as any[]).map(e => e.id)).toEqual([id])
  })

  test('read, stat, listing and `exists` all failing: whether anything is there is unknown, so nothing in the folder is written', async ($, on) => {
    const before = JSON.stringify(seed(3))
    const env = engine(on, { store: { historyShown: true }, files: { [HISTORY]: before }, unreadable: [HISTORY] })
    Object.assign(env.fs.fail, { stat: true, list: true, exists: true })
    await start($)
    expect(await flow($, env)).toContain('ok')
    const id = `${NOW + MIN}-/work/app`
    expect(env.fs.tried).toEqual([])
    expect(env.files).toEqual({ [HISTORY]: before })
    expect((env.store.history as any[]).map(e => e.id)).toEqual([id])
    await start($)
    await settle()
    const v = await view($)
    expect(v.groups).toEqual([id])
    expect(v.text).toContain(WARNING)
  })

  test('with stat and the listing failing, a missing history.json is still created: `exists` tells it is missing', async ($, on) => {
    const env = engine(on)
    env.fs.fail.stat = true
    env.fs.fail.list = true
    await start($)
    await flow($, env)
    expect(idsOf(env.files[HISTORY])).toEqual([`${NOW + MIN}-/work/app`])
    expect(env.files[`${DIR}/.gitignore`]).toBe('*\n')
  })

  test('an index whose existence is unknown is never written and nothing rotates; history.json, read fine, still takes the flow', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)), [INDEX]: '{"segments":[]}' }, unreadable: [INDEX] })
    Object.assign(env.fs.fail, { stat: true, list: true, exists: true })
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[INDEX]).toBe('{"segments":[]}')
    expect(volumePaths(env.files)).toEqual([])
    expect(idsOf(env.files[HISTORY])).toHaveLength(FULL + 1)
    // .gitignore and the side file could not be told missing either: neither is written
    expect(Object.keys(env.files).sort()).toEqual([HISTORY, INDEX].sort())
  })

  test('corrupt (read ok, parse fails): kept as it is, the entry goes to a side file; an existing side file name is not reused', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: 'nope', [`${DIR}/history-extra-${NOW + MIN}.json`]: '[]' } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[HISTORY]).toBe('nope')
    expect(env.files[`${DIR}/history-extra-${NOW + MIN}.json`]).toBe('[]')
    expect(idsOf(env.files[`${DIR}/history-extra-${NOW + MIN}-2.json`])).toEqual([`${NOW + MIN}-/work/app`])
  })

  test('a re-save of the same flow overwrites only its own side file; a slot holding another flow is never written over', async ($, on) => {
    const slot1 = `${DIR}/history-extra-${NOW + MIN}.json`
    const slot2 = `${DIR}/history-extra-${NOW + MIN}-2.json`
    const other = JSON.stringify([entry(1, { id: `${NOW + MIN}-/elsewhere`, startedAt: NOW + MIN })])
    const env = engine(on, { files: { [slot1]: other } })
    await start($)
    env.clock.now += MIN
    await progress($, { title: 'Ship it', total: 2, done: 1, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }] })
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    const id = `${NOW + MIN}-/work/app`
    expect(JSON.parse(env.files[slot2]!).map((e: any) => [e.id, e.status])).toEqual([[id, 'open']])
    env.clock.now += MIN
    await progress($, { finished: true })
    expect(JSON.parse(env.files[slot2]!).map((e: any) => [e.id, e.status, e.endedAt])).toEqual([[id, 'finished', env.clock.now]])
    expect(env.files[slot1]).toBe(other)
    expect(Object.keys(env.files).filter(p => p.includes('/history-extra-'))).toHaveLength(2)
    expect(idsOf(env.files[HISTORY])[0]).toBe(id)
  })

  test('an unreadable index stops rotation but never the save', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)), [INDEX]: '{broken' } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[INDEX]).toBe('{broken')
    expect(volumePaths(env.files)).toEqual([])
    expect(idsOf(env.files[HISTORY])).toHaveLength(FULL + 1)
  })

  test('a missing history.json is created', async ($, on) => {
    const env = engine(on)
    await start($)
    await flow($, env)
    expect(idsOf(env.files[HISTORY])).toEqual([`${NOW + MIN}-/work/app`])
    expect(env.files[`${DIR}/.gitignore`]).toBe('*\n')
  })

  test('an existing .gitignore that cannot be read is not overwritten', async ($, on) => {
    const env = engine(on, { files: { [`${DIR}/.gitignore`]: 'mine\n' }, unreadable: [`${DIR}/.gitignore`] })
    await start($)
    await flow($, env)
    expect(env.files[`${DIR}/.gitignore`]).toBe('mine\n')
    expect(idsOf(env.files[HISTORY])).toHaveLength(1)
  })
})

describe('browsing volumes in the panel', () => {
  const latest = [entry(1), entry(2)]
  const one = seed(3, 20) // e20..e22, the oldest
  const two = seed(2, 10) // e10..e11
  const vols = () => [summarize('history-1.json', one), summarize('history-2.json', two)]
  const disk = (): Record<string, string> => ({
    [HISTORY]: JSON.stringify(latest),
    [vol(1)]: JSON.stringify(one),
    [vol(2)]: JSON.stringify(two),
    [INDEX]: JSON.stringify({ segments: vols() }),
  })

  test('the latest part shows with its span, and Older volumes lists the volumes newest first with summaries', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      let v = await view($, surface)
      expect(v.text).toContain(`Showing ${spanText(entry(2).startedAt, entry(1).endedAt)} · 2 flows`)
      expect(v.groups).toEqual(['e1', 'e2'])
      expect(v.label('archive-older')).toBe('▸ Older volumes (2 files)')
      expect(v.keys.indexOf('archive-older')).toBeLessThan(v.keys.indexOf('archive-e1'))
      expect(v.keys.some((k: string) => k.startsWith('archive-seg-'))).toBe(false)
      expect(v.keys).not.toContain('archive-latest')
      await press($, surface, 'archive-older')
      v = await view($, surface)
      expect(v.label('archive-older')).toBe('▾ Older volumes (2 files)')
      expect(v.keys.filter((k: string) => k.startsWith('archive-seg-'))).toEqual(['archive-seg-history-2.json', 'archive-seg-history-1.json'])
      const [s1, s2] = vols()
      expect(v.label('archive-seg-history-2.json')).toBe(spanText(s2!.from, s2!.to))
      expect(v.label('archive-seg-history-1.json')).toBe(spanText(s1!.from, s1!.to))
      expect(v.text).toContain('3 flows · ≈$4.50 · 36k tokens · 1:30:00')
      expect(v.text).toContain('2 flows · ≈$3.00 · 24k tokens · 1:00:00')
      await press($, surface, 'archive-older')
    }
    expect(env.writes).toEqual([])
  })

  test('choosing a volume loads only it, Back to latest returns, and browsing writes nothing', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, 'archive-older')
      const before = env.reads.length
      await press($, surface, 'archive-seg-history-1.json')
      expect(env.reads.slice(before)).toEqual([vol(1)])
      let v = await view($, surface)
      expect(v.groups).toEqual(['e20', 'e21', 'e22'])
      expect(v.keys.filter((k: string) => k.startsWith('archive-'))[0]).toBe('archive-latest')
      expect(v.keys.indexOf('archive-latest')).toBeLessThan(v.keys.indexOf('archive-older'))
      expect(v.text).toContain(`Showing ${spanText(entry(22).startedAt, entry(20).endedAt)} · 3 flows`)
      expect(v.keys.some((k: string) => k.startsWith('archive-seg-'))).toBe(false)
      const fold = (w: typeof v, key: string) => JSON.stringify(w.buttons.find((b: any) => String(b.props.key) === key)).match(/[▾▸]/)?.[0]
      // the volume's newest group is open by default, the others folded
      expect(fold(v, 'archive-e20')).toBe('▾')
      expect(fold(v, 'archive-e21')).toBe('▸')
      expect(v.text).toMatch(/✓ write tests \(careful\)/)
      await press($, surface, 'archive-e20')
      v = await view($, surface)
      expect(v.text).not.toMatch(/write tests/)
      await press($, surface, 'archive-latest')
      v = await view($, surface)
      expect(v.groups).toEqual(['e1', 'e2'])
      expect(v.keys).not.toContain('archive-latest')
      // Back to latest applies the default again
      expect(fold(v, 'archive-e1')).toBe('▾')
      expect(fold(v, 'archive-e2')).toBe('▸')
    }
    expect(env.writes).toEqual([])
  })

  test('switching volume applies the default again: the first group of the volume shown is open', async ($, on) => {
    engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    const fold = (w: Awaited<ReturnType<typeof view>>, key: string) => JSON.stringify(w.buttons.find((b: any) => String(b.props.key) === key)).match(/[▾▸]/)?.[0]
    // a user's choice on the latest part: e1 folded, e2 opened
    await press($, 'terminal', 'archive-e1', 'archive-e2')
    let v = await view($)
    expect([fold(v, 'archive-e1'), fold(v, 'archive-e2')]).toEqual(['▸', '▾'])
    await press($, 'terminal', 'archive-older', 'archive-seg-history-1.json', 'archive-e20', 'archive-e21')
    v = await view($)
    expect([fold(v, 'archive-e20'), fold(v, 'archive-e21')]).toEqual(['▸', '▾'])
    await press($, 'terminal', 'archive-older', 'archive-seg-history-2.json', 'archive-older', 'archive-seg-history-1.json')
    v = await view($)
    expect([fold(v, 'archive-e20'), fold(v, 'archive-e21'), fold(v, 'archive-e22')]).toEqual(['▾', '▸', '▸'])
    await press($, 'terminal', 'archive-latest')
    v = await view($)
    expect([fold(v, 'archive-e1'), fold(v, 'archive-e2')]).toEqual(['▾', '▸'])
  })

  test('a volume that cannot be read says so and the view stays', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk(), unreadable: [vol(2)] })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, 'archive-older', 'archive-seg-history-2.json')
      const v = await view($, surface)
      expect(v.text).toContain('could not load history-2.json')
      expect(v.groups).toEqual(['e1', 'e2'])
      expect(v.keys).not.toContain('archive-latest')
      await press($, surface, 'archive-older')
    }
    env.files[vol(1)] = 'nope'
    await press($, 'terminal', 'archive-older', 'archive-seg-history-1.json')
    const v = await view($)
    expect(v.text).toContain('could not load history-1.json')
    expect(v.groups).toEqual(['e1', 'e2'])
    expect(env.writes).toEqual([])
  })

  test('a volume of twelve pages ten at a time with Show older', async ($, on) => {
    const twelve = seed(12, 30)
    const env = engine(on, {
      store: { historyShown: true },
      files: { [HISTORY]: JSON.stringify(latest), [vol(1)]: JSON.stringify(twelve), [INDEX]: JSON.stringify({ segments: [summarize('history-1.json', twelve)] }) },
    })
    await start($)
    await settle()
    await press($, 'terminal', 'archive-older', 'archive-seg-history-1.json')
    let v = await view($)
    expect(v.groups).toHaveLength(10)
    expect(v.label('archive-more')).toBe('Show older (2)')
    await press($, 'terminal', 'archive-more')
    v = await view($)
    expect(v.groups).toHaveLength(12)
    expect(env.writes).toEqual([])
  })

  test('a flow recorded while a volume is shown goes to history.json and the volume view stays', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    await press($, 'terminal', 'archive-older', 'archive-seg-history-2.json')
    const volume = env.files[vol(2)]
    await flow($, env)
    const id = `${NOW + MIN}-/work/app`
    expect(idsOf(env.files[HISTORY])).toEqual([id, 'e1', 'e2'])
    expect(env.files[vol(2)]).toBe(volume)
    let v = await view($)
    expect(v.groups).toEqual(['e10', 'e11'])
    await press($, 'terminal', 'archive-latest')
    v = await view($)
    expect(v.groups).toEqual([id, 'e1', 'e2'])
  })

  test('without volumes there is no Older volumes control', async ($, on) => {
    engine(on, { store: { historyShown: true }, files: { [HISTORY]: JSON.stringify(latest) } })
    await start($)
    await settle()
    const v = await view($)
    expect(v.keys).not.toContain('archive-older')
    expect(v.text).toContain('· 2 flows')
  })
})

describe('sizes are UTF-8 bytes', () => {
  const WORDS = { Cyrillic: 'Привет мир ', CJK: '你好世界和平', emoji: '🚀🎉🧪🔥' }

  test('byteLength counts UTF-8: ASCII 1, Cyrillic 2, CJK 3, emoji 4, a lone surrogate 3', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('Жж')).toBe(4)
    expect(byteLength('你好')).toBe(6)
    expect(byteLength('🚀')).toBe(4)
    expect(byteLength('\ud83d')).toBe(3)
    expect(byteLength('a\udc00b')).toBe(5)
    expect(byteLength('\ud83dx')).toBe(4)
    for (const w of Object.values(WORDS)) expect(byteLength(w.repeat(50))).toBe(utf8(w.repeat(50)))
  })

  for (const [name, w] of Object.entries(WORDS)) {
    test(`${name} entries rotate before the byte limit, though their characters are under it`, () => {
      const list = Array.from({ length: 30 }, (_, i) => entry(i + 1, { title: w.repeat(30).slice(0, 200) }))
      const text = JSON.stringify(list)
      const limit = Math.round((text.length + utf8(text)) / 2)
      expect(text.length).toBeLessThan(limit)
      const { kept, volumes } = rotate(list, limit)
      expect(volumes.length).toBeGreaterThan(0)
      for (const part of [kept, ...volumes]) expect(utf8(JSON.stringify(part))).toBeLessThan(limit)
      expect([...kept, ...[...volumes].reverse().flat()].map(e => e.id)).toEqual(list.map(e => e.id))
    })
  }

  test('on disk: multibyte flows keep every file under the byte limit, and no write passes 4 MiB', async ($, on) => {
    const env = engine(on)
    await start($)
    const all: string[] = []
    for (let i = 0; i < 30; i++) {
      await flow($, env, `${Object.values(WORDS)[i % 3]!.repeat(6)} ${i}`)
      all.push(`${env.clock.now}-/work/app`)
    }
    const paths = volumePaths(env.files)
    expect(paths.length).toBeGreaterThan(1)
    for (const p of [HISTORY, ...paths]) expect(utf8(env.files[p]!)).toBeLessThan(LIMIT)
    for (const p of paths) expect(JSON.parse(env.files[INDEX]!).segments.find((s: any) => p.endsWith(s.file)).size).toBe(utf8(env.files[p]!))
    expect(Math.max(...env.fs.tried.map(t => t.bytes))).toBeLessThan(ENGINE_MAX)
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(new Set(all))
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  // An entry of about 44 kB: a 100-emoji title and 100 tasks of 99 emoji each (all under the 200-character cap).
  const fat = (i: number): ArchiveEntry => entry(i, { title: '🚀'.repeat(100), tasks: Array.from({ length: 100 }, (_, k) => ({ title: `${'🧪'.repeat(99)}${k}`, tier: 'careful' })) })
  const fill = (bytes: number): ArchiveEntry[] => {
    const one = utf8(JSON.stringify(fat(1))) + 1
    return Array.from({ length: Math.floor((bytes - 2) / one) }, (_, k) => fat(k + 1))
  }

  test('at the real limit: a history.json of emoji flows under 2,500,000 characters but near 4 MiB rotates, and no write passes 3,900,000 bytes', { timeoutMs: 60_000 }, async ($, on) => {
    const list = fill(4_100_000)
    const text = JSON.stringify(list)
    // what a character count let through: far under its old 3,000,000, while the bytes are near the engine's 4 MiB
    expect(text.length).toBeLessThan(2_500_000)
    expect(utf8(text)).toBeGreaterThan(4_000_000)
    expect(utf8(text)).toBeLessThan(ENGINE_MAX)
    const env = engine(on, { max: '', files: { [HISTORY]: text } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    const paths = volumePaths(env.files)
    expect(paths.length).toBeGreaterThan(0)
    for (const p of [HISTORY, ...paths]) expect(utf8(env.files[p]!)).toBeLessThan(2_500_000)
    expect(Math.max(...env.fs.tried.map(t => t.bytes))).toBeLessThan(WRITE_MAX)
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(new Set([`${NOW + MIN}-/work/app`, ...list.map(e => e.id)]))
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('a write over 3,900,000 bytes is never sent: with rotation stopped by an unreadable index, history.json stays as it is and the flow is kept in its side file and the store', { timeoutMs: 60_000 }, async ($, on) => {
    const list = fill(3_880_000)
    const text = JSON.stringify(list)
    const env = engine(on, { max: '', store: { historyShown: true }, files: { [HISTORY]: text, [INDEX]: '{broken' } })
    await start($)
    env.clock.now += MIN
    await progress($, { title: '🚀'.repeat(100), total: 1, done: 1, phase: 'delegate', tasks: Array.from({ length: 100 }, (_, k) => ({ title: `${'🧪'.repeat(99)}${k}`, tier: 'careful' })) })
    expect(String((await progress($, { finished: true })).result)).toContain('ok')
    const id = `${env.clock.now}-/work/app`
    expect(env.files[HISTORY]).toBe(text)
    expect(env.fs.tried.map(t => t.path)).not.toContain(HISTORY)
    expect(Math.max(...env.fs.tried.map(t => t.bytes))).toBeLessThan(WRITE_MAX)
    expect(idsOf(env.files[`${DIR}/history-extra-${env.clock.now}.json`])).toEqual([id])
    expect((env.store.history as any[]).map(e => e.id)).toEqual([id])
    await start($)
    await settle()
    expect((await view($)).groups[0]).toBe(id)
  })
})

describe('two sessions saving at once', () => {
  const gate = () => {
    let open!: () => void
    const p = new Promise<void>(r => (open = r))
    return { p, open }
  }

  test('one save overwriting history.json and the index without the other’s flow never loses it: the flow’s side file brings it back', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: { [HISTORY]: JSON.stringify([entry(1)]) } })
    await start($)
    const idA = `${NOW + MIN}-/work/app`
    const idB = `${NOW + 2 * MIN}-/work/app`
    const sideA = `${DIR}/history-extra-${NOW + MIN}.json`
    env.clock.now = NOW + MIN
    await progress($, { title: 'A', total: 1, done: 1, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    // A is held before its first call; B saves meanwhile up to its history.json write; A then saves whole, B writes
    // history.json last (without A, read before A wrote it), and A's index, written last, marks A's side file merged.
    const a = gate()
    const b = gate()
    const ai = gate()
    let isHeld = false
    let historyWrites = 0
    let indexWrites = 0
    env.fs.delay = async (op, path) => {
      if (op === 'read' && path === sideA && !isHeld) {
        isHeld = true
        await a.p
      } else if (op === 'write' && path === HISTORY && ++historyWrites === 1) {
        a.open()
        await b.p
      } else if (op === 'write' && path === INDEX) {
        if (++indexWrites === 1) {
          b.open()
          await ai.p
        } else (globalThis as any).setTimeout(ai.open, 20)
      }
    }
    const finishingA = progress($, { finished: true })
    while (!isHeld) await settle()
    env.clock.now = NOW + 2 * MIN
    await progress($, { title: 'B', total: 1, done: 1, phase: 'delegate', tasks: [{ title: 'b', tier: 'light' }] })
    await progress($, { finished: true })
    await finishingA
    env.fs.delay = null
    // the feared state: history.json is B's, without A, and the index marks A's side file merged
    expect(idsOf(env.files[HISTORY])).toEqual([idB, 'e1'])
    expect(JSON.parse(env.files[INDEX]!).merged).toContain(`history-extra-${NOW + MIN}.json`)
    // the next load reads A back from its side file, in its place in time
    await start($)
    await settle()
    expect((await view($)).groups).toEqual([idB, idA, 'e1'])
    // and the next save writes every flow into history.json, each once
    await flow($, env, 'C')
    expect(idsOf(env.files[HISTORY])).toEqual([`${env.clock.now}-/work/app`, idB, idA, 'e1'])
  })
})
