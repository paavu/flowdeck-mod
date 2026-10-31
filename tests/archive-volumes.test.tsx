import { describe, expect, test } from 'claude-code/testing'

import { keyOf, WRITE_MAX } from '../hooks/archive'
import type { ArchiveEntry } from '../types'
import { fileOf, indexPath, markerPath, records, sessionPaths, sessions } from './archive-files'
import { fakeFs, utf8 } from './fake-fs'
import { showTab } from './tabs'

// The archive before 1.0.0025 as the engine meets it in a project folder: `history.json`, its volumes `history-<n>.json`,
// the volume index `history-index.json` and the side files `history-extra-<startedAt>.json`. A session start imports
// every flow once into its session file and the index, marks the files it imported, and never writes, renames or moves
// one of them. The store itself is tested in archive-store.test.tsx; these go through the engine and the Archive tab.

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const DIR = '/work/app/.claude/flowdeck'
const INDEX = indexPath(DIR)
const MARKER = markerPath(DIR)
const HISTORY = `${DIR}/history.json`
const LEGACY_INDEX = `${DIR}/history-index.json`
const vol = (n: number) => `${DIR}/history-${n}.json`
const extra = (at: number) => `${DIR}/history-extra-${at}.json`
const isLegacy = (path: string) => path.startsWith(`${DIR}/history`)
const sessionFile = (e: { id: string; startedAt: number }) => `${DIR}/archive/${fileOf(e)}`

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

// One project's old archive: history.json with e1-e3 and e6 saved again later, a side file with e4, history-2.json with
// e5, e6 and a copy of e3 that a cut-short rotation left, history-1.json with the oldest, e7-e9, and the volume index.
const RESAVED = entry(6, { title: 'Resaved', endedAt: entry(6).endedAt + MIN })
const legacy = (): Record<string, string> => ({
  [HISTORY]: JSON.stringify([entry(1), entry(2), entry(3), RESAVED]),
  [extra(entry(4).startedAt)]: JSON.stringify([entry(4)]),
  [vol(2)]: JSON.stringify([entry(3), entry(5), entry(6)]),
  [vol(1)]: JSON.stringify([entry(7), entry(8), entry(9)]),
  [LEGACY_INDEX]: JSON.stringify({ segments: [{ file: 'history-1.json', count: 3 }, { file: 'history-2.json', count: 3 }], merged: [] }),
})
const NAMES = Object.keys(legacy())
  .map(p => p.slice(DIR.length + 1))
  .sort()
const IDS = Array.from({ length: 9 }, (_, k) => `e${k + 1}`)
const ALL = IDS.map(keyOf)
// The old files the marker lists, sorted; undefined without a marker.
const marked = (files: Record<string, string>): string[] | undefined => (MARKER in files ? [...JSON.parse(files[MARKER]!).files].sort() : undefined)

type Opts = { store?: Record<string, unknown>; files?: Record<string, string>; unreadable?: string[]; env?: Record<string, string> }

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const fs = fakeFs(on, { files: opts.files, unreadable: opts.unreadable })
  const clock = { now: NOW }
  // every environment variable the mod asks for
  const asked: string[] = []
  on('env.get', (_$: any, e: any) => {
    asked.push(String(e.name))
    return { value: opts.env?.[e.name] }
  })
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
  return { store, files: fs.files, writes: fs.writes, reads: fs.reads, unreadable: fs.unreadable, clock, asked, fs }
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
// The Archive tab.
const pane = async ($: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  await showTab($, 'archive')
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
}
const view = async ($: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  const p = await pane($, surface)
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  const keys = buttons.map((b: any) => String(b.props.key))
  const folds = buttons.filter((b: any) => /^archive-k[a-z0-9]+$/.test(String(b.props.key)))
  return {
    text: texts.map((t: any) => t.text).join('\n'),
    keys,
    // the groups' fold keys, `archive-<keyOf(id)>`, without the prefix
    groups: folds.map((b: any) => String(b.props.key).slice('archive-'.length)),
    open: folds.map((b: any) => JSON.stringify(b).includes('▼ ')),
    label: (key: string) => String(buttons.find((b: any) => String(b.props.key) === key)?.props.label ?? ''),
    tab: buttons.find((b: any) => String(b.props.key) === 'tab-archive')?.text?.replace(/^● /, ''),
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
// A dim line drawn above the groups, on both surfaces.
const saidAbove = async ($: any, text: string, firstKey: string) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const p = await pane($, surface)
    const drawn = JSON.stringify(await p.drawn())
    await p.unmount()
    expect(drawn.indexOf(text)).toBeGreaterThan(-1)
    expect(drawn.indexOf(text)).toBeLessThan(drawn.indexOf(`"archive-${firstKey}"`))
  }
}

describe('the archive before 1.0.0025 is imported once', () => {
  test('history.json, its volumes, the volume index and a side file: every flow once, latest end first, the tab count right; the old files are never written', async ($, on) => {
    const before = legacy()
    const env = engine(on, { files: legacy() })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const v = await view($, surface)
      expect(v.groups).toEqual(ALL)
      expect(v.tab).toBe('Archive (9)')
      expect(v.keys.some((k: string) => /^archive-(older|latest|seg-)/.test(k))).toBe(false)
    }
    // the first group is open and shows its rows, read from its session file
    const v = await view($)
    expect(v.open).toEqual([true, ...Array(8).fill(false)])
    expect(v.text.split('✓ write tests (careful)').length - 1).toBe(1)
    expect(v.text).not.toMatch(/Showing .* flows/)
    // one session file each: e3 once, and of e6 the later-ended copy
    const saved = sessions(env.files, DIR)
    expect(saved.map(e => e.id)).toEqual(IDS)
    expect(saved.find(e => e.id === 'e6').title).toBe('Resaved')
    expect(sessionPaths(env.files, DIR)).toEqual(IDS.map(id => sessionFile(saved.find(e => e.id === id))).sort())
    expect(records(env.files, INDEX)!.map(r => r.id)).toEqual(IDS)
    // the old files are as they were, and none was ever written
    for (const [path, text] of Object.entries(before)) expect(env.files[path]).toBe(text)
    expect(env.fs.tried.map(t => t.path).filter(isLegacy)).toEqual([])
    // the marker lists each one imported
    const marker = JSON.parse(env.files[MARKER]!)
    expect(marker.version).toBe(1)
    expect(marker.at).toBe(NOW)
    expect(marked(env.files)).toEqual(NAMES)
  })

  test('a second session start reads no old file again and writes nothing', async ($, on) => {
    const env = engine(on, { files: legacy() })
    await start($)
    await settle()
    const marker = env.files[MARKER]
    const reads = env.reads.length
    const tried = env.fs.tried.length
    await start($)
    await settle()
    expect(env.reads.slice(reads).filter(isLegacy)).toEqual([])
    expect(env.fs.tried.slice(tried)).toEqual([])
    expect(env.files[MARKER]).toBe(marker)
    const v = await view($)
    expect(v.groups).toEqual(ALL)
    expect(v.tab).toBe('Archive (9)')
  })

  for (const how of ['unreadable', 'corrupt'] as const) {
    test(`a volume that ${how === 'unreadable' ? 'cannot be read' : 'does not parse'} is said above the groups, left as it is and not marked; it is imported on a later load`, async ($, on) => {
      const files = legacy()
      const good = files[vol(1)]!
      if (how === 'corrupt') files[vol(1)] = 'nope'
      const kept = files[vol(1)]
      const env = engine(on, { files, unreadable: how === 'unreadable' ? [vol(1)] : [] })
      const NOTE = 'history-1.json could not be read; it is left as it is and imported on a later load'
      await start($)
      await settle()
      let v = await view($)
      expect(v.groups).toEqual(ALL.slice(0, 6))
      expect(v.tab).toBe('Archive (6)')
      expect(v.text).toContain(NOTE)
      await saidAbove($, NOTE, ALL[0]!)
      expect(env.files[vol(1)]).toBe(kept)
      expect(marked(env.files)).toEqual(NAMES.filter(n => n !== 'history-1.json'))
      // readable again: the next load reads only that file and imports its flows
      env.unreadable.clear()
      env.files[vol(1)] = good
      const reads = env.reads.length
      await start($)
      await settle()
      expect(env.reads.slice(reads).filter(isLegacy)).toEqual([vol(1)])
      v = await view($)
      expect(v.groups).toEqual(ALL)
      expect(v.text).not.toContain(NOTE)
      expect(marked(env.files)).toEqual(NAMES)
      expect(env.fs.tried.map(t => t.path).filter(isLegacy)).toEqual([])
    })
  }

  test('a flow finished after the import gets its own session file and shows first; the old files stay as they were', async ($, on) => {
    const before = legacy()
    const env = engine(on, { files: legacy() })
    await start($)
    await settle()
    expect(await flow($, env)).toContain('ok')
    const id = `${NOW + MIN}-/work/app`
    const v = await view($)
    expect(v.groups).toEqual([keyOf(id), ...ALL])
    expect(v.tab).toBe('Archive (10)')
    expect(sessions(env.files, DIR)[0].id).toBe(id)
    expect(records(env.files, INDEX)!.map(r => r.id)).toEqual([id, ...IDS])
    for (const [path, text] of Object.entries(before)) expect(env.files[path]).toBe(text)
    expect(env.fs.tried.map(t => t.path).filter(isLegacy)).toEqual([])
  })

  test('a marker that does not parse is never written over: the import repeats at each load and duplicates nothing', async ($, on) => {
    const env = engine(on, { files: { ...legacy(), [MARKER]: 'nope' } })
    await start($)
    await settle()
    expect(env.files[MARKER]).toBe('nope')
    expect((await view($)).text).toContain('archive-migrated.json could not be read; the old archive files are imported again (nothing is duplicated)')
    const paths = sessionPaths(env.files, DIR)
    const tried = env.fs.tried.length
    await start($)
    await settle()
    // read again, but each flow is in its file already: nothing is written
    expect(env.fs.tried.slice(tried)).toEqual([])
    expect(sessionPaths(env.files, DIR)).toEqual(paths)
    expect(env.files[MARKER]).toBe('nope')
    expect((await view($)).groups).toEqual(ALL)
  })

  test('a flow the folder refuses stays in its old file, which is not marked; it is imported once the folder takes it', async ($, on) => {
    const before = JSON.stringify([entry(1), entry(2)])
    const env = engine(on, { files: { [HISTORY]: before } })
    env.fs.fail.write = (path: string) => path.startsWith(`${DIR}/archive/`)
    await start($)
    await settle()
    let v = await view($)
    expect(v.text).toContain('could not import "Flow 1"; its old file is kept and tried again')
    expect(v.text).toContain('could not import "Flow 2"; its old file is kept and tried again')
    expect(v.groups).toEqual([])
    expect(MARKER in env.files).toBe(false)
    expect(env.files[HISTORY]).toBe(before)
    env.fs.fail.write = false
    await start($)
    await settle()
    v = await view($)
    expect(v.groups).toEqual(['e1', 'e2'].map(keyOf))
    expect(v.text).not.toContain('could not import')
    expect(marked(env.files)).toEqual(['history.json'])
    expect(env.files[HISTORY]).toBe(before)
  })

  for (const how of ['another session', 'unreadable'] as const) {
    test(`a session file name that holds ${how === 'unreadable' ? 'a file that cannot be read' : 'another session'} is never written over: the flow takes the next name`, async ($, on) => {
      const e1 = entry(1)
      const slot1 = sessionFile(e1)
      const slot2 = slot1.replace(/\.json$/, '-2.json')
      const held = how === 'unreadable' ? '{}' : JSON.stringify(entry(7, { id: 'zz', title: 'Other' }))
      const env = engine(on, { files: { [HISTORY]: JSON.stringify([e1]), [slot1]: held }, unreadable: how === 'unreadable' ? [slot1] : [] })
      await start($)
      await settle()
      expect(env.files[slot1]).toBe(held)
      expect(env.fs.tried.map(t => t.path)).not.toContain(slot1)
      expect(JSON.parse(env.files[slot2]!).id).toBe('e1')
      expect(records(env.files, INDEX)!.find(r => r.id === 'e1').file).toBe(slot2.slice(`${DIR}/archive/`.length))
      const v = await view($)
      if (how === 'unreadable') {
        expect(v.groups).toEqual([keyOf('e1')])
        expect(v.text).toContain(`could not read archive/${fileOf(e1)}`)
      } else expect(v.groups).toEqual(['e1', 'zz'].map(keyOf))
      expect(marked(env.files)).toEqual(['history.json'])
    })
  }
})

describe('a big archive', () => {
  test('120 sessions show 50 rows and Show more (70); each press shows 50 more', async ($, on) => {
    const many = Array.from({ length: 120 }, (_, k) => entry(k + 1))
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(many) } })
    await start($)
    await settle()
    expect(sessionPaths(env.files, DIR)).toHaveLength(120)
    for (const surface of ['terminal', 'desktop'] as const) {
      const v = await view($, surface)
      expect(v.groups).toEqual(many.slice(0, 50).map(e => keyOf(e.id)))
      expect(v.label('archive-more')).toBe('Show more (70)')
      expect(v.tab).toBe('Archive (120)')
    }
    let v = await view($)
    expect(v.open).toEqual([true, ...Array(49).fill(false)])
    await press($, 'terminal', 'archive-more')
    v = await view($)
    expect(v.groups).toEqual(many.slice(0, 100).map(e => keyOf(e.id)))
    expect(v.label('archive-more')).toBe('Show more (20)')
    await press($, 'terminal', 'archive-more')
    v = await view($)
    expect(v.groups).toEqual(many.map(e => keyOf(e.id)))
    expect(v.keys).not.toContain('archive-more')
    expect(v.tab).toBe('Archive (120)')
    // the newest is still the only group open by default
    expect(v.open.filter(Boolean)).toHaveLength(1)
  })
})

describe('data safety', () => {
  test('read, stat, the listing and `exists` all failing: whether anything is there is unknown, so nothing in the folder is written; the flow is kept in the store and shows', async ($, on) => {
    const before = JSON.stringify([entry(1), entry(2)])
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
    expect((await view($)).groups).toEqual([keyOf(id)])
    expect(env.fs.tried).toEqual([])
  })

  test('with stat and the listing failing, `exists` tells a missing file apart: the session file, the index and .gitignore are created', async ($, on) => {
    const env = engine(on)
    env.fs.fail.stat = true
    env.fs.fail.list = true
    await start($)
    await flow($, env)
    const id = `${NOW + MIN}-/work/app`
    expect(sessions(env.files, DIR).map(e => e.id)).toEqual([id])
    expect(records(env.files, INDEX)!.map(r => r.id)).toEqual([id])
    expect(env.files[`${DIR}/.gitignore`]).toBe('*\n')
    expect(MARKER in env.files).toBe(false)
  })

  test('an existing .gitignore that cannot be read is not overwritten', async ($, on) => {
    const env = engine(on, { files: { [`${DIR}/.gitignore`]: 'mine\n' }, unreadable: [`${DIR}/.gitignore`] })
    await start($)
    await flow($, env)
    expect(env.files[`${DIR}/.gitignore`]).toBe('mine\n')
    expect(env.fs.tried.map(t => t.path)).not.toContain(`${DIR}/.gitignore`)
    expect(sessionPaths(env.files, DIR)).toHaveLength(1)
  })

  test('sizes are UTF-8 bytes: each record’s size is its session file’s byte length, for Cyrillic, CJK and emoji, imported or new', async ($, on) => {
    const words = ['Привет мир ', '你好世界和平', '🚀🎉🧪🔥']
    const env = engine(on, { files: { [HISTORY]: JSON.stringify(words.map((w, k) => entry(k + 1, { title: w.repeat(10) }))) } })
    await start($)
    await flow($, env, `${words[2]!.repeat(5)} new`)
    const recs = records(env.files, INDEX)!
    expect(recs).toHaveLength(4)
    for (const r of recs) {
      const text = env.files[`${DIR}/archive/${r.file}`]!
      expect(r.size).toBe(utf8(text))
      expect(r.size).toBeGreaterThan(text.length)
    }
    expect(Math.max(...env.fs.tried.map(t => t.bytes))).toBeLessThan(WRITE_MAX)
  })

  test('the old volume limits are no longer read: with them set tiny, every flow keeps its own file and no volume is made', async ($, on) => {
    const env = engine(on, { env: { FLOWDECK_ARCHIVE_VOLUME_MAX: '2000', FLOWDECK_HISTORY_SEGMENT_MAX: '2000' } })
    await start($)
    for (let i = 0; i < 12; i++) expect(await flow($, env, `Flow n${i}`)).toContain('ok')
    expect(sessionPaths(env.files, DIR)).toHaveLength(12)
    expect(records(env.files, INDEX)).toHaveLength(12)
    expect(Object.keys(env.files).filter(isLegacy)).toEqual([])
    expect(env.asked).not.toContain('FLOWDECK_ARCHIVE_VOLUME_MAX')
    expect(env.asked).not.toContain('FLOWDECK_HISTORY_SEGMENT_MAX')
  })
})
