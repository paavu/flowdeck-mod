// The archive's persistence: the project folder's files and the shared store's fallback. Everything that reads or writes
// them for the archive lives here; the panel's state stays in register.tsx, which passes in what these need.
//
// The engine's `$` may not cross an import (the hooks loader follows it only into functions of register.tsx), so these
// take an `Io`: the few engine calls they make, built in register.tsx around `$`. The engine reads, writes, lists and
// stats files; it cannot move, rename or remove one. Nothing here moves a file, and one function alone erases:
// `eraseSessionFile`, for Empty Trash, one session file in `.trash/` or `archive/` at a time through a host command.
//
// In `<project>/.claude/flowdeck/` (with its `*` .gitignore):
// - `archive/<session>.json`: one saved session each (a flow, or a finished plan an older flowdeck saved), the whole entry; written first on every
//   save, and only over an older copy of the same session.
// - `archive-index.json`: one small record per session (archive-index.ts); the Archive tab draws from it alone.
// - `.trash/<session>-t<ms>.json` and `.trash/trash-index.json`: the copies of the sessions moved to the trash, and their
//   records; the session's file stays in `archive/` too (the engine cannot move it).
// - `archive-migrated.json`: which files of the archive before 1.0.0025 (`history*.json`) were imported; those files are
//   left as they are.
// - A day's session (`mergeDays`): the flows finished on one day, merged once the day has passed; each flow's own file
//   stays in `archive/`, its record marked `mergedInto`.
import type { ArchiveEntry, ArchiveLists, ArchiveRecord } from '../types'
import { addEntry, byteLength, DAY_MAX, dayEntry, dayId, INDEX_MAX, isLegacyFile, isNewer, jsonBytes, keyOf, LEGACY_INDEX, MAX_TEXT, mergeEntries, parseArchive, parseSession, WRITE_MAX } from './archive'
import { ARCHIVE_DIR, byNewest, DAMAGED_DIR, INDEX_FILE, indexText, MARKER_FILE, parseIndexFile, reconcile, recordOf, sessionName, TRASH_DIR, TRASH_INDEX, trashName, trashStamp, upsertArchive, upsertTrash } from './archive-index'

export type Io = {
  read: (path: string) => unknown
  write: (path: string, text: string) => unknown
  stat: (path: string) => unknown
  list: (dir: string) => unknown
  exists: (path: string) => unknown
  /** The shared store's `history` key (its name from before the rename). */
  storeGet: () => Promise<unknown>
  storeSet: (value: ArchiveEntry[]) => Promise<unknown>
  /** A stat with `realPath` (`$.fs.stat(path, { resolve: true })`); Empty Trash only. */
  statReal?: (path: string) => unknown
  /** A host command by argv, no shell (`$.process.run`); Empty Trash only. */
  run?: (argv: string[], env?: Record<string, string>) => unknown
}

// Saved data lives in the project folder, so projects never overwrite each other; '' without a project.
export const dataDir = (project: string): string => (project ? `${project.replace(/[\\/]+$/, '')}/.claude/flowdeck` : '')

// A file's text, or null when it cannot be read (missing, over 4 MiB, refused).
const readFile = async (io: Io, path: string): Promise<string | null> => {
  const text: unknown = await Promise.resolve()
    .then(() => io.read(path))
    .catch(() => null)
  return typeof text === 'string' ? text : null
}

export const parseJson = (text: string | null): unknown => {
  try {
    return text === null ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

// The file names in a folder (folders left out); null when it cannot be listed (a folder not made yet cannot either).
export const listing = async (io: Io, dir: string): Promise<string[] | null> => {
  const list: unknown = await Promise.resolve()
    .then(() => io.list(dir))
    .catch(() => null)
  if (!Array.isArray(list)) return null
  return list.flatMap((v: unknown) => {
    const o = v && typeof v === 'object' ? (v as { name?: unknown; kind?: unknown }) : {}
    return typeof o.name === 'string' && o.kind !== 'dir' ? [o.name] : []
  })
}

type There = 'yes' | 'no' | 'unknown'

// Whether something is at the path: its stat, else the folder's listing, else `exists`. A read that rejects never means
// missing by itself, and when all three fail too it is 'unknown', which is never written over.
const isThere = async (io: Io, path: string): Promise<There> => {
  const stat: unknown = await Promise.resolve()
    .then(() => io.stat(path))
    .catch(() => null)
  if (stat && typeof stat === 'object') return 'yes'
  const cut = path.lastIndexOf('/')
  const names = await listing(io, path.slice(0, cut))
  if (names) return names.includes(path.slice(cut + 1)) ? 'yes' : 'no'
  const has: unknown = await Promise.resolve()
    .then(() => io.exists(path))
    .catch(() => null)
  return has === true ? 'yes' : has === false ? 'no' : 'unknown'
}

// A folder is known to be absent only when its stat fails and `exists` says no; a parent's listing is not asked (it
// would name files only), so a folder that is there but cannot be listed never reads as empty.
const isFolderGone = async (io: Io, path: string): Promise<boolean> => {
  const stat: unknown = await Promise.resolve()
    .then(() => io.stat(path))
    .catch(() => null)
  if (stat && typeof stat === 'object') return false
  const has: unknown = await Promise.resolve()
    .then(() => io.exists(path))
    .catch(() => null)
  return has === false
}

// `isUnknown`: not even whether it is there could be told.
type Got = { state: 'ok'; text: string } | { state: 'missing' } | { state: 'unreadable'; isUnknown: boolean }

// A file's text; one that is there but cannot be read, or that may be there, is told apart from a missing one, which alone may be created.
export const getFile = async (io: Io, path: string): Promise<Got> => {
  const text = await readFile(io, path)
  if (text !== null) return { state: 'ok', text }
  const there = await isThere(io, path)
  return there === 'no' ? { state: 'missing' } : { state: 'unreadable', isUnknown: there === 'unknown' }
}

// One whole file; a text over WRITE_MAX bytes is never sent and counts as a failed write.
const writeText = async (io: Io, path: string, text: string): Promise<boolean> => {
  if (byteLength(text) > WRITE_MAX) return false
  return Promise.resolve()
    .then(() => io.write(path, text))
    .then(
      () => true,
      () => false,
    )
}

// Writes the text as `name` (a path under `dir`), no bigger than `max` bytes; the folder gets a `*` .gitignore first
// when it surely has none, so nothing in it is committed. False when the write fails or is too big.
async function writeRaw(io: Io, dir: string, name: string, text: string, max = WRITE_MAX): Promise<boolean> {
  if (byteLength(text) > max) return false
  if ((await getFile(io, `${dir}/.gitignore`)).state === 'missing') await writeText(io, `${dir}/.gitignore`, '*\n')
  return writeText(io, `${dir}/${name}`, text)
}

export const writeData = (io: Io, dir: string, name: string, data: unknown, max = WRITE_MAX): Promise<boolean> => writeRaw(io, dir, name, JSON.stringify(data), max)

// The shared store's archive (the one before project files): this project's entries, or all without a project.
const storedArchive = async (io: Io, project: string): Promise<ArchiveEntry[]> => {
  const list = parseArchive(await io.storeGet().catch(() => undefined))
  return project ? list.filter(e => e.project === project.trim().slice(0, MAX_TEXT)) : list
}

const storeRecord = (e: ArchiveEntry): ArchiveRecord => ({ ...recordOf(e, '', jsonBytes(e)), source: 'store' })

const SLOTS = 100

type Put = { file: string; entry: ArchiveEntry; size: number } | { error: 'big' | 'failed' }

// The session's own file in `archive/`: the slot that holds this session already, else the first free one. A slot
// holding another session, or one that cannot be read, is never written over; a newer copy of the session stays as it
// is (and is what the index then lists). Over WRITE_MAX bytes nothing is written.
async function putSession(io: Io, dir: string, entry: ArchiveEntry, text = JSON.stringify(entry)): Promise<Put> {
  const size = byteLength(text)
  if (size > WRITE_MAX) return { error: 'big' }
  for (let k = 1; k <= SLOTS; k++) {
    const file = sessionName(entry, k)
    const got = await getFile(io, `${dir}/${ARCHIVE_DIR}/${file}`)
    if (got.state === 'unreadable') {
      if (got.isUnknown) return { error: 'failed' } // the fs cannot tell what is there: write nothing
      continue
    }
    if (got.state === 'ok') {
      const held = parseSession(parseJson(got.text))
      if (!held || held.id !== entry.id) continue
      if (isNewer(held, entry)) return { file, entry: held, size: byteLength(got.text) }
    }
    return (await writeRaw(io, dir, `${ARCHIVE_DIR}/${file}`, text)) ? { file, entry, size } : { error: 'failed' }
  }
  return { error: 'failed' }
}

type Side = 'archive' | 'trash'
const folderOf = (side: Side): string => (side === 'archive' ? ARCHIVE_DIR : TRASH_DIR)
const indexPath = (side: Side): string => (side === 'archive' ? INDEX_FILE : `${TRASH_DIR}/${TRASH_INDEX}`)

type Healed = {
  side: Side
  records: ArchiveRecord[]
  /** The index may be written: it was read, or is missing, or was damaged and the folder was read whole. */
  canWrite: boolean
  /** The records differ from what the index file holds. */
  changed: boolean
  /** A damaged index's text, kept in `.trash/damaged/` before the rebuilt one is written. */
  damaged?: string
  warnings: string[]
}

// One index read and checked against its folder: a session file it does not list is read once and its record added; a
// record whose file is not in the folder is kept and marked `missing` (and unmarked once the file is back). An index
// that cannot be read is never written; a damaged one (read, but no index) is rebuilt from the folder and written only
// when every file there could be read. `now` dates a trash copy whose name carries no time.
async function heal(io: Io, dir: string, side: Side, now: number): Promise<Healed> {
  const sub = folderOf(side)
  const name = indexPath(side)
  const warnings: string[] = []
  const got = await getFile(io, `${dir}/${name}`)
  const parsed = got.state === 'ok' ? parseIndexFile(parseJson(got.text)) : null
  let records: ArchiveRecord[] = parsed ?? []
  const listed = await listing(io, `${dir}/${sub}`)
  // A folder not there holds nothing; one that cannot be listed tells nothing.
  const names = listed ?? ((await isFolderGone(io, `${dir}/${sub}`)) ? [] : null)
  let changed = false
  let isWhole = names !== null
  const known = new Set(records.map(r => r.file))
  for (const file of (names ?? []).filter(n => n.endsWith('.json') && n !== TRASH_INDEX).sort()) {
    if (known.has(file)) continue
    const text = await readFile(io, `${dir}/${sub}/${file}`)
    if (text === null) {
      isWhole = false
      warnings.push(`could not read ${sub}/${file}`)
      continue
    }
    const entry = parseSession(parseJson(text))
    if (!entry) {
      warnings.push(`${sub}/${file} holds no session`)
      continue
    }
    const rec = recordOf(entry, file, byteLength(text))
    if (side === 'trash') {
      const stamp = trashStamp(file)
      rec.trashedAt = stamp?.at ?? now
      rec.originalFile = stamp?.original ?? file
    }
    records = side === 'archive' ? upsertArchive(records, rec) : upsertTrash(records, rec)
    changed = true
  }
  if (names) {
    const have = new Set(names)
    records = records.map(r => {
      const isMissing = !have.has(r.file)
      if (!!r.missing === isMissing) return r
      changed = true
      if (isMissing) return { ...r, missing: true }
      const { missing: _, ...back } = r
      return back
    })
  }
  if (got.state === 'unreadable') warnings.push(`${name} could not be read; showing the sessions found in ${sub}/ (the index is untouched)`)
  const damaged = got.state === 'ok' && !parsed ? got.text : undefined
  if (damaged !== undefined) warnings.push(isWhole ? `${name} was damaged and is rebuilt from ${sub}/; the damaged one is kept in ${TRASH_DIR}/${DAMAGED_DIR}/` : `${name} is damaged; showing the sessions found in ${sub}/ (the index is untouched until every file there can be read)`)
  return {
    side,
    records: byNewest(records),
    canWrite: got.state === 'missing' || !!parsed || (damaged !== undefined && isWhole),
    changed: changed || damaged !== undefined,
    damaged,
    warnings,
  }
}

// The index written whole, when it may be: a damaged one is first kept in `.trash/damaged/` (never over a file there).
// Past INDEX_MAX it is still written, and said; past WRITE_MAX it cannot be, and that is said too.
async function writeIndex(io: Io, dir: string, h: Healed, records: ArchiveRecord[], now: number, warnings: string[]): Promise<boolean> {
  if (!h.canWrite) return false
  const name = indexPath(h.side)
  if (h.damaged !== undefined) {
    const keep = `${TRASH_DIR}/${DAMAGED_DIR}/${h.side === 'archive' ? 'archive-index' : 'trash-index'}-${Math.round(now)}.json`
    if ((await getFile(io, `${dir}/${keep}`)).state !== 'missing' || !(await writeRaw(io, dir, keep, h.damaged))) return false
    h.damaged = undefined
  }
  const text = indexText(records)
  const size = byteLength(text)
  const count = records.filter(r => r.source !== 'store').length
  if (size > WRITE_MAX) {
    warnings.push(`${name} would be ${size} bytes (${count} sessions), over the 3,900,000-byte write limit: not written; the session files are kept`)
    return false
  }
  if (size > INDEX_MAX) warnings.push(`${name} is ${size} bytes (${count} sessions), over 2,500,000 bytes; every record is kept`)
  return writeRaw(io, dir, name, text)
}

// This project's entries in the shared store (where a failed write or a session without a folder sent them) go into
// session files: idempotent by id, a copy as new already listed is passed over, and the store itself never changes.
// One the folder refuses stays in memory, from the store.
async function importStore(io: Io, dir: string, project: string, records: ArchiveRecord[]): Promise<{ records: ArchiveRecord[]; memory: ArchiveRecord[]; changed: boolean }> {
  const memory: ArchiveRecord[] = []
  let changed = false
  for (const e of mergeEntries(await storedArchive(io, project))) {
    const have = records.find(r => r.id === e.id)
    if (have && !have.missing && !isNewer(e, have)) continue
    const put = await putSession(io, dir, e)
    if ('error' in put) {
      if (!have) memory.push(storeRecord(e))
      continue
    }
    records = upsertArchive(records, recordOf(put.entry, put.file, put.size))
    changed = true
  }
  return { records, memory, changed }
}

type Migrated = { records: ArchiveRecord[]; changed: boolean; done: string[]; prior: string[]; canMark: boolean }

// The archive before 1.0.0025 (`history.json`, its volumes `history-<n>.json`, the side files `history-extra-*.json`)
// imported once: every entry into its session file (of two copies of one session the newer, archive.ts `isNewer`),
// idempotent by id, so a run cut short only repeats. A file that cannot be read is said, not marked, and tried again on
// the next load; the legacy files are never written, moved or renamed. `history-index.json` lists only volumes, which
// are read from the folder itself.
async function migrate(io: Io, dir: string, records: ArchiveRecord[], warnings: string[]): Promise<Migrated> {
  const legacy = ((await listing(io, dir)) ?? []).filter(isLegacyFile)
  const none: Migrated = { records, changed: false, done: [], prior: [], canMark: false }
  if (!legacy.length) return none
  const marker = await getFile(io, `${dir}/${MARKER_FILE}`)
  const raw = marker.state === 'ok' ? parseJson(marker.text) : undefined
  const isMarker = !!raw && typeof raw === 'object' && Array.isArray((raw as { files?: unknown }).files)
  const prior = isMarker ? ((raw as { files: unknown[] }).files.filter(f => typeof f === 'string') as string[]) : []
  // A marker that cannot be read or does not parse is never written over: the import then repeats (it is idempotent).
  const canMark = marker.state === 'missing' || isMarker
  if (marker.state !== 'missing' && !isMarker) warnings.push(`${MARKER_FILE} could not be read; the old archive files are imported again (nothing is duplicated)`)
  const todo = legacy.filter(f => !prior.includes(f)).sort()
  if (!todo.length) return { ...none, prior, canMark }
  const from = new Map<string, string[]>()
  const lists: ArchiveEntry[][] = []
  const done: string[] = []
  for (const file of todo) {
    if (file === LEGACY_INDEX) {
      done.push(file)
      continue
    }
    const text = await readFile(io, `${dir}/${file}`)
    const raw = parseJson(text)
    if (text === null || !Array.isArray(raw)) {
      warnings.push(`${file} could not be read; it is left as it is and imported on a later load`)
      continue
    }
    const list = parseArchive(raw)
    for (const e of list) from.set(e.id, [...(from.get(e.id) ?? []), file])
    lists.push(list)
    done.push(file)
  }
  const failed = new Set<string>()
  let changed = false
  for (const e of mergeEntries(...lists)) {
    const have = records.find(r => r.id === e.id)
    if (have && !have.missing && !isNewer(e, have)) continue
    const put = await putSession(io, dir, e)
    if ('error' in put) {
      for (const f of from.get(e.id) ?? []) failed.add(f)
      warnings.push(`could not import "${e.title || e.id}"${put.error === 'big' ? ' (over 3,900,000 bytes)' : ''}; its old file is kept and tried again`)
      continue
    }
    records = upsertArchive(records, recordOf(put.entry, put.file, put.size))
    changed = true
  }
  return { records, changed, done: done.filter(f => !failed.has(f)), prior, canMark }
}

// Both lists without a project folder: the shared store's entries, newest first; there is no trash.
const storeLists = async (io: Io, project: string): Promise<ArchiveLists> => ({
  records: byNewest(mergeEntries(await storedArchive(io, project)).map(storeRecord)),
  trash: [],
  warnings: [],
})

// The Archive and Trash lists as the panel shows them: the indexes healed against their folders, the old archive
// imported once, this project's store entries put into session files. Writes only what heals or imports.
export async function loadArchive(io: Io, project: string, now: number): Promise<ArchiveLists> {
  if (!project) return storeLists(io, project)
  const dir = dataDir(project)
  const warnings: string[] = []
  const arch = await heal(io, dir, 'archive', now)
  const mig = await migrate(io, dir, arch.records, warnings)
  const st = await importStore(io, dir, project, mig.records)
  const changed = arch.changed || mig.changed || st.changed
  const isIndexed = !changed || (await writeIndex(io, dir, arch, st.records, now, warnings))
  if (isIndexed && mig.canMark && mig.done.length) {
    await writeData(io, dir, MARKER_FILE, { version: 1, files: [...mig.prior, ...mig.done.filter(f => !mig.prior.includes(f))], at: now })
  }
  const tr = await heal(io, dir, 'trash', now)
  if (tr.changed) await writeIndex(io, dir, tr, tr.records, now, warnings)
  const view = reconcile([...st.records, ...st.memory], tr.records)
  return { ...view, warnings: [...arch.warnings, ...tr.warnings, ...warnings] }
}

export type Saved = { isSaved: boolean; isTooBig?: boolean; lists?: ArchiveLists }

// Append-only first: the session's own file is written before anything else, so no other session's index write can lose
// it (the next load or save finds it and lists it again). Then the index is read again, healed, the record merged in and
// the index written whole. `isSaved` false sends the entry to the shared store.
export async function saveSession(io: Io, project: string, entry: ArchiveEntry, now: number): Promise<Saved> {
  const dir = dataDir(project)
  const put = await putSession(io, dir, entry)
  if ('error' in put) return { isSaved: false, isTooBig: put.error === 'big' }
  const warnings: string[] = []
  const arch = await heal(io, dir, 'archive', now)
  const st = await importStore(io, dir, project, upsertArchive(arch.records, recordOf(put.entry, put.file, put.size)))
  await writeIndex(io, dir, arch, st.records, now, warnings)
  const tr = await heal(io, dir, 'trash', now)
  if (tr.changed) await writeIndex(io, dir, tr, tr.records, now, warnings)
  return { isSaved: true, lists: { ...reconcile([...st.records, ...st.memory], tr.records), warnings: [...arch.warnings, ...tr.warnings, ...warnings] } }
}

export type Moved = { ok: boolean; error?: string; lists?: ArchiveLists }

const both = async (io: Io, dir: string, now: number) => {
  const arch = await heal(io, dir, 'archive', now)
  const tr = await heal(io, dir, 'trash', now)
  return { arch, tr, view: reconcile(arch.records, tr.records) }
}

const listsOf = (arch: ArchiveRecord[], tr: ArchiveRecord[], warnings: string[]): ArchiveLists => ({ ...reconcile(arch, tr), warnings })

// Moves a session to the trash, in an order no crash can lose: (1) a copy of its file into `.trash/` (a new name, never
// over anything); (2) its trash record; (3) the archive record marked trashed. Its file stays in `archive/`: the engine
// cannot move or remove a file. After (1) the next load lists the copy and finishes the move; after (2) the trash
// record already decides.
export async function trashSession(io: Io, project: string, id: string, now: number): Promise<Moved> {
  if (!project) return { ok: false, error: 'no project folder' }
  const dir = dataDir(project)
  const { arch, tr, view } = await both(io, dir, now)
  const warnings = [...arch.warnings, ...tr.warnings]
  const rec = view.records.find(r => r.id === id)
  if (!rec) return { ok: false, error: 'not in the Archive', lists: { ...view, warnings } }
  if (rec.source === 'store') return { ok: false, error: 'it is only in the shared store, with no file to move', lists: { ...view, warnings } }
  if (!tr.canWrite) return { ok: false, error: `${TRASH_DIR}/${TRASH_INDEX} cannot be written`, lists: { ...view, warnings } }
  const got = rec.missing ? ({ state: 'missing' } as Got) : await getFile(io, `${dir}/${ARCHIVE_DIR}/${rec.file}`)
  if (got.state === 'unreadable') return { ok: false, error: `could not read ${rec.file}`, lists: { ...view, warnings } }
  let file = trashName(rec.file, now)
  if (got.state === 'ok') {
    const held = parseSession(parseJson(got.text))
    if (!held || held.id !== id) return { ok: false, error: `${rec.file} holds another session`, lists: { ...view, warnings } }
    let k = 1
    let there = await isThere(io, `${dir}/${TRASH_DIR}/${file}`)
    while (there === 'yes' && k < SLOTS) there = await isThere(io, `${dir}/${TRASH_DIR}/${(file = trashName(rec.file, now, ++k))}`)
    if (there !== 'no' || !(await writeRaw(io, dir, `${TRASH_DIR}/${file}`, got.text))) return { ok: false, error: `could not write ${TRASH_DIR}/${file}`, lists: { ...view, warnings } }
  }
  const { trashedAt: _t, restoredAt: _r, missing: _m, source: _s, ...base } = rec
  const copy: ArchiveRecord = { ...base, file, originalFile: rec.file, trashedAt: now, ...(got.state === 'missing' ? { missing: true } : {}) }
  const trash = upsertTrash(tr.records, copy)
  if (!(await writeIndex(io, dir, tr, trash, now, warnings))) {
    // The copy stays in `.trash/`; the next load lists it and so finishes the move.
    return { ok: false, error: `could not write ${TRASH_DIR}/${TRASH_INDEX}; the copy is kept and listed on the next load`, lists: listsOf(arch.records, tr.records, warnings) }
  }
  const records = arch.records.map(r => (r.id === id ? { ...r, trashedAt: now } : r))
  // The trash record decides already: a failed write here changes nothing shown.
  await writeIndex(io, dir, arch, records, now, warnings)
  return { ok: true, lists: listsOf(records, trash, warnings) }
}

// Brings a trashed session back: (1) `archive/` holds it (its file is usually still there; else the trash copy is written
// back, never over another session or a newer copy; a newer trash copy replaces an older file of the same session);
// (2) the archive record, marked restored; (3) the trash record, marked restored (kept, as its copy stays in `.trash/`).
// A session the Archive already holds again is not duplicated: its newer copy wins.
export async function restoreSession(io: Io, project: string, id: string, now: number): Promise<Moved> {
  if (!project) return { ok: false, error: 'no project folder' }
  const dir = dataDir(project)
  const { arch, tr, view } = await both(io, dir, now)
  const warnings = [...arch.warnings, ...tr.warnings]
  const fail = (error: string): Moved => ({ ok: false, error, lists: { ...view, warnings } })
  const copy = view.trash.find(r => r.id === id)
  if (!copy) return fail('not in the Trash')
  if (!arch.canWrite) return fail(`${INDEX_FILE} cannot be written`)
  const tgot = copy.missing ? ({ state: 'missing' } as Got) : await getFile(io, `${dir}/${TRASH_DIR}/${copy.file}`)
  if (tgot.state === 'unreadable') return fail(`could not read ${TRASH_DIR}/${copy.file}`)
  const trashed = tgot.state === 'ok' ? parseSession(parseJson(tgot.text)) : null
  if (tgot.state === 'ok' && trashed?.id !== id) return fail(`${TRASH_DIR}/${copy.file} holds another session`)
  const held = arch.records.find(r => r.id === id)
  let back: ArchiveRecord | null = null
  if (held && !held.missing) {
    const agot = await getFile(io, `${dir}/${ARCHIVE_DIR}/${held.file}`)
    if (agot.state === 'unreadable') return fail(`could not read ${held.file}`)
    const kept = agot.state === 'ok' ? parseSession(parseJson(agot.text)) : null
    if (kept && kept.id === id) back = recordOf(kept, held.file, byteLength(agot.state === 'ok' ? agot.text : ''))
  }
  if (!back || (trashed && isNewer(trashed, back))) {
    if (!trashed || tgot.state !== 'ok') return fail('no copy of it can be read')
    const put = await putSession(io, dir, trashed, tgot.text)
    if ('error' in put) return fail(`could not write ${ARCHIVE_DIR}/${sessionName(trashed)}`)
    back = recordOf(put.entry, put.file, put.size)
  }
  const records = upsertArchive(arch.records, { ...back, restoredAt: now })
  if (!(await writeIndex(io, dir, arch, records, now, warnings))) return fail(`could not write ${INDEX_FILE}`)
  // The archive record decides already: a failed write here changes nothing shown.
  // Every copy of it not restored yet is marked, so none of them shows again.
  const trash = tr.records.map(r => (r.id === id && !(typeof r.restoredAt === 'number' && r.restoredAt >= (r.trashedAt ?? 0)) ? { ...r, restoredAt: now } : r))
  await writeIndex(io, dir, tr, trash, now, warnings)
  return { ok: true, lists: listsOf(records, trash, warnings) }
}

export type DaysMerged = { ok: boolean; merged: number; error?: string; lists?: ArchiveLists }

// A session file's entry, when it holds the record's own session; null when it cannot be read or holds another.
const readRecord = async (io: Io, dir: string, rec: ArchiveRecord): Promise<ArchiveEntry | null> => {
  const got = await getFile(io, `${dir}/${ARCHIVE_DIR}/${rec.file}`)
  const entry = got.state === 'ok' ? parseSession(parseJson(got.text)) : null
  return entry && entry.id === rec.id ? entry : null
}

const mergedInto = (r: ArchiveRecord, id: string): ArchiveRecord => {
  const { pendingDay: _, ...rest } = r
  return { ...rest, mergedInto: id }
}

// The finished flows of every day before `today` (records `pendingDay`) merged into one Archive session per day, in an
// order no crash can lose: (1) the day's session file is written (a new one, or the day's session saved before written
// again with the new flows, archive.ts `dayEntry`); (2) the index once, with the day's record and each merged flow's record
// marked `mergedInto` (listed in neither tab). Each flow's own file stays in `archive/`: the engine cannot move or remove
// a file, and a heal never lists a file the index names, so none comes back. A day with one flow and no session keeps
// that flow as it is; a day whose session is in the Trash is left alone. A file that cannot be read or written leaves its
// day as it is; a failed index write leaves every flow listed, and the next try finds them in the day's session and only
// marks them. Flows only the shared store holds are not merged.
export async function mergeDays(io: Io, project: string, today: string, now: number): Promise<DaysMerged> {
  if (!project) return { ok: true, merged: 0 }
  const dir = dataDir(project)
  const { arch, tr, view } = await both(io, dir, now)
  const warnings = [...arch.warnings, ...tr.warnings]
  const pending = view.records.filter(r => r.pendingDay && r.day && r.day < today && r.source !== 'store' && !r.missing)
  if (!pending.length) return { ok: true, merged: 0 }
  const errors: string[] = []
  const done: { rec: ArchiveRecord; ids: string[] }[] = []
  for (const day of [...new Set(pending.map(r => r.day!))].sort()) {
    const id = dayId(day, project)
    const held = view.records.find(r => r.id === id)
    if (!held && arch.records.some(r => r.id === id)) continue
    // A day's session whose file is gone is made again from its flows' own files.
    const isLost = !held || !!held.missing
    const flows = [...(isLost ? arch.records.filter(r => r.mergedInto === id && !r.missing) : []), ...pending.filter(r => r.day === day)]
    if (!held && flows.length < 2) continue
    const base = isLost ? undefined : await readRecord(io, dir, held!)
    if (!isLost && !base) {
      errors.push(`could not read ${ARCHIVE_DIR}/${held!.file}`)
      continue
    }
    const entries: ArchiveEntry[] = []
    for (const rec of flows) {
      const e = await readRecord(io, dir, rec)
      if (!e) break
      entries.push(e)
    }
    if (entries.length < flows.length) {
      errors.push(`could not read every flow of ${day}`)
      continue
    }
    // Every flow is in the day's session already (an index rebuilt from the folder lost their marks): only mark them.
    if (base && entries.every(e => base.mergedIds?.includes(e.id))) {
      done.push({ rec: held!, ids: flows.map(r => r.id) })
      continue
    }
    const merged = dayEntry(day, project, entries, base ?? undefined)
    if ((merged.agents?.length ?? 0) > DAY_MAX || merged.tasks.length > DAY_MAX) {
      errors.push(`${day} holds too many rows for one session`)
      continue
    }
    const text = JSON.stringify(merged)
    if (base) {
      if (!(await writeRaw(io, dir, `${ARCHIVE_DIR}/${held!.file}`, text))) {
        errors.push(`could not write ${ARCHIVE_DIR}/${held!.file}`)
        continue
      }
      done.push({ rec: recordOf(merged, held!.file, byteLength(text)), ids: flows.map(r => r.id) })
      continue
    }
    const put = await putSession(io, dir, merged, text)
    if ('error' in put) {
      errors.push(`could not write the session of ${day}`)
      continue
    }
    // A newer copy found in the day's slot is what the index lists: only the flows it holds are marked.
    done.push({ rec: recordOf(put.entry, put.file, put.size), ids: flows.map(r => r.id).filter(f => (put.entry.mergedIds ?? []).includes(f)) })
  }
  const error = errors.length ? errors.join('; ') : undefined
  if (!done.length) return { ok: !error, merged: 0, error, lists: { ...view, warnings } }
  // The index read again just before it is written, so a save made meanwhile is kept.
  const again = await heal(io, dir, 'archive', now)
  let records = again.records
  for (const d of done) records = upsertArchive(records, d.rec).map(r => (d.ids.includes(r.id) ? mergedInto(r, d.rec.id) : r))
  if (!(await writeIndex(io, dir, again, records, now, warnings))) {
    return { ok: false, merged: 0, error: [`could not write ${INDEX_FILE}`, ...errors].join('; '), lists: listsOf(again.records, tr.records, warnings) }
  }
  return { ok: !error, merged: done.length, error, lists: listsOf(records, tr.records, warnings) }
}

type Real ={ kind: string; isLink: boolean; realPath: string }

const statReal = async (io: Io, path: string): Promise<Real | null> => {
  const s: unknown = await Promise.resolve()
    .then(() => io.statReal?.(path))
    .catch(() => null)
  const o = s && typeof s === 'object' ? (s as { kind?: unknown; isLink?: unknown; realPath?: unknown }) : null
  return o && typeof o.kind === 'string' && typeof o.realPath === 'string' && o.realPath ? { kind: o.kind, isLink: o.isLink === true, realPath: o.realPath } : null
}

const WINDOWS_ERASE = '$p = $env:FLOWDECK_ERASE_FILE; if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -ErrorAction Stop } else { exit 3 }'

export type Erased = 'erased' | 'gone' | 'failed'

// The only code in flowdeck that erases a file (Empty Trash). It erases one session file in `.trash/` (side `trash`, a
// trash copy) or `archive/` (side `archive`, the session's original), and only when every check holds: the record's file
// name is exactly the one the store gives the record's own session there (its id's key and start, plus its trash time in
// `.trash/`; [a-z0-9-] only, no separator, no wildcard), the path is `<dir>/<folder>/<name>`, and what it resolves to is
// a plain file (no link) directly inside that resolved folder. One argv, no shell, no recursion: `unlink <file>` on macOS
// and Linux, PowerShell `Remove-Item -LiteralPath` (the path passed in the environment) on Windows. `erased` only when
// the file is then known to be gone; a file known to be missing is `gone`; anything else is `failed`, nothing erased.
export async function eraseSessionFile(io: Io, dir: string, side: Side, rec: Pick<ArchiveRecord, 'id' | 'file'>): Promise<Erased> {
  const name = rec.file
  const shape = side === 'trash' ? '-\\d+(?:-\\d+)?-t\\d+(?:-\\d+)?\\.json' : '-\\d+(?:-\\d+)?\\.json'
  if (!new RegExp(`^${keyOf(rec.id)}${shape}$`).test(name) || !dir || !io.run || !io.statReal) return 'failed'
  const folder = `${dir}/${folderOf(side)}`
  const path = `${folder}/${name}`
  const there = await isThere(io, path)
  if (there === 'no') return 'gone'
  if (there === 'unknown') return 'failed'
  const [d, f] = [await statReal(io, folder), await statReal(io, path)]
  if (!d || !f || d.kind !== 'dir' || f.kind !== 'file' || f.isLink) return 'failed'
  const base = d.realPath.replace(/[\\/]+$/, '')
  if (f.realPath !== `${base}/${name}` && f.realPath !== `${base}\\${name}`) return 'failed'
  const isWindows = /^[A-Za-z]:[\\/]|^\\\\/.test(base)
  const argv = isWindows ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ERASE] : ['unlink', f.realPath]
  await Promise.resolve()
    .then(() => io.run!(argv, isWindows ? { FLOWDECK_ERASE_FILE: f.realPath } : undefined))
    .catch(() => null)
  return (await isThere(io, path)) === 'no' ? 'erased' : 'failed'
}

export type Emptied = { ok: boolean; erased: number; failed: number; error?: string; lists?: ArchiveLists }

// Empty Trash, session by session (every id the trash index lists; `erased` and `failed` count sessions). A session the
// Trash shows (reconcile: hidden from the Archive) loses its original in `archive/` first, then every trash copy; a
// session back in the Archive (its copy already restored) loses only its copies, its archive file stays. A file already
// gone counts as erased; when the original cannot be erased its copies are left as they are. The trash index is then
// written with the records of the sessions that failed only (a copy of theirs that went shows `file missing`), so the
// user can press again. Nothing else is touched: not `archive-index.json` (an erased session's record stays there,
// hidden by its `trashedAt`, marked missing on the next load), `.trash/damaged/`, or any file not named by a record.
export async function emptyTrash(io: Io, project: string, now: number): Promise<Emptied> {
  if (!project) return { ok: false, erased: 0, failed: 0, error: 'no project folder' }
  const dir = dataDir(project)
  const { arch, tr, view } = await both(io, dir, now)
  const warnings = [...arch.warnings, ...tr.warnings]
  if (!tr.canWrite) return { ok: false, erased: 0, failed: 0, error: `${TRASH_DIR}/${TRASH_INDEX} cannot be written`, lists: { ...view, warnings } }
  const binned = new Set(view.trash.map(r => r.id))
  const ids = [...new Set(tr.records.map(r => r.id))]
  const failed = new Set<string>()
  const went = new Set<ArchiveRecord>()
  for (const id of ids) {
    const original = binned.has(id) ? arch.records.find(r => r.id === id && r.source !== 'store' && r.file) : undefined
    if (original && (await eraseSessionFile(io, dir, 'archive', original)) === 'failed') {
      failed.add(id)
      continue
    }
    for (const rec of tr.records.filter(r => r.id === id)) {
      if ((await eraseSessionFile(io, dir, 'trash', rec)) === 'failed') failed.add(id)
      else went.add(rec)
    }
  }
  const counts = { erased: ids.length - failed.size, failed: failed.size }
  const kept = tr.records.filter(r => failed.has(r.id)).map(r => (went.has(r) ? { ...r, missing: true } : r))
  if (kept.length === tr.records.length && !went.size) return { ok: !failed.size, ...counts, lists: { ...view, warnings } }
  if (!(await writeIndex(io, dir, tr, kept, now, warnings))) {
    // The index still lists the erased copies: they show as `file missing`, as the next load marks them.
    const shown = tr.records.map(r => (went.has(r) ? { ...r, missing: true } : r))
    return { ok: false, ...counts, error: `could not write ${TRASH_DIR}/${TRASH_INDEX}`, lists: listsOf(arch.records, shown, warnings) }
  }
  return { ok: !failed.size, ...counts, lists: listsOf(arch.records, kept, warnings) }
}

// One session's entry for an open group: its file in `archive/` or `.trash/`, or the shared store's copy; null when it
// cannot be read or holds another session.
export async function readSession(io: Io, project: string, list: Side, rec: ArchiveRecord): Promise<ArchiveEntry | null> {
  if (rec.source === 'store' || !project) return (await storedArchive(io, project)).find(e => e.id === rec.id) ?? null
  const entry = parseSession(parseJson(await readFile(io, `${dataDir(project)}/${folderOf(list)}/${rec.file}`)))
  return entry && entry.id === rec.id ? entry : null
}

// The shared store's save, as before project files: the entry added to what the store holds. When the store read fails,
// nothing is written, so a passing outage never overwrites the store. True when the store took it.
export async function saveToStore(io: Io, entry: ArchiveEntry): Promise<boolean> {
  let base: ArchiveEntry[]
  try {
    base = parseArchive(await io.storeGet())
  } catch {
    return false
  }
  return io.storeSet(addEntry(base, entry)).then(
    () => true,
    () => false,
  )
}
