// The archive's indexes, pure: one small record per saved session, so the Archive and Trash tabs list every session
// without reading a session file. `archive-index.json` lists `archive/`, `.trash/trash-index.json` lists `.trash/`.
//
// The engine can write and read files but cannot move or remove one, so a session put in the trash keeps its file in
// `archive/` and gets a copy in `.trash/`; where it shows is decided by the latest of its events, read from both indexes:
// a save (the session's end), a move to the trash, a restore. A crash or another session between two writes then leaves
// both indexes telling the same story, never a session in neither list.
import type { ArchiveEntry, ArchiveRecord } from '../types'
import { isNewer, itemCountOf, keyOf, MAX_TEXT, taskCountOf } from './archive'
import { sortNewest } from './order'

export const INDEX_VERSION = 1
export const ARCHIVE_DIR = 'archive'
export const TRASH_DIR = '.trash'
export const INDEX_FILE = 'archive-index.json'
/** Inside `.trash/`, so the trash is whole in its own folder. */
export const TRASH_INDEX = 'trash-index.json'
export const MARKER_FILE = 'archive-migrated.json'
/** A damaged index is kept here (inside `.trash/`) before the rebuilt one is written. */
export const DAMAGED_DIR = 'damaged'

// A session's file: its id's key and its start, only [a-z0-9-]: `k1x2y3z4a-1792906769689.json`, `-2` … when that name
// holds another session.
export const sessionName = (e: { id: string; startedAt: number }, k = 1): string => `${keyOf(e.id)}-${Math.round(e.startedAt)}${k > 1 ? `-${k}` : ''}.json`

// A trash copy: the session file's name and when it went to the trash, `<name>-t<ms>.json` (`-2` … when taken).
export const trashName = (file: string, at: number, k = 1): string => `${file.replace(/\.json$/, '')}-t${Math.round(at)}${k > 1 ? `-${k}` : ''}.json`
const TRASH_FILE = /^(.+)-t(\d+)(?:-\d+)?\.json$/
export const trashStamp = (name: string): { original: string; at: number } | null => {
  const m = TRASH_FILE.exec(name)
  return m ? { original: `${m[1]}.json`, at: Number(m[2]) } : null
}

export function recordOf(entry: ArchiveEntry, file: string, size: number): ArchiveRecord {
  const r: ArchiveRecord = {
    id: entry.id,
    file,
    kind: entry.plan ? 'plan' : 'flow',
    title: entry.title.trim().slice(0, MAX_TEXT),
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    status: entry.status,
    itemCount: itemCountOf(entry),
    taskCount: taskCountOf(entry),
    cost: entry.cost,
    tokens: entry.tokens,
    time: entry.time,
    size,
  }
  if (entry.partial) r.partial = true
  return r
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null)
const NUMS = ['startedAt', 'endedAt', 'itemCount', 'taskCount', 'cost', 'tokens', 'time', 'size'] as const

// One record as an index holds it, or null when it is no record. Fields it does not know are dropped.
export function parseRecord(v: unknown): ArchiveRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id || typeof o.file !== 'string' || typeof o.title !== 'string') return null
  if (NUMS.some(k => num(o[k]) === null)) return null
  const r: ArchiveRecord = {
    id: o.id,
    file: o.file,
    kind: o.kind === 'plan' ? 'plan' : 'flow',
    title: o.title.slice(0, MAX_TEXT),
    startedAt: num(o.startedAt)!,
    endedAt: num(o.endedAt)!,
    status: o.status === 'open' ? 'open' : 'finished',
    itemCount: num(o.itemCount)!,
    taskCount: num(o.taskCount)!,
    cost: num(o.cost)!,
    tokens: num(o.tokens)!,
    time: num(o.time)!,
    size: num(o.size)!,
  }
  if (o.partial === true) r.partial = true
  if (o.missing === true) r.missing = true
  if (num(o.trashedAt) !== null) r.trashedAt = num(o.trashedAt)!
  if (num(o.restoredAt) !== null) r.restoredAt = num(o.restoredAt)!
  if (typeof o.originalFile === 'string' && o.originalFile) r.originalFile = o.originalFile
  if (o.source === 'store') r.source = 'store'
  return r
}

export const parseRecords = (v: unknown): ArchiveRecord[] =>
  (Array.isArray(v) ? v : []).flatMap(x => {
    const r = parseRecord(x)
    return r ? [r] : []
  })

// An index file's records, or null when the text is no index (then it is damaged, never just empty).
export function parseIndexFile(raw: unknown): ArchiveRecord[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as { version?: unknown; sessions?: unknown }
  return typeof o.version === 'number' && Array.isArray(o.sessions) ? parseRecords(o.sessions) : null
}

// The panel's one order (order.ts): the session's own end, latest on top; a trashed session keeps its end.
export const byNewest = (records: ArchiveRecord[]): ArchiveRecord[] => sortNewest(records, r => ({ end: r.endedAt, start: r.startedAt, id: r.id }))

// The index as written: the records newest first, without what only memory knows.
export const indexText = (records: ArchiveRecord[]): string =>
  JSON.stringify({
    version: INDEX_VERSION,
    sessions: byNewest(records.filter(r => r.source !== 'store')).map(({ source: _, ...r }) => r),
  })

const latest = (...at: (number | undefined)[]): number => Math.max(-Infinity, ...at.filter((x): x is number => typeof x === 'number'))

// `rec` put in by `same`; of two records of one session the newer is kept (archive.ts `isNewer`; at a tie the incoming,
// which is what its file holds now), and the moves either one saw are kept: nothing is dropped.
function upsert(records: ArchiveRecord[], rec: ArchiveRecord, same: (r: ArchiveRecord) => boolean): ArchiveRecord[] {
  const at = records.findIndex(same)
  if (at < 0) return [...records, rec]
  const old = records[at]!
  const base = isNewer(old, rec) ? old : rec
  const next: ArchiveRecord = { ...base }
  const trashedAt = latest(old.trashedAt, rec.trashedAt)
  const restoredAt = latest(old.restoredAt, rec.restoredAt)
  if (trashedAt > -Infinity) next.trashedAt = trashedAt
  if (restoredAt > -Infinity) next.restoredAt = restoredAt
  return records.map((r, i) => (i === at ? next : r))
}

/** The archive index holds one record per session. */
export const upsertArchive = (records: ArchiveRecord[], rec: ArchiveRecord): ArchiveRecord[] => upsert(records, rec, r => r.id === rec.id)
/** The trash index holds one record per trash copy: a session trashed twice has two. */
export const upsertTrash = (records: ArchiveRecord[], rec: ArchiveRecord): ArchiveRecord[] => upsert(records, rec, r => r.file === rec.file)

const isLive = (t: ArchiveRecord): boolean => !(typeof t.restoredAt === 'number' && t.restoredAt >= (t.trashedAt ?? 0))

// Which list each session shows in, from both indexes: it is in the Trash when its latest move to the trash is later
// than its latest save (its end) or restore; it then shows its newest trash copy not restored. A session the trash
// index lost every copy of (the user emptied `.trash/` by hand) shows in neither list; its file stays in `archive/`.
export function reconcile(archive: ArchiveRecord[], trash: ArchiveRecord[]): { records: ArchiveRecord[]; trash: ArchiveRecord[] } {
  const ids = new Set([...archive.map(r => r.id), ...trash.map(r => r.id)])
  const shown: ArchiveRecord[] = []
  const binned: ArchiveRecord[] = []
  for (const id of ids) {
    const a = archive.find(r => r.id === id)
    const copies = trash.filter(r => r.id === id)
    const lastTrash = latest(a?.trashedAt, ...copies.map(t => t.trashedAt))
    const lastBack = latest(a?.endedAt, a?.restoredAt, ...copies.map(t => t.restoredAt))
    if (lastTrash > lastBack) {
      const live = copies.filter(isLive).sort((x, y) => (y.trashedAt ?? 0) - (x.trashedAt ?? 0))[0]
      if (live) binned.push(live)
    } else if (a) shown.push(a)
  }
  return { records: byNewest(shown), trash: byNewest(binned) }
}
