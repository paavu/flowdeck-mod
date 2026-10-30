import { describe, expect, test } from 'claude-code/testing'

import { keyOf, WRITE_MAX } from '../hooks/archive'
import { indexText, reconcile, recordOf, sessionName, trashName } from '../hooks/archive-index'
import type { Io } from '../hooks/archive-store'
import { loadArchive, readSession, restoreSession, saveSession, trashSession } from '../hooks/archive-store'
import type { ArchiveEntry } from '../types'
import { indexPath, markerPath, records, sessions, titles, trashIndexPath } from './archive-files'

// The store's own tests, through an Io over a plain object of files, as the engine's fs behaves: a write makes its
// folders, a listing names files and folders (`kind`), a read over 4 MiB or of a missing file rejects. `hold` stops any
// call until released, so two saves can interleave; `deny` makes chosen calls reject.
const ROOT = '/work/app'
const DIR = `${ROOT}/.claude/flowdeck`
const NOW = Date.UTC(2026, 9, 30, 10, 0)
const MIN = 60_000

type Op = 'read' | 'write' | 'stat' | 'list' | 'exists'
function memIo(files: Record<string, string> = {}, store: { history?: unknown } = {}) {
  const deny: { op: Op; path: RegExp }[] = []
  const calls: { op: Op; path: string }[] = []
  let hold: ((op: Op, path: string) => Promise<void> | void) | null = null
  const check = async (op: Op, path: string) => {
    calls.push({ op, path })
    await hold?.(op, path)
    if (deny.some(d => d.op === op && d.path.test(path))) throw new Error('EIO')
  }
  const children = (dir: string) => {
    const pre = `${dir.replace(/\/$/, '')}/`
    const out = new Map<string, 'file' | 'dir'>()
    for (const p of Object.keys(files)) {
      if (!p.startsWith(pre)) continue
      const rest = p.slice(pre.length)
      const cut = rest.indexOf('/')
      out.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
    }
    return out
  }
  const io: Io = {
    read: async path => {
      await check('read', path)
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    },
    write: async (path, text) => {
      await check('write', path)
      if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error('too big')
      files[path] = text
    },
    stat: async path => {
      await check('stat', path)
      if (path in files) return { kind: 'file' }
      if (children(path).size) return { kind: 'dir' }
      throw new Error('ENOENT')
    },
    list: async dir => {
      await check('list', dir)
      const c = children(dir)
      if (!c.size) throw new Error('ENOENT')
      return [...c].map(([name, kind]) => ({ name, kind }))
    },
    exists: async path => {
      await check('exists', path)
      return path in files || children(path).size > 0
    },
    storeGet: async () => store.history,
    storeSet: async v => {
      store.history = v
    },
  }
  return { io, files, store, deny, calls, setHold: (h: typeof hold) => (hold = h) }
}

const flowEntry = (i: number, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  id: `${NOW - 100 * MIN + i}-${ROOT}`,
  project: ROOT,
  title: `Flow ${i}`,
  startedAt: NOW - 100 * MIN + i,
  endedAt: NOW - 50 * MIN + i * MIN,
  status: 'finished',
  done: 1,
  total: 1,
  tasks: [{ title: `task ${i}`, tier: 'medium' }],
  cost: 0.5 * i,
  tokens: 1000 * i,
  time: 10 * MIN,
  agents: [{ id: `a${i}`, type: 'flowdeck:flowdeck-medium', description: `task ${i}`, model: 'claude-opus-5-5', status: 'done', startedAt: NOW - 90 * MIN, endedAt: NOW - 80 * MIN, contextTokens: 0, contextMax: 0, tokens: 1000 * i, costUsd: 0.5 * i, steps: 1, round: 1 }],
  ...over,
})

const legacyText = (list: ArchiveEntry[]) => JSON.stringify(list)

describe('saving one session', () => {
  test('the session file is written first, then the index lists it; the index draws without the file', async () => {
    const m = memIo()
    const e = flowEntry(1)
    const saved = await saveSession(m.io, ROOT, e, NOW)
    expect(saved.isSaved).toBe(true)
    const writes = m.calls.filter(c => c.op === 'write').map(c => c.path.slice(DIR.length + 1))
    expect(writes.indexOf(`archive/${sessionName(e)}`)).toBeLessThan(writes.indexOf('archive-index.json'))
    expect(sessions(m.files, DIR).map(x => x.id)).toEqual([e.id])
    const recs = records(m.files, indexPath(DIR))!
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ id: e.id, file: sessionName(e), kind: 'flow', title: 'Flow 1', itemCount: 1, taskCount: 1, cost: 0.5, tokens: 1000, time: 10 * MIN })
    expect(recs[0].size).toBe(new TextEncoder().encode(m.files[`${DIR}/archive/${sessionName(e)}`]!).length)
    expect(JSON.parse(m.files[indexPath(DIR)]!).version).toBe(1)
    expect(saved.lists!.records.map(r => r.id)).toEqual([e.id])
    expect(m.files[`${DIR}/.gitignore`]).toBe('*\n')
  })

  test('file names are made only of [a-z0-9-] and differ per session', async () => {
    const m = memIo()
    const a = flowEntry(1, { id: 'Ünïcode /path\\with spaces' })
    const b = flowEntry(1, { id: 'another' })
    await saveSession(m.io, ROOT, a, NOW)
    await saveSession(m.io, ROOT, b, NOW)
    const names = Object.keys(m.files).filter(p => p.startsWith(`${DIR}/archive/`)).map(p => p.slice(`${DIR}/archive/`.length))
    expect(names).toHaveLength(2)
    for (const n of names) expect(n).toMatch(/^[a-z0-9-]+\.json$/)
    expect(names).toContain(`${keyOf(a.id)}-${a.startedAt}.json`)
  })

  test('a later save of the same session replaces its file and record; an older one never overwrites a newer', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, { ...e, partial: true, status: 'open' }, NOW)
    await saveSession(m.io, ROOT, { ...e, endedAt: e.endedAt + MIN, title: 'Final' }, NOW)
    await saveSession(m.io, ROOT, { ...e, title: 'Stale' }, NOW)
    expect(titles(sessions(m.files, DIR))).toEqual(['Final'])
    expect(titles(records(m.files, indexPath(DIR)))).toEqual(['Final'])
    expect(records(m.files, indexPath(DIR))![0].partial).toBeUndefined()
  })

  test('other sessions in the index are never dropped; the index is newest first by the session end', async () => {
    const m = memIo()
    for (const i of [3, 1, 2]) await saveSession(m.io, ROOT, flowEntry(i), NOW)
    expect(titles(records(m.files, indexPath(DIR)))).toEqual(['Flow 3', 'Flow 2', 'Flow 1'])
  })

  test('a session over 3,900,000 bytes is refused: nothing is written and the save says so', async () => {
    const m = memIo()
    const big = flowEntry(1, { title: 'x', tasks: Array.from({ length: 100 }, () => ({ title: 'y'.repeat(200), tier: 'medium' })) })
    // A session that big takes many runs; the guard is checked on the text itself.
    const huge = { ...big, agents: Array.from({ length: 60 }, (_, k) => ({ ...big.agents![0]!, id: `a${k}`, description: 'é'.repeat(40_000) })) } as ArchiveEntry
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(WRITE_MAX)
    const saved = await saveSession(m.io, ROOT, huge, NOW)
    expect(saved.isSaved).toBe(false)
    expect(saved.isTooBig).toBe(true)
    expect(Object.keys(m.files).some(p => p.includes('/archive/'))).toBe(false)
  })

  test('two saves interleaved: the later index write lacks the other session, the next load lists it again', async () => {
    const m = memIo()
    const a = flowEntry(1)
    const b = flowEntry(2)
    // A reads the index, then waits; B saves whole; A writes its index without B.
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    let isHeld = false
    m.setHold(async (op, path) => {
      if (!isHeld && op === 'write' && path === indexPath(DIR)) {
        isHeld = true
        await gate
      }
    })
    const first = saveSession(m.io, ROOT, a, NOW)
    await new Promise(r => (globalThis as any).setTimeout(r, 20))
    m.setHold(null)
    await saveSession(m.io, ROOT, b, NOW)
    release()
    await first
    expect(titles(records(m.files, indexPath(DIR))).length).toBeGreaterThanOrEqual(1)
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(titles(records(m.files, indexPath(DIR)))).toEqual(['Flow 2', 'Flow 1'])
  })
})

describe('the index heals itself', () => {
  test('a session file the index does not list is read once and added; the index is rewritten', async () => {
    const m = memIo()
    await saveSession(m.io, ROOT, flowEntry(1), NOW)
    const orphan = flowEntry(2)
    m.files[`${DIR}/archive/${sessionName(orphan)}`] = JSON.stringify(orphan)
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(titles(records(m.files, indexPath(DIR)))).toEqual(['Flow 2', 'Flow 1'])
    const reads = m.calls.filter(c => c.op === 'read' && c.path.includes('/archive/')).length
    await loadArchive(m.io, ROOT, NOW)
    expect(m.calls.filter(c => c.op === 'read' && c.path.includes('/archive/')).length).toBe(reads)
  })

  test('a record whose file is gone is kept and marked missing, and unmarked once the file is back', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    await saveSession(m.io, ROOT, flowEntry(2), NOW)
    const path = `${DIR}/archive/${sessionName(e)}`
    const text = m.files[path]!
    delete m.files[path]
    let loaded = await loadArchive(m.io, ROOT, NOW)
    expect(loaded.records.find(r => r.id === e.id)?.missing).toBe(true)
    expect(records(m.files, indexPath(DIR))!.find(r => r.id === e.id).missing).toBe(true)
    m.files[path] = text
    loaded = await loadArchive(m.io, ROOT, NOW)
    expect(loaded.records.find(r => r.id === e.id)?.missing).toBeUndefined()
  })

  test('a damaged index is rebuilt from archive/ only after every file was read; the damaged one is kept in .trash/damaged/', async () => {
    const m = memIo()
    await saveSession(m.io, ROOT, flowEntry(1), NOW)
    await saveSession(m.io, ROOT, flowEntry(2), NOW)
    m.files[indexPath(DIR)] = '{"version":1,"sessions":[' // cut short
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(titles(records(m.files, indexPath(DIR)))).toEqual(['Flow 2', 'Flow 1'])
    expect(m.files[`${DIR}/.trash/damaged/archive-index-${NOW}.json`]).toBe('{"version":1,"sessions":[')
    expect(loaded.warnings.some(w => /damaged/.test(w))).toBe(true)
  })

  test('a damaged index is not written over while a session file cannot be read', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    m.files[indexPath(DIR)] = 'garbage'
    m.deny.push({ op: 'read', path: new RegExp(sessionName(e)) })
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(m.files[indexPath(DIR)]).toBe('garbage')
    expect(loaded.warnings.some(w => /could not read archive\//.test(w))).toBe(true)
  })

  test('an index that is there but cannot be read is never written; the sessions found are shown', async () => {
    const m = memIo()
    await saveSession(m.io, ROOT, flowEntry(1), NOW)
    const before = m.files[indexPath(DIR)]
    m.deny.push({ op: 'read', path: /archive-index\.json$/ })
    const saved = await saveSession(m.io, ROOT, flowEntry(2), NOW)
    expect(saved.isSaved).toBe(true)
    expect(m.files[indexPath(DIR)]).toBe(before)
    expect(titles(saved.lists!.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(saved.lists!.warnings.some(w => /archive-index\.json could not be read/.test(w))).toBe(true)
  })

  test('an index past 2,500,000 bytes is still written whole and said; no record is dropped', async () => {
    const m = memIo()
    const recs = Array.from({ length: 9000 }, (_, i) => recordOf(flowEntry(i, { title: 'T'.repeat(150) }), `f${i}.json`, 100))
    m.files[indexPath(DIR)] = indexText(recs)
    const saved = await saveSession(m.io, ROOT, flowEntry(1), NOW)
    expect(records(m.files, indexPath(DIR))!.length).toBe(9000)
    expect(saved.lists!.warnings.some(w => /over 2,500,000 bytes; every record is kept/.test(w))).toBe(true)
  })
})

describe('moving to the trash and back', () => {
  test('the file is copied to .trash/, the trash record added, the archive record marked; nothing is erased', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    await saveSession(m.io, ROOT, flowEntry(2), NOW)
    const before = { ...m.files }
    const moved = await trashSession(m.io, ROOT, e.id, NOW + MIN)
    expect(moved.ok).toBe(true)
    expect(titles(moved.lists!.records)).toEqual(['Flow 2'])
    expect(titles(moved.lists!.trash)).toEqual(['Flow 1'])
    // Every file there before is still there; the session's own file unchanged.
    for (const p of Object.keys(before)) expect(p in m.files).toBe(true)
    expect(m.files[`${DIR}/archive/${sessionName(e)}`]).toBe(before[`${DIR}/archive/${sessionName(e)}`])
    const copy = `${DIR}/.trash/${trashName(sessionName(e), NOW + MIN)}`
    expect(m.files[copy]).toBe(before[`${DIR}/archive/${sessionName(e)}`])
    expect(records(m.files, trashIndexPath(DIR))![0]).toMatchObject({ id: e.id, trashedAt: NOW + MIN, originalFile: sessionName(e) })
    expect(records(m.files, indexPath(DIR))!.find(r => r.id === e.id).trashedAt).toBe(NOW + MIN)
    // A load reads the same.
    const loaded = await loadArchive(m.io, ROOT, NOW + 2 * MIN)
    expect(titles(loaded.records)).toEqual(['Flow 2'])
    expect(titles(loaded.trash)).toEqual(['Flow 1'])
  })

  test('restore brings it back to its place by its end, from the Trash; a second restore changes nothing', async () => {
    const m = memIo()
    for (const i of [1, 2, 3]) await saveSession(m.io, ROOT, flowEntry(i), NOW)
    await trashSession(m.io, ROOT, flowEntry(2).id, NOW + MIN)
    const back = await restoreSession(m.io, ROOT, flowEntry(2).id, NOW + 2 * MIN)
    expect(back.ok).toBe(true)
    expect(titles(back.lists!.records)).toEqual(['Flow 3', 'Flow 2', 'Flow 1'])
    expect(back.lists!.trash).toEqual([])
    const again = await restoreSession(m.io, ROOT, flowEntry(2).id, NOW + 3 * MIN)
    expect(again.ok).toBe(false)
    const loaded = await loadArchive(m.io, ROOT, NOW + 4 * MIN)
    expect(titles(loaded.records)).toEqual(['Flow 3', 'Flow 2', 'Flow 1'])
    expect(sessions(m.files, DIR)).toHaveLength(3)
  })

  test('restore writes the trash copy back when archive/ lost the file', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    await trashSession(m.io, ROOT, e.id, NOW + MIN)
    delete m.files[`${DIR}/archive/${sessionName(e)}`]
    const back = await restoreSession(m.io, ROOT, e.id, NOW + 2 * MIN)
    expect(back.ok).toBe(true)
    expect(sessions(m.files, DIR).map(x => x.id)).toEqual([e.id])
    expect(titles(back.lists!.records)).toEqual(['Flow 1'])
  })

  test('restoring a session the Archive already holds again (saved after the trash) adds no duplicate; the newer copy stays', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    await trashSession(m.io, ROOT, e.id, NOW + MIN)
    // The flow is saved again afterwards: it shows in the Archive again.
    const later = { ...e, endedAt: NOW + 2 * MIN, title: 'Flow 1 again' }
    const saved = await saveSession(m.io, ROOT, later, NOW + 2 * MIN)
    expect(titles(saved.lists!.records)).toEqual(['Flow 1 again'])
    expect(saved.lists!.trash).toEqual([])
    // A trash copy made before stays hidden; trashing again then restoring keeps one session, the newer copy.
    await trashSession(m.io, ROOT, e.id, NOW + 3 * MIN)
    const back = await restoreSession(m.io, ROOT, e.id, NOW + 4 * MIN)
    expect(back.ok).toBe(true)
    expect(titles(back.lists!.records)).toEqual(['Flow 1 again'])
    expect(sessions(m.files, DIR)).toHaveLength(1)
    expect(titles(records(m.files, indexPath(DIR)))).toEqual(['Flow 1 again'])
  })

  test('a crash after the copy: the next load lists the copy and the session is in the Trash', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    m.deny.push({ op: 'write', path: /trash-index\.json$/ })
    const moved = await trashSession(m.io, ROOT, e.id, NOW + MIN)
    expect(moved.ok).toBe(false)
    expect(titles(moved.lists!.records)).toEqual(['Flow 1'])
    m.deny.length = 0
    const loaded = await loadArchive(m.io, ROOT, NOW + 2 * MIN)
    expect(loaded.records).toEqual([])
    expect(titles(loaded.trash)).toEqual(['Flow 1'])
    expect(loaded.trash[0]!.trashedAt).toBe(NOW + MIN)
  })

  test('a crash after the trash record: the trash record decides, the next load agrees', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    m.deny.push({ op: 'write', path: /archive-index\.json$/ })
    const moved = await trashSession(m.io, ROOT, e.id, NOW + MIN)
    expect(moved.ok).toBe(true)
    expect(records(m.files, indexPath(DIR))![0].trashedAt).toBeUndefined()
    m.deny.length = 0
    const loaded = await loadArchive(m.io, ROOT, NOW + 2 * MIN)
    expect(loaded.records).toEqual([])
    expect(titles(loaded.trash)).toEqual(['Flow 1'])
  })

  test('a crash in a restore after the archive record: the archive record decides', async () => {
    const m = memIo()
    const e = flowEntry(1)
    await saveSession(m.io, ROOT, e, NOW)
    await trashSession(m.io, ROOT, e.id, NOW + MIN)
    m.deny.push({ op: 'write', path: /trash-index\.json$/ })
    const back = await restoreSession(m.io, ROOT, e.id, NOW + 2 * MIN)
    expect(back.ok).toBe(true)
    m.deny.length = 0
    const loaded = await loadArchive(m.io, ROOT, NOW + 3 * MIN)
    expect(titles(loaded.records)).toEqual(['Flow 1'])
    expect(loaded.trash).toEqual([])
  })

  test('the trash index heals too: an orphan copy is listed, a missing copy marked', async () => {
    const m = memIo()
    const e = flowEntry(1)
    const f = flowEntry(2)
    await saveSession(m.io, ROOT, e, NOW)
    await saveSession(m.io, ROOT, f, NOW)
    await trashSession(m.io, ROOT, e.id, NOW + MIN)
    // A copy put in by hand, its name without a time: dated by the load.
    m.files[`${DIR}/.trash/by-hand.json`] = JSON.stringify(f)
    delete m.files[`${DIR}/.trash/${trashName(sessionName(e), NOW + MIN)}`]
    const loaded = await loadArchive(m.io, ROOT, NOW + 5 * MIN)
    expect(titles(loaded.trash)).toEqual(['Flow 2', 'Flow 1'])
    expect(loaded.trash.find(r => r.id === e.id)!.missing).toBe(true)
    expect(loaded.trash.find(r => r.id === f.id)!.trashedAt).toBe(NOW + 5 * MIN)
    expect(records(m.files, trashIndexPath(DIR))).toHaveLength(2)
  })

  test('the sorted lists do not depend on the order of the moves', async () => {
    const orders = [
      [1, 2, 3, 4],
      [4, 3, 2, 1],
      [2, 4, 1, 3],
    ]
    const results: string[] = []
    for (const order of orders) {
      const m = memIo()
      for (const i of [5, 3, 1, 4, 2]) await saveSession(m.io, ROOT, flowEntry(i), NOW)
      let at = NOW
      for (const i of order) await trashSession(m.io, ROOT, flowEntry(i).id, (at += MIN))
      for (const i of [...order].reverse().slice(0, 2)) await restoreSession(m.io, ROOT, flowEntry(i).id, (at += MIN))
      const loaded = await loadArchive(m.io, ROOT, (at += MIN))
      results.push(`${titles(loaded.records).join(',')}|${titles(loaded.trash).join(',')}`)
      // Every archived list is in end order.
      expect(loaded.records.map(r => r.endedAt)).toEqual([...loaded.records.map(r => r.endedAt)].sort((a, b) => b - a))
      expect(loaded.trash.map(r => r.endedAt)).toEqual([...loaded.trash.map(r => r.endedAt)].sort((a, b) => b - a))
    }
    // The same two sessions come back in each run only when the orders end alike; each list is in end order regardless.
    expect(results[0]!.split('|')[0]).toBe('Flow 5,Flow 4,Flow 3')
  })

  test('reconcile: a tie in ends is broken by start, then id', () => {
    const a = recordOf(flowEntry(1, { id: 'b', endedAt: NOW, startedAt: NOW - 10 }), 'a.json', 1)
    const b = recordOf(flowEntry(1, { id: 'a', endedAt: NOW, startedAt: NOW - 10 }), 'b.json', 1)
    const c = recordOf(flowEntry(1, { id: 'c', endedAt: NOW, startedAt: NOW - 5 }), 'c.json', 1)
    expect(reconcile([a, b, c], []).records.map(r => r.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('the migration from history*.json', () => {
  const H = (name: string) => `${DIR}/${name}`

  test('a plain history.json: every entry gets its file and record; the marker is written; history.json is untouched', async () => {
    const m = memIo()
    const list = [flowEntry(3), flowEntry(2), flowEntry(1)]
    m.files[H('history.json')] = legacyText(list)
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 3', 'Flow 2', 'Flow 1'])
    expect(sessions(m.files, DIR)).toHaveLength(3)
    expect(m.files[H('history.json')]).toBe(legacyText(list))
    expect(JSON.parse(m.files[markerPath(DIR)]!).files).toEqual(['history.json'])
    // Loaded again, nothing is read from the old file.
    const reads = m.calls.filter(c => c.op === 'read' && c.path.endsWith('history.json')).length
    await loadArchive(m.io, ROOT, NOW)
    expect(m.calls.filter(c => c.op === 'read' && c.path.endsWith('history.json')).length).toBe(reads)
  })

  test('history.json with volumes and the volume index: all entries, each once', async () => {
    const m = memIo()
    m.files[H('history.json')] = legacyText([flowEntry(5), flowEntry(4)])
    m.files[H('history-1.json')] = legacyText([flowEntry(2), flowEntry(1)])
    m.files[H('history-2.json')] = legacyText([flowEntry(3), flowEntry(4)]) // a copy left by a rotation cut short
    m.files[H('history-index.json')] = JSON.stringify({ segments: [], merged: [] })
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 5', 'Flow 4', 'Flow 3', 'Flow 2', 'Flow 1'])
    expect(sessions(m.files, DIR)).toHaveLength(5)
    expect(JSON.parse(m.files[markerPath(DIR)]!).files).toEqual(['history-1.json', 'history-2.json', 'history-index.json', 'history.json'])
  })

  test('side files with a duplicate: one session, the newer copy', async () => {
    const m = memIo()
    const e = flowEntry(1)
    m.files[H('history.json')] = legacyText([e])
    m.files[H(`history-extra-${e.startedAt}.json`)] = legacyText([{ ...e, title: 'newer', endedAt: e.endedAt + MIN }])
    m.files[H(`history-extra-${e.startedAt}-2.json`)] = legacyText([{ ...e, title: 'newer', endedAt: e.endedAt + MIN }])
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['newer'])
    expect(sessions(m.files, DIR)).toHaveLength(1)
  })

  test('a partial entry later finished: the full one is kept', async () => {
    const m = memIo()
    const e = flowEntry(1)
    m.files[H('history.json')] = legacyText([{ ...e, partial: true, status: 'open', title: 'partial' }])
    m.files[H(`history-extra-${e.startedAt}.json`)] = legacyText([{ ...e, endedAt: e.endedAt + MIN, title: 'full' }])
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['full'])
    expect(loaded.records[0]!.partial).toBeUndefined()
  })

  test('a corrupt legacy file is said, not marked, never written, and loses nothing; it is imported once readable', async () => {
    const m = memIo()
    m.files[H('history.json')] = legacyText([flowEntry(2)])
    m.files[H('history-1.json')] = '[{"id": broken'
    const first = await loadArchive(m.io, ROOT, NOW)
    expect(titles(first.records)).toEqual(['Flow 2'])
    expect(first.warnings.some(w => /history-1\.json could not be read/.test(w))).toBe(true)
    expect(JSON.parse(m.files[markerPath(DIR)]!).files).toEqual(['history.json'])
    expect(m.files[H('history-1.json')]).toBe('[{"id": broken')
    m.files[H('history-1.json')] = legacyText([flowEntry(1)])
    const second = await loadArchive(m.io, ROOT, NOW)
    expect(titles(second.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(JSON.parse(m.files[markerPath(DIR)]!).files).toEqual(['history.json', 'history-1.json'])
  })

  test('a migration cut short repeats without duplicates', async () => {
    const m = memIo()
    m.files[H('history.json')] = legacyText([flowEntry(2), flowEntry(1)])
    m.deny.push({ op: 'write', path: /archive-migrated\.json$/ })
    await loadArchive(m.io, ROOT, NOW)
    m.deny.length = 0
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(sessions(m.files, DIR)).toHaveLength(2)
    expect(records(m.files, indexPath(DIR))).toHaveLength(2)
  })

  test('the store fallback is merged the same way and the store never changes', async () => {
    const stored = [flowEntry(4), flowEntry(9, { project: '/other' })]
    const m = memIo({}, { history: stored })
    m.files[H('history.json')] = legacyText([flowEntry(1)])
    const loaded = await loadArchive(m.io, ROOT, NOW)
    expect(titles(loaded.records)).toEqual(['Flow 4', 'Flow 1'])
    expect(m.store.history).toBe(stored)
  })

  test('without a project folder the store is the archive and there is no trash', async () => {
    const m = memIo({}, { history: [flowEntry(1), flowEntry(2)] })
    const loaded = await loadArchive(m.io, '', NOW)
    expect(titles(loaded.records)).toEqual(['Flow 2', 'Flow 1'])
    expect(loaded.records.every(r => r.source === 'store')).toBe(true)
    expect(await readSession(m.io, '', 'archive', loaded.records[0]!)).toMatchObject({ title: 'Flow 2' })
    expect((await trashSession(m.io, '', flowEntry(1).id, NOW)).ok).toBe(false)
  })
})
