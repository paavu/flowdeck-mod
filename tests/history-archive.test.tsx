import { describe, expect, test } from 'claude-code/testing'

import { mergeEntries, parseIndex, rotate, spanText, summarize, withoutCopies } from '../hooks/history'
import type { HistoryEntry } from '../types'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const DIR = '/work/app/.claude/flowdeck'
const HISTORY = `${DIR}/history.json`
const INDEX = `${DIR}/history-index.json`
const arc = (n: number) => `${DIR}/history-${n}.json`
const LIMIT = 2000

// e1 is the newest, a day before NOW; each next one a day older.
const entry = (i: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
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
const seed = (n: number, from = 1): HistoryEntry[] => Array.from({ length: n }, (_, k) => entry(from + k))
const size = (list: unknown) => JSON.stringify(list).length
// The most entries whose file stays under the limit, so one more flow makes the save rotate.
const FULL = (() => {
  let n = 1
  while (size(seed(n + 1)) < LIMIT) n++
  return n
})()

// --- pure

describe('rotation, pure', () => {
  test('over the limit keeps the newest within half of it and cuts the rest into archives, oldest first, each under the limit', () => {
    const list = seed(20)
    const { kept, archives } = rotate(list, LIMIT)
    expect(kept[0]!.id).toBe('e1')
    expect(size(kept)).toBeLessThan(LIMIT / 2)
    expect(size([...kept, list[kept.length]])).toBeGreaterThanOrEqual(LIMIT / 2)
    expect(archives.length).toBeGreaterThan(1)
    for (const a of archives) expect(size(a)).toBeLessThan(LIMIT)
    expect(archives[0]!.at(-1)!.id).toBe('e20')
    expect([...kept, ...[...archives].reverse().flat()].map(e => e.id)).toEqual(list.map(e => e.id))
    expect(rotate(seed(FULL), LIMIT)).toEqual({ kept: seed(FULL), archives: [] })
    expect(rotate([], LIMIT)).toEqual({ kept: [], archives: [] })
  })

  test('an entry bigger than the limit still moves on, alone', () => {
    const big = entry(2, { title: 'x'.repeat(150), tasks: Array.from({ length: 30 }, () => ({ title: 'y'.repeat(150), tier: 'light' })) })
    expect(size([big])).toBeGreaterThan(LIMIT)
    const { kept, archives } = rotate([entry(1), big, entry(3)], LIMIT)
    expect(kept.map(e => e.id)).toEqual(['e1'])
    expect(archives.map(a => a.map(e => e.id))).toEqual([['e3'], ['e2']])
    expect(rotate([big], LIMIT)).toEqual({ kept: [big], archives: [] })
  })

  test('summarize counts the span, sums and size', () => {
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
    })
  })

  test('parseIndex keeps valid segments and merged side files only', () => {
    const good = summarize('history-2.json', seed(2))
    expect(parseIndex({ segments: [good, { file: '../x.json', count: 1 }, null], merged: ['history-extra-12.json', 'evil.json', 3] })).toEqual({ segments: [good], merged: ['history-extra-12.json'] })
    expect(parseIndex({ segments: [] })).toEqual({ segments: [], merged: [] })
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

  test('withoutCopies drops only exact copies of archived entries', () => {
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

type Opts = { store?: Record<string, unknown>; files?: Record<string, string>; unreadable?: string[]; max?: string }

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const files = opts.files ?? {}
  const unreadable = new Set(opts.unreadable ?? [])
  const writes: string[] = []
  const reads: string[] = []
  const clock = { now: NOW }
  const ctl = { failWrite: null as null | ((path: string) => boolean) }
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'FLOWDECK_HISTORY_SEGMENT_MAX' ? (opts.max ?? String(LIMIT)) : undefined }))
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
  on('fs.read', (_$: any, e: any) => {
    reads.push(e.path)
    if (unreadable.has(e.path)) throw new Error('EACCES')
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.write', (_$: any, e: any) => {
    if (ctl.failWrite?.(e.path)) throw new Error('EACCES')
    writes.push(e.path)
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_$: any, e: any) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_$: any, e: any) => {
    const pre = `${String(e.path).replace(/\/$/, '')}/`
    const names = Object.keys(files)
      .filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/'))
      .map(p => p.slice(pre.length))
    if (!names.length) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, files, writes, reads, clock, ctl, unreadable }
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
const archivePaths = (files: Record<string, string>) =>
  Object.keys(files)
    .filter(p => /\/history-\d+\.json$/.test(p))
    .sort((a, b) => Number(/(\d+)\.json$/.exec(a)![1]) - Number(/(\d+)\.json$/.exec(b)![1]))
// Every id kept in the folder, with how many files hold it.
const counts = (files: Record<string, string>) => {
  const c = new Map<string, number>()
  for (const p of [HISTORY, ...archivePaths(files)]) for (const id of idsOf(files[p])) c.set(id, (c.get(id) ?? 0) + 1)
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
    groups: keys.filter((k: string) => /^history-(e\d+|\d+-\/work\/app)$/.test(k)).map((k: string) => k.slice('history-'.length)),
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
    expect(archivePaths(files)).toEqual([arc(1)])
    const active = idsOf(files[HISTORY])
    const archived = idsOf(files[arc(1)])
    expect(active[0]).toBe(`${NOW + MIN}-/work/app`)
    expect(active[1]).toBe('e1')
    expect(archived.at(-1)).toBe(`e${FULL}`)
    // the active file holds the newest, the archive the oldest, together exactly every id
    expect([...active, ...archived]).toEqual([`${NOW + MIN}-/work/app`, ...seed(FULL).map(e => e.id)])
    expect(files[HISTORY]!.length).toBeLessThan(LIMIT)
    expect(files[arc(1)]!.length).toBeLessThan(LIMIT)
    const kept = JSON.parse(files[arc(1)]!) as HistoryEntry[]
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
          size: files[arc(1)]!.length,
        },
      ],
      merged: [],
    })
    const order = writes.filter(w => [arc(1), INDEX, HISTORY].includes(w))
    expect(order).toEqual([arc(1), INDEX, HISTORY])
  })

  test('a second rotation creates history-2.json and leaves history-1.json as it was', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    await start($)
    await flow($, env)
    const first = env.files[arc(1)]
    const all = new Set([...seed(FULL).map(e => e.id), `${NOW + MIN}-/work/app`])
    for (let i = 0; i < 30 && !(arc(2) in env.files); i++) {
      await flow($, env, `More ${i}`)
      all.add(`${env.clock.now}-/work/app`)
    }
    expect(archivePaths(env.files)).toEqual([arc(1), arc(2)])
    expect(env.files[arc(1)]).toBe(first)
    expect(env.writes.filter(w => w === arc(1))).toHaveLength(1)
    const index = JSON.parse(env.files[INDEX]!)
    expect(index.segments.map((s: any) => s.file)).toEqual(['history-1.json', 'history-2.json'])
    expect(index.segments[0].to).toBeLessThanOrEqual(index.segments[1].from)
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(all)
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('an overflow bigger than the limit is cut over several archives, oldest in history-1.json', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(20)) } })
    await start($)
    await flow($, env)
    const paths = archivePaths(env.files)
    expect(paths.length).toBeGreaterThan(1)
    for (const p of [HISTORY, ...paths]) expect(env.files[p]!.length).toBeLessThan(LIMIT)
    expect(idsOf(env.files[arc(1)])).toContain('e20')
    const index = JSON.parse(env.files[INDEX]!)
    expect(index.segments.map((s: any) => s.file)).toEqual(paths.map(p => p.slice(DIR.length + 1)))
    for (let i = 1; i < index.segments.length; i++) expect(index.segments[i - 1].to).toBeLessThanOrEqual(index.segments[i].from)
    const c = counts(env.files)
    expect(c.size).toBe(21)
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('forty flows: every file stays under the limit, archives are written once, and every id is kept exactly once', async ($, on) => {
    const env = engine(on)
    await start($)
    const all: string[] = []
    for (let i = 0; i < 40; i++) {
      await flow($, env, `Flow n${i}`)
      all.push(`${env.clock.now}-/work/app`)
    }
    const paths = archivePaths(env.files)
    expect(paths.length).toBeGreaterThan(2)
    for (const p of [HISTORY, ...paths]) expect(env.files[p]!.length).toBeLessThan(LIMIT)
    // archives are not one flow each: a rotation moves about half the limit
    expect(paths.length).toBeLessThan(40 / 2)
    // the index grows by one short summary per archive (under 200 characters), far below the real 3,000,000 limit
    expect(env.files[INDEX]!.length).toBeLessThan(200 * paths.length + 50)
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

  test('(a) the archive write fails: history.json keeps everything, no index', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    env.ctl.failWrite = p => p === arc(1)
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(arc(1) in env.files).toBe(false)
    expect(INDEX in env.files).toBe(false)
    expect(new Set(idsOf(env.files[HISTORY]))).toEqual(expected())
  })

  test('(b) the index write fails: history.json keeps everything; the next save indexes the archive and leaves no copy', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)) } })
    env.ctl.failWrite = p => p === INDEX
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(arc(1) in env.files).toBe(true)
    expect(INDEX in env.files).toBe(false)
    expect(new Set(idsOf(env.files[HISTORY]))).toEqual(expected())
    const orphan = env.files[arc(1)]
    env.ctl.failWrite = null
    await flow($, env, 'Next')
    expect(env.files[arc(1)]).toBe(orphan)
    expect(JSON.parse(env.files[INDEX]!).segments[0].file).toBe('history-1.json')
    const c = counts(env.files)
    expect(new Set(c.keys())).toEqual(new Set([...expected(), `${env.clock.now}-/work/app`]))
    expect([...c.values()].every(n => n === 1)).toBe(true)
  })

  test('(c) the history.json write fails: the archive and index stay, the entry goes to the store, nothing is lost', async ($, on) => {
    const before = JSON.stringify(seed(FULL))
    const env = engine(on, { files: { [HISTORY]: before } })
    env.ctl.failWrite = p => p === HISTORY
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[HISTORY]).toBe(before)
    expect(arc(1) in env.files).toBe(true)
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
    const files: Record<string, string> = { [HISTORY]: JSON.stringify(list), [arc(1)]: JSON.stringify(list.slice(7)) }
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
      expect(v.label('history-older')).toBe('▸ Older history (1 file)')
      expect(env.writes).toEqual([])
      await flow($, env)
      expect(JSON.parse(env.files[INDEX]!).segments[0].file).toBe('history-1.json')
      const c = counts(env.files)
      expect(new Set(c.keys())).toEqual(new Set([...seed(10).map(e => e.id), `${NOW + MIN}-/work/app`]))
      expect([...c.values()].every(n => n === 1)).toBe(true)
    })
  }

  test('a re-saved flow whose old copy was archived keeps both copies', async ($, on) => {
    const list = seed(FULL)
    const changed = { ...list.at(-1)!, title: 'Resaved', endedAt: NOW }
    const env = engine(on, { files: { [HISTORY]: JSON.stringify([changed, ...list.slice(0, -1)]), [arc(1)]: JSON.stringify([list.at(-1)]), [INDEX]: JSON.stringify({ segments: [summarize('history-1.json', [list.at(-1)!])] }) } })
    await start($)
    await flow($, env)
    const titles = [HISTORY, ...archivePaths(env.files)].flatMap(p => (JSON.parse(env.files[p]!) as any[]).filter(e => e.id === changed.id).map(e => e.title))
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
    expect((await view($)).groups).toEqual([id])
    // readable again: the next save merges the side file in, and it is not merged twice
    env.unreadable.clear()
    await flow($, env, 'Later')
    expect(idsOf(env.files[HISTORY])).toEqual([`${env.clock.now}-/work/app`, id, 'e1', 'e2', 'e3'])
    expect(JSON.parse(env.files[INDEX]!).merged).toEqual([`history-extra-${NOW + MIN}.json`])
    expect(idsOf(env.files[`${DIR}/history-extra-${NOW + MIN}.json`])).toEqual([id])
    await start($)
    await settle()
    expect((await view($)).groups).toEqual([`${env.clock.now}-/work/app`, id, 'e1', 'e2', 'e3'])
  })

  test('corrupt (read ok, parse fails): kept as it is, the entry goes to a side file; an existing side file name is not reused', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: 'nope', [`${DIR}/history-extra-${NOW + MIN}.json`]: '[]' } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[HISTORY]).toBe('nope')
    expect(env.files[`${DIR}/history-extra-${NOW + MIN}.json`]).toBe('[]')
    expect(idsOf(env.files[`${DIR}/history-extra-${NOW + MIN}-2.json`])).toEqual([`${NOW + MIN}-/work/app`])
  })

  test('an unreadable index stops rotation but never the save', async ($, on) => {
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(seed(FULL)), [INDEX]: '{broken' } })
    await start($)
    expect(await flow($, env)).toContain('ok')
    expect(env.files[INDEX]).toBe('{broken')
    expect(archivePaths(env.files)).toEqual([])
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

describe('browsing segments in the panel', () => {
  const latest = [entry(1), entry(2)]
  const one = seed(3, 20) // e20..e22, the oldest
  const two = seed(2, 10) // e10..e11
  const segs = () => [summarize('history-1.json', one), summarize('history-2.json', two)]
  const disk = (): Record<string, string> => ({
    [HISTORY]: JSON.stringify(latest),
    [arc(1)]: JSON.stringify(one),
    [arc(2)]: JSON.stringify(two),
    [INDEX]: JSON.stringify({ segments: segs() }),
  })

  test('the latest segment shows with its span, and Older history lists the archives newest first with summaries', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      let v = await view($, surface)
      expect(v.text).toContain(`Showing ${spanText(entry(2).startedAt, entry(1).endedAt)} · 2 flows`)
      expect(v.groups).toEqual(['e1', 'e2'])
      expect(v.label('history-older')).toBe('▸ Older history (2 files)')
      expect(v.keys.indexOf('history-older')).toBeLessThan(v.keys.indexOf('history-e1'))
      expect(v.keys.some((k: string) => k.startsWith('history-seg-'))).toBe(false)
      expect(v.keys).not.toContain('history-latest')
      await press($, surface, 'history-older')
      v = await view($, surface)
      expect(v.label('history-older')).toBe('▾ Older history (2 files)')
      expect(v.keys.filter((k: string) => k.startsWith('history-seg-'))).toEqual(['history-seg-history-2.json', 'history-seg-history-1.json'])
      const [s1, s2] = segs()
      expect(v.label('history-seg-history-2.json')).toBe(spanText(s2!.from, s2!.to))
      expect(v.label('history-seg-history-1.json')).toBe(spanText(s1!.from, s1!.to))
      expect(v.text).toContain('3 flows · ≈$4.50 · 36k tokens · 1:30:00')
      expect(v.text).toContain('2 flows · ≈$3.00 · 24k tokens · 1:00:00')
      await press($, surface, 'history-older')
    }
    expect(env.writes).toEqual([])
  })

  test('choosing an archive loads only it, Back to latest returns, and browsing writes nothing', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, 'history-older')
      const before = env.reads.length
      await press($, surface, 'history-seg-history-1.json')
      expect(env.reads.slice(before)).toEqual([arc(1)])
      let v = await view($, surface)
      expect(v.groups).toEqual(['e20', 'e21', 'e22'])
      expect(v.keys.filter((k: string) => k.startsWith('history-'))[0]).toBe('history-latest')
      expect(v.keys.indexOf('history-latest')).toBeLessThan(v.keys.indexOf('history-older'))
      expect(v.text).toContain(`Showing ${spanText(entry(22).startedAt, entry(20).endedAt)} · 3 flows`)
      expect(v.keys.some((k: string) => k.startsWith('history-seg-'))).toBe(false)
      await press($, surface, 'history-e20')
      v = await view($, surface)
      expect(v.text).toMatch(/✓ write tests \(careful\)/)
      await press($, surface, 'history-e20', 'history-latest')
      v = await view($, surface)
      expect(v.groups).toEqual(['e1', 'e2'])
      expect(v.keys).not.toContain('history-latest')
    }
    expect(env.writes).toEqual([])
  })

  test('an archive that cannot be read says so and the view stays', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk(), unreadable: [arc(2)] })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      await press($, surface, 'history-older', 'history-seg-history-2.json')
      const v = await view($, surface)
      expect(v.text).toContain('could not load history-2.json')
      expect(v.groups).toEqual(['e1', 'e2'])
      expect(v.keys).not.toContain('history-latest')
      await press($, surface, 'history-older')
    }
    env.files[arc(1)] = 'nope'
    await press($, 'terminal', 'history-older', 'history-seg-history-1.json')
    const v = await view($)
    expect(v.text).toContain('could not load history-1.json')
    expect(v.groups).toEqual(['e1', 'e2'])
    expect(env.writes).toEqual([])
  })

  test('an archive of twelve pages ten at a time with Show older', async ($, on) => {
    const twelve = seed(12, 30)
    const env = engine(on, {
      store: { historyShown: true },
      files: { [HISTORY]: JSON.stringify(latest), [arc(1)]: JSON.stringify(twelve), [INDEX]: JSON.stringify({ segments: [summarize('history-1.json', twelve)] }) },
    })
    await start($)
    await settle()
    await press($, 'terminal', 'history-older', 'history-seg-history-1.json')
    let v = await view($)
    expect(v.groups).toHaveLength(10)
    expect(v.label('history-more')).toBe('Show older (2)')
    await press($, 'terminal', 'history-more')
    v = await view($)
    expect(v.groups).toHaveLength(12)
    expect(env.writes).toEqual([])
  })

  test('a flow recorded while an archive is shown goes to history.json and the archive view stays', async ($, on) => {
    const env = engine(on, { store: { historyShown: true }, files: disk() })
    await start($)
    await settle()
    await press($, 'terminal', 'history-older', 'history-seg-history-2.json')
    const archive = env.files[arc(2)]
    await flow($, env)
    const id = `${NOW + MIN}-/work/app`
    expect(idsOf(env.files[HISTORY])).toEqual([id, 'e1', 'e2'])
    expect(env.files[arc(2)]).toBe(archive)
    let v = await view($)
    expect(v.groups).toEqual(['e10', 'e11'])
    await press($, 'terminal', 'history-latest')
    v = await view($)
    expect(v.groups).toEqual([id, 'e1', 'e2'])
  })

  test('without archives there is no Older history control', async ($, on) => {
    engine(on, { store: { historyShown: true }, files: { [HISTORY]: JSON.stringify(latest) } })
    await start($)
    await settle()
    const v = await view($)
    expect(v.keys).not.toContain('history-older')
    expect(v.text).toContain('· 2 flows')
  })
})
