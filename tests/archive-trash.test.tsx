import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { trashName } from '../hooks/archive-index'
import { fileOf, indexPath, records, seed, sessions, titles, trashCopies, trashIndexPath } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

// The Archive and Trash tabs through the engine: the list drawn from the index alone, a group's file read when it opens,
// at most 10 held, and the move to the trash and back behind an inline confirmation.
const NOW = Date.UTC(2026, 9, 30, 12, 0)
const MIN = 60_000
const ROOT = '/work/app'
const DIR = `${ROOT}/.claude/flowdeck`

function engine(on: any, opts: { store?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const store = opts.store ?? {}
  const fs = fakeFs(on, { files: opts.files })
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, files: fs.files, fs, clock }
}

const start = ($: any, cwd = ROOT) => $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))

// Session `i` ended `i` minutes before NOW: session 1 is the newest.
const entry = (i: number) => ({
  id: `${NOW - 120 * MIN - i}-${ROOT}`,
  project: ROOT,
  title: `Flow ${i}`,
  startedAt: NOW - 120 * MIN - i,
  endedAt: NOW - i * MIN,
  status: 'finished',
  done: 1,
  total: 1,
  tasks: [{ title: `task ${i}`, tier: 'medium' }],
  accepted: [1],
  cost: 1.25,
  tokens: 12_000,
  time: 30 * MIN,
  agents: [{ id: `run-${i}`, type: 'flowdeck:flowdeck-medium', description: `task ${i}`, model: 'claude-opus-5-5', status: 'done', startedAt: NOW - 100 * MIN, endedAt: NOW - 90 * MIN - i, contextTokens: 0, contextMax: 0, tokens: 12_000, costUsd: 1.25, steps: 1, round: 1 }],
})
const K = (i: number) => keyOf(entry(i).id)

const pane = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', tab: Tab = 'archive') => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
}
type Look = { texts: string[]; buttons: { key: string; text: string }[]; keys: string[] }
const look = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', tab: Tab = 'archive'): Promise<Look> => {
  const p = await pane($, surface, tab)
  const texts: string[] = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const buttons: Look['buttons'] = (await p.findAll({ type: 'Button' })).map((b: any) => ({ key: String(b.props.key), text: String(b.text ?? b.props.label ?? '') }))
  await p.unmount()
  return { texts, buttons, keys: buttons.map(b => b.key) }
}
const press = async ($: any, key: string, tab: Tab = 'archive') => {
  const p = await pane($, 'terminal', tab)
  await p.press({ key })
  await settle()
  await p.unmount()
}
const sessionReads = (fs: { reads: string[] }) => fs.reads.filter(r => r.includes('/archive/') || r.includes('/.trash/k'))
const seeded = (n: number) => {
  const files: Record<string, string> = {}
  seed(files, DIR, Array.from({ length: n }, (_, k) => entry(k + 1)))
  return files
}

describe('the Archive list draws from the index alone', () => {
  test('session start reads the first group’s file only; the folded rows need none', async ($, on) => {
    const { fs } = engine(on, { files: seeded(5) })
    await start($)
    await settle()
    expect(sessionReads(fs)).toEqual([`${DIR}/archive/${fileOf(entry(1))}`])
    const t = await look($)
    expect(t.keys.filter(k => /^archive-k[a-z0-9]+$/.test(k))).toEqual([1, 2, 3, 4, 5].map(i => `archive-${K(i)}`))
    expect(t.buttons.find(b => b.key === 'tab-archive')?.text).toBe('Archive (5)')
    expect(t.buttons.find(b => b.key === 'tab-trash')?.text).toBe('Trash (0)')
    // Each row: the chevron first, the date and the item count, its summary below.
    expect(t.buttons.find(b => b.key === `archive-${K(2)}`)?.text).toMatch(/^▶︎ Oct 30, 2026 · \d\d:\d\d \(1\)$/)
    expect(t.texts.filter(x => x === '  ≈$1.25 · 12k tokens · 30:00')).toHaveLength(5)
    // The chevron leads the row; the ✕ comes after the name, and no chevron follows it.
    for (const surface of ['terminal', 'desktop'] as const) {
      const s = await look($, surface)
      const at = (k: string) => s.keys.indexOf(k)
      expect(at(`archive-${K(2)}`)).toBeLessThan(at(`archive-del-${K(2)}`))
      expect(at(`archive-del-${K(2)}`)).toBeLessThan(at(`archive-${K(3)}`))
      // (the open group's own agent rows have their chevrons before their names)
      expect(s.buttons.filter(b => /(?:▶︎|▼)$/.test(b.text) && !/-agent-fold-/.test(b.key))).toEqual([])
    }
  })

  test('with every group folded, drawing both surfaces reads no session file', async ($, on) => {
    const { fs } = engine(on, { files: seeded(4) })
    await start($)
    await settle()
    await press($, `archive-${K(1)}`) // folds the default-open first group
    fs.reads.length = 0
    for (const surface of ['terminal', 'desktop'] as const) {
      const t = await look($, surface)
      expect(t.keys.filter(k => /^archive-k[a-z0-9]+$/.test(k))).toHaveLength(4)
    }
    expect(sessionReads(fs)).toEqual([])
  })

  test('opening a group reads its file once and draws its rows; folding lets it go, and opening again reads it again', async ($, on) => {
    const { fs } = engine(on, { files: seeded(3) })
    await start($)
    await settle()
    fs.reads.length = 0
    await press($, `archive-${K(3)}`)
    expect(sessionReads(fs)).toEqual([`${DIR}/archive/${fileOf(entry(3))}`])
    let t = await look($)
    expect(t.texts.some(x => /task 3/.test(x))).toBe(true)
    expect(t.buttons.find(b => b.key === `archive-${K(3)}`)?.text).toMatch(/^▼ /)
    expect(sessionReads(fs)).toHaveLength(1)
    await press($, `archive-${K(3)}`)
    t = await look($)
    expect(t.texts.some(x => /task 3/.test(x))).toBe(false)
    await press($, `archive-${K(3)}`)
    expect(sessionReads(fs)).toHaveLength(2)
  })

  test('a group whose file cannot be read says so and keeps its row; a missing file says file missing', async ($, on) => {
    const files = seeded(3)
    const { fs } = engine(on, { files })
    fs.unreadable.add(`${DIR}/archive/${fileOf(entry(1))}`)
    delete files[`${DIR}/archive/${fileOf(entry(2))}`]
    await start($)
    await settle()
    await press($, `archive-${K(2)}`)
    const t = await look($)
    expect(t.texts).toContain(`  could not read ${fileOf(entry(1))}`)
    expect(t.texts).toContain('  file missing')
    expect(t.texts.some(x => / · file missing$/.test(x))).toBe(true)
    expect(t.buttons.find(b => b.key === 'tab-archive')?.text).toBe('Archive (3)')
  })

  test('at most 10 files are held: opening one more folds the group opened longest ago', async ($, on) => {
    engine(on, { files: seeded(12) })
    await start($)
    await settle()
    // The first group is open and held; ten more opened push it out.
    for (let i = 2; i <= 11; i++) await press($, `archive-${K(i)}`)
    const t = await look($)
    expect(t.buttons.find(b => b.key === `archive-${K(1)}`)?.text).toMatch(/^▶︎ /)
    for (let i = 2; i <= 11; i++) expect(t.buttons.find(b => b.key === `archive-${K(i)}`)?.text).toMatch(/^▼ /)
    expect(t.texts.filter(x => x === '  loading…')).toEqual([])
  })

  test('50 rows at first, then Show more adds 50', async ($, on) => {
    engine(on, { files: seeded(60) })
    await start($)
    await settle()
    let t = await look($)
    expect(t.keys.filter(k => /^archive-k[a-z0-9]+$/.test(k))).toHaveLength(50)
    expect(t.buttons.find(b => b.key === 'archive-more')?.text).toBe('Show more (10)')
    await press($, 'archive-more')
    t = await look($)
    expect(t.keys.filter(k => /^archive-k[a-z0-9]+$/.test(k))).toHaveLength(60)
    expect(t.keys).not.toContain('archive-more')
  })
})

describe('an opened session shows its totals as the Active and Finished tabs do', () => {
  const tileTexts = async ($: any, tab: Tab) => {
    const p = await pane($, 'desktop', tab)
    const sources = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.source ?? ''))
    await p.unmount()
    const tiles = sources.find(x => x.includes('class="tile"'))
    return tiles ? [...tiles.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]) : []
  }

  test('desktop: the three tiles in the open Archive and Trash groups, the plain summary only on folded rows', async ($, on) => {
    const { clock } = engine(on, { files: seeded(2) })
    await start($)
    await settle()
    expect(await tileTexts($, 'archive')).toEqual(['Cost', '≈$1.25', 'Tokens', '12k', 'Time', '30:00'])
    const a = await look($, 'desktop')
    expect(a.texts.filter(x => x === '  ≈$1.25 · 12k tokens · 30:00')).toHaveLength(1) // the folded second row only
    clock.now = NOW + MIN
    await press($, `archive-del-${K(1)}`)
    await press($, `archive-trash-${K(1)}`)
    expect(await tileTexts($, 'trash')).toEqual(await tileTexts($, 'archive'))
    expect((await tileTexts($, 'trash')).length).toBe(6)
  })

  test('terminal: the same text form on the open and the folded rows', async ($, on) => {
    engine(on, { files: seeded(2) })
    await start($)
    await settle()
    const t = await look($)
    expect(t.texts.filter(x => x === '  ≈$1.25 · 12k tokens · 30:00')).toHaveLength(2)
  })
})

describe('moving a session to the trash', () => {
  test('✕ asks first: the confirmation shows the session and changes nothing until confirmed; Cancel keeps everything', async ($, on) => {
    const { files } = engine(on, { files: seeded(3) })
    await start($)
    await settle()
    const before = JSON.stringify(files)
    await press($, `archive-del-${K(2)}`)
    for (const surface of ['terminal', 'desktop'] as const) {
      const t = await look($, surface)
      expect(t.texts).toContain('Move this session to the trash?')
      expect(t.texts.some(x => /^Oct 30, 2026 · \d\d:\d\d \(1\)$/.test(x))).toBe(true)
      expect(t.texts).toContain('Flow 2')
      expect(t.texts).toContain('≈$1.25 · 12k tokens · 30:00')
      expect(t.texts).toContain(`.claude/flowdeck/archive/${fileOf(entry(2))}`)
      expect(t.texts.some(x => /nothing is erased/.test(x))).toBe(true)
      expect(t.keys).toContain(`archive-trash-${K(2)}`)
      expect(t.keys).toContain(`archive-cancel-${K(2)}`)
      // The row it replaces is gone meanwhile; the others stay.
      expect(t.keys).not.toContain(`archive-${K(2)}`)
      expect(t.keys).toContain(`archive-${K(3)}`)
    }
    // Only one confirmation at a time.
    await press($, `archive-del-${K(3)}`)
    let t = await look($)
    expect(t.keys).toContain(`archive-trash-${K(3)}`)
    expect(t.keys).not.toContain(`archive-trash-${K(2)}`)
    await press($, `archive-cancel-${K(3)}`)
    t = await look($)
    expect(t.texts).not.toContain('Move this session to the trash?')
    expect(t.buttons.find(b => b.key === 'tab-archive')?.text).toBe('Archive (3)')
    expect(JSON.stringify(files)).toBe(before)
  })

  test('confirmed: the row leaves the Archive for the Trash, its file is copied to .trash/ and kept in archive/', async ($, on) => {
    const { files, clock } = engine(on, { files: seeded(3) })
    await start($)
    await settle()
    const own = files[`${DIR}/archive/${fileOf(entry(2))}`]
    clock.now = NOW + MIN
    await press($, `archive-del-${K(2)}`)
    await press($, `archive-trash-${K(2)}`)
    expect(files[`${DIR}/archive/${fileOf(entry(2))}`]).toBe(own)
    expect(files[`${DIR}/.trash/${trashName(fileOf(entry(2)), NOW + MIN)}`]).toBe(own)
    expect(titles(records(files, trashIndexPath(DIR)))).toEqual(['Flow 2'])
    expect(records(files, indexPath(DIR))!.find((r: any) => r.title === 'Flow 2').trashedAt).toBe(NOW + MIN)
    expect(sessions(files, DIR)).toHaveLength(3)
    for (const surface of ['terminal', 'desktop'] as const) {
      const a = await look($, surface)
      expect(a.buttons.find(b => b.key === 'tab-archive')?.text).toBe('Archive (2)')
      expect(a.buttons.find(b => b.key === 'tab-trash')?.text).toBe('Trash (1)')
      expect(a.keys).not.toContain(`archive-${K(2)}`)
      const t = await look($, surface, 'trash')
      expect(t.keys.filter(k => /^trash-k[a-z0-9]+$/.test(k))).toEqual([`trash-${K(2)}`])
      expect(t.buttons.find(b => b.key === `trash-${K(2)}`)?.text).toMatch(/^▼ Oct 30, 2026 · \d\d:\d\d \(1\)$/)
      expect(t.buttons.find(b => b.key === `trash-restore-${K(2)}`)?.text).toBe('Restore')
      if (surface === 'terminal') expect(t.texts).toContain('  ≈$1.25 · 12k tokens · 30:00')
      // Its first group opens with the trash copy's rows.
      expect(t.texts.some(x => /task 2/.test(x))).toBe(true)
      expect(t.keys.some(k => k.startsWith('archive-del-'))).toBe(false)
    }
  })

  test('restore brings it back to its place by its end; the Trash is empty again; nothing is duplicated', async ($, on) => {
    const { files, clock } = engine(on, { files: seeded(3) })
    await start($)
    await settle()
    clock.now = NOW + MIN
    await press($, `archive-del-${K(2)}`)
    await press($, `archive-trash-${K(2)}`)
    clock.now = NOW + 2 * MIN
    await press($, `trash-restore-${K(2)}`, 'trash')
    let t = await look($, 'terminal', 'trash')
    expect(t.texts).toContain('Move back to the Archive?')
    expect(t.texts).toContain('Flow 2')
    expect(t.keys).toContain(`trash-restore-yes-${K(2)}`)
    expect(t.keys).toContain(`trash-cancel-${K(2)}`)
    await press($, `trash-restore-yes-${K(2)}`, 'trash')
    t = await look($, 'terminal', 'trash')
    expect(t.texts).toContain('Trash is empty')
    expect(t.buttons.find(b => b.key === 'tab-trash')?.text).toBe('Trash (0)')
    const a = await look($)
    expect(a.keys.filter(k => /^archive-k[a-z0-9]+$/.test(k))).toEqual([1, 2, 3].map(i => `archive-${K(i)}`))
    expect(sessions(files, DIR)).toHaveLength(3)
    expect(trashCopies(files, DIR)).toHaveLength(1) // the copy stays in .trash/, marked restored
    expect(records(files, trashIndexPath(DIR))![0].restoredAt).toBe(NOW + 2 * MIN)
  })

  test('without a project folder there is no ✕ and no Restore', async ($, on) => {
    engine(on, { store: { history: [entry(1), entry(2)] } })
    await start($, '')
    await settle()
    const t = await look($)
    expect(t.keys.filter(k => /^archive-k[a-z0-9]+$/.test(k))).toHaveLength(2)
    expect(t.keys.some(k => k.startsWith('archive-del-'))).toBe(false)
  })
})
