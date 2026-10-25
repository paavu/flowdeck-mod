// The archive's persistence: the project folder's files and the shared store's fallback. Everything that reads or writes
// them for the archive lives here; the panel's state stays in register.tsx, which passes in what these need.
//
// The engine's `$` may not cross an import (the hooks loader follows it only into functions of register.tsx), so these
// take an `Io`: the few engine calls they make, built in register.tsx around `$`.
import type { ArchiveEntry, ArchiveVolume } from '../types'
import { addEntry, byteLength, EXTRA_FILE, MAX_TEXT, mergeEntries, notInVolumes, parseArchive, parseIndex, placeByEnd, rotate, sideName, sideStart, summarize, VOLUME_FILE, VOLUME_MAX, volumeEnds, volumeNumber, withoutCopies, WRITE_MAX } from './archive'

export type Io = {
  read: (path: string) => unknown
  write: (path: string, text: string) => unknown
  stat: (path: string) => unknown
  list: (dir: string) => unknown
  exists: (path: string) => unknown
  /** The shared store's `history` key (its name from before the rename). */
  storeGet: () => Promise<unknown>
  storeSet: (value: ArchiveEntry[]) => Promise<unknown>
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

// The names in a folder; null when it cannot be listed (a folder not made yet cannot either).
const listing = async (io: Io, dir: string): Promise<string[] | null> => {
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

// Writes the whole file into `dir`, no bigger than `max` bytes (VOLUME_MAX for side files, volumes and plans; history.json
// may pass it up to WRITE_MAX while it cannot rotate); the folder gets a `*` .gitignore first when it surely has none, so
// nothing in it is committed. False when the data write fails or is too big.
export async function writeData(io: Io, dir: string, name: string, data: unknown, max = WRITE_MAX): Promise<boolean> {
  const text = JSON.stringify(data)
  if (byteLength(text) > max) return false
  if ((await getFile(io, `${dir}/.gitignore`)).state === 'missing') await writeText(io, `${dir}/.gitignore`, '*\n')
  return writeText(io, `${dir}/${name}`, text)
}

// The archive's files and its store key keep their original names (from when it was called History) for compatibility, so
// nothing saved moves: in `<project>/.claude/flowdeck/`, none ever deleted, `history.json` the latest part (the newest),
// `history-<n>.json` the volumes (older, written once), `history-index.json` the volume index (their summaries, with the
// start and end of each flow they hold, and the side files merged so far; its JSON keeps the field name `segments`),
// `history-extra-<startedAt>.json` one side file per flow, written first on every save of it; and the shared store's
// `history` key, the archive from before the project files.
const ACTIVE_FILE = 'history.json'
const INDEX_FILE = 'history-index.json'
const volumeName = (n: number): string => `history-${n}.json`

// The shared store's archive (the one before project files): this project's entries, or all without a project.
const storedArchive = async (io: Io, project: string): Promise<ArchiveEntry[]> => {
  const list = parseArchive(await io.storeGet().catch(() => undefined))
  return project ? list.filter(e => e.project === project.trim().slice(0, MAX_TEXT)) : list
}

type Active = { state: 'ok'; entries: ArchiveEntry[]; size: number } | { state: 'missing' } | { state: 'unreadable' }
type Index = { state: 'ok' | 'missing'; volumes: ArchiveVolume[]; merged: string[] } | { state: 'unreadable' }

// A history.json that may be there but cannot be read, or that does not parse, is 'unreadable'; only a missing one is created.
const readActive = async (io: Io, dir: string): Promise<Active> => {
  const got = await getFile(io, `${dir}/${ACTIVE_FILE}`)
  if (got.state === 'missing') return got
  if (got.state !== 'ok') return { state: 'unreadable' }
  const raw = parseJson(got.text)
  return Array.isArray(raw) ? { state: 'ok', entries: parseArchive(raw), size: byteLength(got.text) } : { state: 'unreadable' }
}

const readIndex = async (io: Io, dir: string): Promise<Index> => {
  const got = await getFile(io, `${dir}/${INDEX_FILE}`)
  if (got.state === 'missing') return { state: 'missing', volumes: [], merged: [] }
  const index = got.state === 'ok' ? parseIndex(parseJson(got.text)) : null
  return index ? { state: 'ok', ...index } : { state: 'unreadable' }
}

// The volume index as written: the field keeps its original name `segments`.
const indexData = (volumes: ArchiveVolume[], merged: string[]) => ({ segments: volumes, merged })

// A volume's entries, each id once; null when it cannot be read or holds no list.
export const readVolume = async (io: Io, dir: string, file: string): Promise<{ entries: ArchiveEntry[]; size: number } | null> => {
  const text = await readFile(io, `${dir}/${file}`)
  const raw = parseJson(text)
  return text !== null && Array.isArray(raw) ? { entries: mergeEntries(parseArchive(raw)), size: byteLength(text) } : null
}

// The volumes, newest first: the index's, and any it misses (a rotation cut short before the index), summed up by reading
// them. A volume indexed before the index listed its flows is read to list them.
async function knownVolumes(io: Io, dir: string, indexed: ArchiveVolume[], names: string[]): Promise<ArchiveVolume[]> {
  const have = new Set(indexed.map(s => s.file))
  const known: ArchiveVolume[] = []
  for (const s of indexed) {
    const a = s.flows ? null : await readVolume(io, dir, s.file)
    known.push(a ? { ...s, flows: summarize(s.file, a.entries, a.size).flows } : s)
  }
  for (const file of names) {
    if (!VOLUME_FILE.test(file) || have.has(file)) continue
    const a = await readVolume(io, dir, file)
    if (a) known.push(summarize(file, a.entries, a.size))
  }
  return known.sort((a, b) => volumeNumber(b.file) - volumeNumber(a.file))
}

// The flow starts a side file need not be read for: a flow history.json holds as finished (its last save), or one a volume holds.
const accountedBy = (active: Active, ends: Map<number, number>) => {
  const finished = new Set(active.state === 'ok' ? active.entries.filter(e => e.status === 'finished').map(e => Math.round(e.startedAt)) : [])
  return (start: number): boolean => finished.has(start) || ends.has(start)
}

// The side files whose flow is not accounted for, newest first. The index's `merged` is not trusted on its own: another
// session may have written history.json without the flow after it was marked, and its side file then brings it back.
async function readExtras(io: Io, dir: string, names: string[], isAccounted: (start: number) => boolean): Promise<{ files: string[]; entries: ArchiveEntry[] }> {
  const files: string[] = []
  const lists: ArchiveEntry[][] = []
  for (const file of names.filter(n => EXTRA_FILE.test(n)).sort().reverse()) {
    const start = sideStart(file)
    if (start !== null && isAccounted(start)) continue
    const raw = parseJson(await readFile(io, `${dir}/${file}`))
    if (!Array.isArray(raw)) continue
    files.push(file)
    lists.push(parseArchive(raw))
  }
  return { files, entries: mergeEntries(...lists) }
}

// The list without exact copies of what the newest volumes hold, walking back until a volume holds none.
async function withoutVolumeCopies(io: Io, dir: string, list: ArchiveEntry[], vols: ArchiveVolume[]): Promise<ArchiveEntry[]> {
  let next = list
  for (const s of vols) {
    const a = await readVolume(io, dir, s.file)
    if (!a) break
    const r = withoutCopies(next, a.entries)
    if (!r.removed) break
    next = r.list
  }
  return next
}

const union = (a: string[], b: string[]): string[] => [...a, ...b.filter(x => !a.includes(x))]

export type Latest = { entries: ArchiveEntry[]; volumes: ArchiveVolume[]; isUnreadable: boolean }

// The latest part as the panel shows it, writing nothing: history.json, the side files it does not account for, and this
// project's entries in the shared store (where a failed write sent them), each flow once in its newest snapshot. What a
// volume holds as it is or newer is not shown again, whatever the size of history.json.
export async function loadLatest(io: Io, project: string): Promise<Latest> {
  if (!project) return { entries: await storedArchive(io, project), volumes: [], isUnreadable: false }
  const dir = dataDir(project)
  const names = (await listing(io, dir)) ?? []
  const index = await readIndex(io, dir)
  const vols = await knownVolumes(io, dir, index.state === 'unreadable' ? [] : index.volumes, names)
  const active = await readActive(io, dir)
  const ends = volumeEnds(vols)
  const extras = await readExtras(io, dir, names, accountedBy(active, ends))
  const entries = placeByEnd(active.state === 'ok' ? active.entries : [], mergeEntries(extras.entries, await storedArchive(io, project)))
  return { entries: notInVolumes(entries, ends), volumes: vols, isUnreadable: active.state === 'unreadable' }
}

const SIDE_SLOTS = 100

// The flow's own side file, written before anything else: the slot that holds this flow already, else the first free one.
// A slot holding anything else, or one that cannot be read, is never written over; a newer copy of the flow stays as it is.
// The slot's name, or null when nothing could be written.
async function writeSide(io: Io, dir: string, entry: ArchiveEntry): Promise<string | null> {
  for (let k = 1; k <= SIDE_SLOTS; k++) {
    const file = sideName(entry.startedAt, k)
    const got = await getFile(io, `${dir}/${file}`)
    if (got.state === 'unreadable') {
      if (got.isUnknown) return null // the fs cannot tell what is there: write nothing
      continue
    }
    if (got.state === 'ok') {
      const raw = parseJson(got.text)
      const held = Array.isArray(raw) && raw.length === 1 ? parseArchive(raw) : []
      if (held.length !== 1 || held[0]!.id !== entry.id) continue
      if (held[0]!.endedAt > entry.endedAt) return file
    }
    return (await writeData(io, dir, file, [entry], VOLUME_MAX)) ? file : null
  }
  return null
}

export type Saved = { isSaved: boolean; latest: ArchiveEntry[]; volumes?: ArchiveVolume[]; isUnreadable?: boolean }

// Append-only first: the flow's own side file is written before anything else, so no overwrite of history.json or the index
// by another session can lose it (the next load reads it back). Then the folder is read again and merged: history.json, the
// side files it does not account for and this project's entries in the shared store. Over `volumeMax`, the oldest entries
// move out in this order: (a) each new volume, (b) the index, (c) only then history.json without them, so a crash leaves
// copies, never a gap. A failed or too big write keeps everything in history.json when that fits; `isSaved` false sends the
// entry to the shared store too.
export async function saveToProject(io: Io, project: string, volumeMax: number, entry: ArchiveEntry): Promise<Saved> {
  const dir = dataDir(project)
  await writeSide(io, dir, entry)
  const names = (await listing(io, dir)) ?? []
  const index = await readIndex(io, dir)
  const active = await readActive(io, dir)
  const indexed = index.state === 'unreadable' ? [] : index.volumes
  const merged = index.state === 'unreadable' ? [] : index.merged
  const vols = await knownVolumes(io, dir, indexed, names)
  const ends = volumeEnds(vols)
  const extras = await readExtras(io, dir, names, accountedBy(active, ends))
  const stored = notInVolumes(await storedArchive(io, project), ends)
  if (active.state === 'unreadable') {
    // There but not usable, or not known to be absent: it is never overwritten; the side file and the store keep the entry.
    return { isSaved: false, latest: notInVolumes(addEntry(placeByEnd([], mergeEntries(extras.entries, stored)), entry), ends), volumes: vols, isUnreadable: true }
  }
  const all = addEntry(placeByEnd(active.state === 'ok' ? active.entries : [], mergeEntries(notInVolumes(extras.entries, ends), stored)), entry)
  const isMerging = extras.files.some(f => !merged.includes(f))
  const keepAll = async (): Promise<Saved> => ({ isSaved: await writeData(io, dir, ACTIVE_FILE, all), latest: notInVolumes(all, ends), volumes: vols })
  // An index that cannot be read is never overwritten, so nothing rotates: history.json grows past the limit (a soft one) up
  // to the largest write, and after that the side files and the store keep the new flows.
  if (index.state === 'unreadable' || !rotate(all, volumeMax).volumes.length) {
    const saved = await keepAll()
    if (saved.isSaved && isMerging && index.state !== 'unreadable') await writeData(io, dir, INDEX_FILE, indexData([...vols].reverse(), union(merged, extras.files)))
    return saved
  }
  const list = await withoutVolumeCopies(io, dir, all, vols)
  const { kept, volumes: chunks } = rotate(list, volumeMax)
  const made: ArchiveVolume[] = []
  let n = Math.max(0, ...vols.map(s => volumeNumber(s.file)), ...names.map(volumeNumber)) + 1
  for (const chunk of chunks) {
    let there = await isThere(io, `${dir}/${volumeName(n)}`)
    while (there === 'yes') there = await isThere(io, `${dir}/${volumeName(++n)}`)
    // A name that may be taken is never written over: nothing rotates this time.
    if (there === 'unknown') return keepAll()
    const file = volumeName(n)
    if (!(await writeData(io, dir, file, chunk, VOLUME_MAX))) return keepAll()
    made.push(summarize(file, chunk))
    n++
  }
  const known = [...vols, ...made].sort((a, b) => volumeNumber(a.file) - volumeNumber(b.file))
  const knownEnds = volumeEnds(known)
  const isHealing = known.length !== indexed.length
  if (isHealing && !(await writeData(io, dir, INDEX_FILE, indexData(known, merged)))) return keepAll()
  const shown = [...known].reverse()
  if (!(await writeData(io, dir, ACTIVE_FILE, kept))) return { isSaved: false, latest: notInVolumes(list, knownEnds), volumes: shown }
  // The side files are marked merged only once history.json holds them.
  if (isMerging) await writeData(io, dir, INDEX_FILE, indexData(known, union(merged, extras.files)))
  return { isSaved: true, latest: notInVolumes(kept, knownEnds), volumes: shown }
}

// The shared store's save, as before project files: the entry added to what the store holds, the list returned. When the
// store read fails, the entry is added to `shown()` (this session's view) and nothing is written, so a passing outage never
// overwrites the store.
export async function saveToStore(io: Io, entry: ArchiveEntry, shown: () => Promise<ArchiveEntry[]>): Promise<ArchiveEntry[]> {
  let base: ArchiveEntry[]
  let isRead = true
  try {
    base = parseArchive(await io.storeGet())
  } catch {
    base = await shown()
    isRead = false
  }
  const next = addEntry(base, entry)
  if (isRead) await io.storeSet(next).catch(() => {})
  return next
}
