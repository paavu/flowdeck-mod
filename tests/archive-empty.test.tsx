import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { trashName } from '../hooks/archive-index'
import { eraseSessionFile } from '../hooks/archive-store'
import { fileOf, indexPath, records, seed, sessionPaths, titles, trashIndexPath } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

// Empty Trash: the Trash tab's first line while it holds sessions, an inline confirmation, then each trashed session
// erased (its original in `archive/`, then its copies in `.trash/`) one file at a time through a host command (`unlink`;
// PowerShell on Windows), each path checked to lie in its folder.
const NOW = Date.UTC(2026, 9, 30, 12, 0)
const MIN = 60_000

function engine(on: any, root: string, opts: { files?: Record<string, string>; refuse?: (path: string) => boolean } = {}) {
  const fs = fakeFs(on, { files: opts.files })
  const clock = { now: NOW }
  const runs: { argv: string[]; env?: Record<string, string> }[] = []
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
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  // The host: `unlink <path>`, or PowerShell with the path in FLOWDECK_ERASE_FILE, takes the file out of the fake fs.
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    const env = e.init?.env as Record<string, string> | undefined
    runs.push({ argv, env })
    const named = argv[0] === 'unlink' ? argv[1] : argv[0] === 'powershell.exe' ? env?.FLOWDECK_ERASE_FILE : undefined
    const path = Object.keys(fs.aliases).find(k => fs.aliases[k] === named) ?? named
    if (!path || opts.refuse?.(path) || !(path in fs.files)) return { value: { exitCode: 1, stdout: '', stderr: 'refused' } }
    delete fs.files[path]
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { files: fs.files, fs, clock, runs }
}

const start = ($: any, cwd: string) => $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))

const entry = (i: number, root: string) => ({
  id: `${NOW - 120 * MIN - i}-${root}`,
  project: root,
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
  agents: [],
})

const pane = async ($: any, surface: 'terminal' | 'desktop', tab: Tab) => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
}
type Look = { texts: string[]; buttons: { key: string; text: string }[]; keys: string[] }
const look = async ($: any, tab: Tab = 'trash', surface: 'terminal' | 'desktop' = 'terminal'): Promise<Look> => {
  const p = await pane($, surface, tab)
  const texts: string[] = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const buttons: Look['buttons'] = (await p.findAll({ type: 'Button' })).map((b: any) => ({ key: String(b.props.key), text: String(b.text ?? b.props.label ?? '') }))
  await p.unmount()
  return { texts, buttons, keys: buttons.map(b => b.key) }
}
const press = async ($: any, key: string, tab: Tab = 'trash') => {
  const p = await pane($, 'terminal', tab)
  await p.press({ key })
  await settle()
  await p.unmount()
}

// A project of `n` saved sessions with the given ones moved to the trash (session i at NOW + i minutes).
async function setup($: any, on: any, opts: { root?: string; n?: number; trash?: number[]; refuse?: (path: string) => boolean; extra?: Record<string, string> } = {}) {
  const root = opts.root ?? '/work/app'
  const dir = `${root}/.claude/flowdeck`
  const files: Record<string, string> = { ...(opts.extra ?? {}) }
  seed(files, dir, Array.from({ length: opts.n ?? 3 }, (_, k) => entry(k + 1, root)))
  const eng = engine(on, root, { files, refuse: opts.refuse })
  await start($, root)
  await settle()
  for (const i of opts.trash ?? []) {
    eng.clock.now = NOW + i * MIN
    await press($, `archive-del-${keyOf(entry(i, root).id)}`, 'archive')
    await press($, `archive-trash-${keyOf(entry(i, root).id)}`, 'archive')
  }
  const copy = (i: number) => `${dir}/.trash/${trashName(fileOf(entry(i, root)), NOW + i * MIN)}`
  return { ...eng, root, dir, copy }
}

describe('the Empty Trash button', () => {
  test('shows at the top of the Trash tab only while it holds sessions, never on the Archive tab', async ($, on) => {
    await setup($, on, { trash: [1, 2] })
    for (const surface of ['terminal', 'desktop'] as const) {
      const t = await look($, 'trash', surface)
      expect(t.buttons.find(b => b.key === 'trash-empty')?.text).toBe('Empty Trash (2)')
      // Before the first session row.
      expect(t.keys.indexOf('trash-empty')).toBeLessThan(t.keys.findIndex(k => /^trash-k[a-z0-9]+$/.test(k)))
      const a = await look($, 'archive', surface)
      expect(a.keys.some(k => k.startsWith('trash-empty'))).toBe(false)
    }
  })

  test('an empty Trash shows its empty line and no button', async ($, on) => {
    await setup($, on)
    const t = await look($)
    expect(t.texts).toContain('Trash is empty')
    expect(t.keys.some(k => k.startsWith('trash-empty'))).toBe(false)
  })
})

describe('Empty Trash asks first', () => {
  test('the line turns into a confirmation naming what goes; it survives a redraw and changes nothing; Cancel brings the button back', async ($, on) => {
    const { files, runs } = await setup($, on, { trash: [1, 2] })
    const before = JSON.stringify(files)
    await press($, 'trash-empty')
    for (const surface of ['terminal', 'desktop'] as const) {
      const t = await look($, 'trash', surface)
      expect(t.texts).toContain('Erase 2 sessions for good? This cannot be undone.')
      expect(t.buttons.find(b => b.key === 'trash-empty-yes')?.text).toBe('Erase')
      expect(t.buttons.find(b => b.key === 'trash-empty-cancel')?.text).toBe('Cancel')
      expect(t.keys).not.toContain('trash-empty')
      // The rows stay below it.
      expect(t.keys.filter(k => /^trash-k[a-z0-9]+$/.test(k))).toHaveLength(2)
    }
    expect(JSON.stringify(files)).toBe(before)
    expect(runs).toEqual([])
    await press($, 'trash-empty-cancel')
    const t = await look($)
    expect(t.texts).not.toContain('Erase 2 sessions for good? This cannot be undone.')
    expect(t.buttons.find(b => b.key === 'trash-empty')?.text).toBe('Empty Trash (2)')
    expect(JSON.stringify(files)).toBe(before)
    expect(runs).toEqual([])
  })

  test('one session reads in the singular; switching tab closes the confirmation', async ($, on) => {
    const { runs } = await setup($, on, { trash: [2] })
    await press($, 'trash-empty')
    expect((await look($)).texts).toContain('Erase 1 session for good? This cannot be undone.')
    await showTab($, 'archive')
    const t = await look($)
    expect(t.keys).toContain('trash-empty')
    expect(t.keys).not.toContain('trash-empty-yes')
    expect(runs).toEqual([])
  })
})

describe('Erase', () => {
  test('erases each trashed session for good, its original in archive/ and its copy in .trash/; the trash index is empty; nothing else changes', async ($, on) => {
    const root = '/work/app'
    const dir = `${root}/.claude/flowdeck`
    const extra = { [`${dir}/.trash/damaged/archive-index-1.json`]: 'damaged', [`${dir}/plans/p.json`]: '{"keep":1}', [`${dir}/notes.txt`]: 'keep' }
    const s = await setup($, on, { root, trash: [1, 3], extra })
    const original = (i: number) => `${dir}/archive/${fileOf(entry(i, root))}`
    const erased = [original(1), s.copy(1), original(3), s.copy(3)]
    for (const p of erased) expect(p in s.files).toBe(true)
    const before = { ...s.files }
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.runs.map(r => r.argv[1]).sort()).toEqual([...erased].sort())
    expect(s.runs.every(r => r.argv.length === 2 && r.argv[0] === 'unlink')).toBe(true)
    // Each session's original goes before its copy.
    expect(s.runs.map(r => r.argv[1]).indexOf(original(1))).toBeLessThan(s.runs.map(r => r.argv[1]).indexOf(s.copy(1)))
    for (const p of erased) expect(p in s.files).toBe(false)
    expect(records(s.files, trashIndexPath(dir))).toEqual([])
    // Every other file is as it was: the Archive's session, archive-index.json, damaged/, plans/, the rest.
    for (const [p, text] of Object.entries(before)) if (!erased.includes(p) && p !== trashIndexPath(dir)) expect(s.files[p]).toBe(text)
    expect(sessionPaths(s.files, dir)).toEqual([original(2)])
    const t = await look($)
    expect(t.texts).toContain('Trash is empty')
    expect(t.buttons.find(b => b.key === 'tab-trash')?.text).toBe('Trash (0)')
    expect(t.keys.some(k => k.startsWith('trash-empty'))).toBe(false)
    expect(t.texts.some(x => /erased|failed/.test(x))).toBe(false)
    const a = await look($, 'archive')
    expect(a.buttons.find(b => b.key === 'tab-archive')?.text).toBe('Archive (1)')
    expect(a.keys).toContain(`archive-${keyOf(entry(2, root).id)}`)
  })

  test('a session back in the Archive keeps its archive file: only its restored copy goes', async ($, on) => {
    const s = await setup($, on, { trash: [2, 3] })
    s.clock.now = NOW + 10 * MIN
    await press($, `trash-restore-${keyOf(entry(2, s.root).id)}`)
    await press($, `trash-restore-yes-${keyOf(entry(2, s.root).id)}`)
    const original = (i: number) => `${s.dir}/archive/${fileOf(entry(i, s.root))}`
    const kept = s.files[original(2)]
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.files[original(2)]).toBe(kept)
    expect(s.copy(2) in s.files).toBe(false)
    expect(original(3) in s.files).toBe(false)
    expect(s.copy(3) in s.files).toBe(false)
    expect(s.runs.some(r => r.argv.includes(original(2)))).toBe(false)
    expect(records(s.files, trashIndexPath(s.dir))).toEqual([])
    const a = await look($, 'archive')
    expect(a.buttons.find(b => b.key === 'tab-archive')?.text).toBe('Archive (2)')
    expect(a.keys).toContain(`archive-${keyOf(entry(2, s.root).id)}`)
  })

  test('an original or copy already gone counts as erased: no command for it', async ($, on) => {
    const s = await setup($, on, { trash: [1, 2] })
    const original = (i: number) => `${s.dir}/archive/${fileOf(entry(i, s.root))}`
    delete s.files[s.copy(1)]
    delete s.files[original(2)]
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.runs.map(r => r.argv[1]).sort()).toEqual([original(1), s.copy(2)].sort())
    expect(records(s.files, trashIndexPath(s.dir))).toEqual([])
    expect((await look($)).texts).toContain('Trash is empty')
  })

  test('a copy that cannot be erased keeps its session in the Trash, and the tab counts sessions', async ($, on) => {
    let blocked = ''
    const s = await setup($, on, { trash: [1, 2], refuse: p => p === blocked })
    blocked = s.copy(2)
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.copy(1) in s.files).toBe(false)
    expect(s.copy(2) in s.files).toBe(true)
    expect(titles(records(s.files, trashIndexPath(s.dir)))).toEqual(['Flow 2'])
    const t = await look($)
    expect(t.texts).toContain('1 session erased, 1 failed')
    expect(t.buttons.find(b => b.key === 'tab-trash')?.text).toBe('Trash (1)')
    expect(t.buttons.find(b => b.key === 'trash-empty')?.text).toBe('Empty Trash (1)')
    // Pressed again once the copy can go, the session is erased.
    blocked = ''
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.copy(2) in s.files).toBe(false)
    expect(records(s.files, trashIndexPath(s.dir))).toEqual([])
  })

  test('an original that cannot be erased leaves the session whole: its copy and record stay', async ($, on) => {
    let blocked = ''
    const s = await setup($, on, { trash: [1, 2], refuse: p => p === blocked })
    blocked = `${s.dir}/archive/${fileOf(entry(2, s.root))}`
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(blocked in s.files).toBe(true)
    expect(s.copy(2) in s.files).toBe(true)
    expect(s.runs.some(r => r.argv.includes(s.copy(2)))).toBe(false)
    expect(titles(records(s.files, trashIndexPath(s.dir)))).toEqual(['Flow 2'])
    const t = await look($)
    expect(t.texts).toContain('1 session erased, 1 failed')
    expect(t.keys).toContain(`trash-restore-${keyOf(entry(2, s.root).id)}`)
  })

  test('a trash record whose file name would leave .trash/ is refused: the file it names is untouched, the session stays', async ($, on) => {
    const s = await setup($, on, { trash: [2] })
    const outside = `${s.dir}/archive/${fileOf(entry(1, s.root))}`
    const index = JSON.parse(s.files[trashIndexPath(s.dir)]!)
    index.sessions[0].file = `../archive/${fileOf(entry(1, s.root))}`
    s.files[trashIndexPath(s.dir)] = JSON.stringify(index)
    const kept = s.files[outside]
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.files[outside]).toBe(kept)
    expect(s.runs.some(r => r.argv.includes(outside))).toBe(false)
    expect(records(s.files, trashIndexPath(s.dir))!.map((r: any) => r.file)).toContain(`../archive/${fileOf(entry(1, s.root))}`)
    expect((await look($)).texts).toContain('0 sessions erased, 1 failed')
  })

  test('a copy that is a link leading out of .trash/ is refused: the file it leads to is untouched', async ($, on) => {
    const s = await setup($, on, { trash: [2] })
    const outside = `${s.dir}/archive/${fileOf(entry(1, s.root))}`
    s.fs.links[s.copy(2)] = outside
    const kept = s.files[outside]
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.runs.some(r => r.argv.includes(outside) || r.argv.includes(s.copy(2)))).toBe(false)
    expect(s.files[outside]).toBe(kept)
    expect(s.copy(2) in s.files).toBe(true)
    expect(titles(records(s.files, trashIndexPath(s.dir)))).toEqual(['Flow 2'])
    expect((await look($)).texts).toContain('0 sessions erased, 1 failed')
  })

  test('eraseSessionFile refuses any name but the session’s own in its folder, and runs nothing', async () => {
    const runs: string[][] = []
    const id = `${NOW}-/work/app`
    const dir = '/work/app/.claude/flowdeck'
    const own = `${keyOf(id)}-${NOW}.json`
    const files = new Set([`${dir}/archive/${own}`, `${dir}/archive/${keyOf('other')}-${NOW}.json`, `${dir}/secret.json`])
    const io: any = {
      read: () => Promise.reject(new Error('ENOENT')),
      write: () => Promise.reject(new Error('EACCES')),
      stat: (p: string) => (files.has(p) ? Promise.resolve({ kind: 'file' }) : Promise.reject(new Error('ENOENT'))),
      list: () => Promise.reject(new Error('EIO')),
      exists: (p: string) => Promise.resolve(files.has(p)),
      storeGet: () => Promise.resolve(undefined),
      storeSet: () => Promise.resolve(undefined),
      statReal: (p: string) => Promise.resolve({ kind: p.endsWith('.json') ? 'file' : 'dir', isLink: false, realPath: p }),
      run: (argv: string[]) => {
        runs.push(argv)
        files.delete(argv[1]!)
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
      },
    }
    for (const file of ['../secret.json', `../archive/${own}`, `${keyOf('other')}-${NOW}.json`, `${keyOf(id)}-${NOW}-t${NOW}.json`, `${keyOf(id)}-*.json`, `sub/${own}`, `${own}/`]) {
      expect(await eraseSessionFile(io, dir, 'archive', { id, file })).toBe('failed')
    }
    expect(await eraseSessionFile(io, dir, 'trash', { id, file: own })).toBe('failed')
    expect(runs).toEqual([])
    expect(await eraseSessionFile(io, dir, 'archive', { id, file: own })).toBe('erased')
    expect(runs).toEqual([['unlink', `${dir}/archive/${own}`]])
    expect(files.has(`${dir}/archive/${keyOf('other')}-${NOW}.json`)).toBe(true)
    expect(files.has(`${dir}/secret.json`)).toBe(true)
  })

  test('on Windows each file goes through PowerShell Remove-Item -LiteralPath, the path passed in the environment', async ($, on) => {
    const s = await setup($, on, { trash: [1] })
    const name = s.copy(1).slice(s.copy(1).lastIndexOf('/') + 1)
    const own = fileOf(entry(1, s.root))
    const win = 'C:\\work\\app\\.claude\\flowdeck'
    s.fs.aliases[`${s.dir}/.trash`] = `${win}\\.trash`
    s.fs.aliases[s.copy(1)] = `${win}\\.trash\\${name}`
    s.fs.aliases[`${s.dir}/archive`] = `${win}\\archive`
    s.fs.aliases[`${s.dir}/archive/${own}`] = `${win}\\archive\\${own}`
    await press($, 'trash-empty')
    await press($, 'trash-empty-yes')
    expect(s.runs).toHaveLength(2)
    for (const run of s.runs) {
      expect(run.argv[0]).toBe('powershell.exe')
      expect(run.argv.join(' ')).toContain('Remove-Item -LiteralPath $p')
      expect(run.argv.join(' ')).not.toContain('.json')
    }
    expect(s.runs.map(r => r.env)).toEqual([{ FLOWDECK_ERASE_FILE: `${win}\\archive\\${own}` }, { FLOWDECK_ERASE_FILE: `${win}\\.trash\\${name}` }])
    expect(s.copy(1) in s.files).toBe(false)
    expect(`${s.dir}/archive/${own}` in s.files).toBe(false)
    expect(records(s.files, trashIndexPath(s.dir))).toEqual([])
  })
})
