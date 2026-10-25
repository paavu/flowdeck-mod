// The archive (formerly History): a record of finished flowdeck flows, kept per project, one entry per flow with its runs,
// and one per finished plan, newest first. Its files keep their original `history*` names for compatibility (see archive-store.ts).
import type { AgentRun, AgentStatus, ArchiveAgent, ArchiveEntry, ArchiveTask, ArchiveVolume, Flow, PlanStage, PlanState, PlanStep, StepStatus, TaskPlan } from '../types'
import { itemsOf } from './agent-items'
import { isFinished, isStoredStep } from './plan'

const MAX_TASKS = 100
export const MAX_TEXT = 200
// Bounds one entry: the newest runs of a flow, each with its capped items and strings.
export const MAX_AGENTS = 60
// What one saved file should stay under, in UTF-8 bytes: the engine reads and writes at most 4 MiB (4,194,304 bytes) a file,
// and the rest is room for the index, merged side files and one save's growth.
export const MAX_ARCHIVE_BYTES = 2_500_000
// One archive file (the active `history.json`, a volume `history-<n>.json`, a side file) and `plans.json` stay under this.
export const VOLUME_MAX = MAX_ARCHIVE_BYTES
// No write bigger than this is ever sent: it counts as a failed write.
export const WRITE_MAX = 3_900_000
// The archive's files keep their original names (from when it was called History) for compatibility: nothing saved moves.
// A volume is `history-<n>.json`.
export const VOLUME_FILE = /^history-(\d+)\.json$/
// A side file is named after its flow's start: `history-extra-<startedAt>.json`, `-2`, `-3` … when that name holds another flow.
export const EXTRA_FILE = /^history-extra-(\d+)(?:-\d+)?\.json$/
export const volumeNumber = (file: string): number => Number(VOLUME_FILE.exec(file)?.[1] ?? 0)
export const sideName = (startedAt: number, k = 1): string => `history-extra-${Math.round(startedAt)}${k > 1 ? `-${k}` : ''}.json`
export const sideStart = (file: string): number | null => {
  const m = EXTRA_FILE.exec(file)
  return m ? Number(m[1]) : null
}

// The UTF-8 size of a text: 1 byte up to U+007F, 2 up to U+07FF, 4 for a surrogate pair, else 3 (a lone surrogate is written as U+FFFD).
// A short element key for an id that may hold a path or free text: the engine matches keys exactly, so a key keeps to
// [a-z0-9]. FNV-1a 32-bit of the code points, then the length.
export function keyOf(id: string): string {
  let h = 0x811c9dc5
  for (const ch of id) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0
  return `k${h.toString(36).padStart(7, '0')}${id.length.toString(36)}`
}

export function byteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

export const jsonBytes = (v: unknown): number => byteLength(JSON.stringify(v))

const AGENT_STATUSES: readonly AgentStatus[] = ['running', 'done', 'failed']

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null)
const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : null)
const cap = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')
// The numbers of the tasks one waits for, from 1, as the progress tool takes them.
const afterOf = (list: unknown[]): number[] => list.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)

// One run, cleaned for keeping: the fields the rows draw, no live-only ones; null when it is no run.
// `end` closes a run still going when the flow is saved.
function agentOf(v: unknown, end?: number): ArchiveAgent | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = cap(o.id)
  const status = AGENT_STATUSES.find(s => s === o.status)
  const startedAt = num(o.startedAt)
  if (!id || !status || startedAt === null) return null
  const a: ArchiveAgent = {
    id,
    type: cap(o.type),
    description: cap(o.description),
    model: cap(o.model),
    status,
    startedAt,
    contextTokens: num(o.contextTokens) ?? 0,
    contextMax: num(o.contextMax) ?? 0,
    tokens: num(o.tokens) ?? 0,
    costUsd: num(o.costUsd) ?? 0,
    steps: num(o.steps) ?? 0,
    round: num(o.round) ?? 1,
  }
  if (typeof o.agentId === 'string') a.agentId = cap(o.agentId)
  if (typeof o.effort === 'string') a.effort = cap(o.effort)
  const endedAt = num(o.endedAt) ?? end
  if (endedAt !== undefined) a.endedAt = endedAt
  const stepDone = num(o.stepDone)
  const stepTotal = num(o.stepTotal)
  if (stepDone !== null) a.stepDone = stepDone
  if (stepTotal !== null) a.stepTotal = stepTotal
  if (typeof o.stepNote === 'string') a.stepNote = cap(o.stepNote)
  const items = itemsOf(o.items)
  if (items.length) a.items = items
  return a
}

const agentsOf = (list: unknown[], end?: number): ArchiveAgent[] =>
  list.flatMap(v => {
    const a = agentOf(v, end)
    return a ? [a] : []
  })

export function snapshot(input: {
  flow: Flow
  agents: AgentRun[]
  project: string
  startedAt: number
  endedAt: number
  status: 'finished' | 'open'
}): ArchiveEntry {
  const { flow, agents, project, startedAt, endedAt, status } = input
  const newest = [...agents].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_AGENTS)
  // Capped as they are written, so one entry stays far below a file's limit.
  return {
    id: `${startedAt}-${project}`,
    project,
    title: cap(flow.title),
    startedAt,
    endedAt,
    status,
    done: flow.done,
    total: flow.total,
    tasks: flow.tasks.slice(0, MAX_TASKS).map(t => ({ title: cap(t.title), tier: cap(t.tier), after: afterOf(t.after).slice(0, MAX_TASKS) })),
    cost: agents.reduce((s, a) => s + a.costUsd, 0),
    tokens: agents.reduce((s, a) => s + a.tokens, 0),
    // The span from the first start to the last end, as the panel header counts it (parallel runs overlap).
    time: agents.length ? Math.max(0, Math.max(...agents.map(a => a.endedAt ?? endedAt)) - Math.min(...agents.map(a => a.startedAt))) : 0,
    agents: agentsOf(newest, endedAt),
  }
}

const MAX_STEPS = 100
const PLAN_STATES: readonly PlanState[] = ['running', 'needs_input', 'error', 'done']

// A plan as the archive keeps it, or null when it is no plan: broken stages and steps are dropped (a stage left with no
// step too), at most 100 steps and 100 substeps in all, strings at 200.
function planOf(v: unknown): TaskPlan | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const startedAt = num(o.startedAt)
  if (typeof o.id !== 'string' || !o.id || startedAt === null || !Array.isArray(o.stages)) return null
  let steps = 0
  let subs = 0
  const stages: PlanStage[] = []
  for (const s of o.stages as unknown[]) {
    const r = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
    if (typeof r.name !== 'string' || !Array.isArray(r.steps)) continue
    const kept: PlanStep[] = []
    for (const st of r.steps as unknown[]) {
      if (steps >= MAX_STEPS) break
      if (!isStoredStep(st)) continue
      const x = st as Record<string, unknown>
      const step: PlanStep = { title: cap(x.title), status: x.status as StepStatus, substeps: [] }
      for (const sub of Array.isArray(x.substeps) ? x.substeps : []) {
        if (subs >= MAX_STEPS) break
        if (!isStoredStep(sub)) continue
        step.substeps.push({ title: cap(sub.title), status: sub.status })
        subs++
      }
      const doneAt = num(x.doneAt)
      if (doneAt !== null) step.doneAt = doneAt
      kept.push(step)
      steps++
    }
    if (kept.length) stages.push({ name: cap(r.name), steps: kept })
  }
  return {
    id: cap(o.id),
    title: cap(o.title),
    kind: o.kind === 'todo' ? 'todo' : 'plan',
    stages,
    state: PLAN_STATES.find(x => x === o.state) ?? 'done',
    note: typeof o.note === 'string' ? cap(o.note) : null,
    startedAt,
    endedAt: num(o.endedAt),
  }
}

const stepsOf = (p: TaskPlan): PlanStep[] => p.stages.flatMap(s => s.steps)

// A finished plan as its own entry: one id per plan and project, so saving it again replaces it. Dated by its end, or `at`
// (the save) when it has none; no tasks, runs, cost or tokens.
export function planEntry(plan: TaskPlan, project: string, at: number): ArchiveEntry {
  const p = planOf(plan) ?? { ...plan, stages: [] }
  const endedAt = typeof p.endedAt === 'number' ? p.endedAt : at
  const steps = stepsOf(p)
  return {
    id: `plan-${p.id}-${p.startedAt}-${project}`,
    project,
    title: p.title.trim(),
    startedAt: p.startedAt,
    endedAt,
    status: 'finished',
    done: steps.filter(st => isFinished(st.status)).length,
    total: steps.length,
    tasks: [],
    cost: 0,
    tokens: 0,
    time: Math.max(0, endedAt - p.startedAt),
    plan: { ...p, endedAt },
  }
}

export const isWorthKeeping = (e: ArchiveEntry): boolean =>
  e.plan ? stepsOf(e.plan).length > 0 : e.tasks.length > 0 || e.done > 0 || e.cost > 0 || e.time > 0

// Nothing is ever dropped: a later snapshot of the same flow replaces its entry and moves it to the front. A plan goes
// where its end puts it, as it may have finished before the newest entries.
export function addEntry(archive: ArchiveEntry[], entry: ArchiveEntry): ArchiveEntry[] {
  if (!isWorthKeeping(entry)) return archive
  const rest = archive.filter(e => e.id !== entry.id)
  return entry.plan ? placeByEnd(rest, [entry]) : [entry, ...rest]
}

// The newest entries whose JSON stays under `maxBytes` (UTF-8), and the older rest; the order is kept.
export function splitBySize(entries: ArchiveEntry[], maxBytes: number = MAX_ARCHIVE_BYTES): { kept: ArchiveEntry[]; overflow: ArchiveEntry[] } {
  let size = 2 // the brackets
  let at = 0
  for (; at < entries.length; at++) {
    const next = jsonBytes(entries[at]) + (at ? 1 : 0)
    if (size + next >= maxBytes) break
    size += next
  }
  return { kept: entries.slice(0, at), overflow: entries.slice(at) }
}

// One split that always takes at least one entry, so an entry bigger than the limit still moves on.
const takeVolume = (entries: ArchiveEntry[], maxBytes: number) => {
  const s = splitBySize(entries, maxBytes)
  return s.kept.length || !entries.length ? s : { kept: entries.slice(0, 1), overflow: entries.slice(1) }
}

// Under the limit (UTF-8 bytes), nothing moves. Over it, the newest entries within `keepBytes` stay active and the rest is
// cut into archive volumes under the limit, oldest first. Keeping half, not all, leaves room: else every later save would
// push one entry out into a volume of its own.
export function rotate(entries: ArchiveEntry[], maxBytes: number = VOLUME_MAX, keepBytes: number = maxBytes / 2): { kept: ArchiveEntry[]; volumes: ArchiveEntry[][] } {
  if (jsonBytes(entries) < maxBytes) return { kept: entries, volumes: [] }
  const { kept, overflow } = takeVolume(entries, keepBytes)
  const volumes: ArchiveEntry[][] = []
  let rest = overflow
  while (rest.length) {
    const s = takeVolume(rest, maxBytes)
    volumes.unshift(s.kept)
    rest = s.overflow
  }
  return { kept, volumes }
}

// `flows` holds each entry's start and end, so a reader knows what the volume holds without reading it.
export function summarize(file: string, entries: ArchiveEntry[], size: number = jsonBytes(entries)): ArchiveVolume {
  return {
    file,
    count: entries.length,
    from: entries.length ? Math.min(...entries.map(e => e.startedAt)) : 0,
    to: entries.length ? Math.max(...entries.map(e => e.endedAt)) : 0,
    cost: entries.reduce((s, e) => s + e.cost, 0),
    tokens: entries.reduce((s, e) => s + e.tokens, 0),
    time: entries.reduce((s, e) => s + e.time, 0),
    size,
    flows: entries.map(e => [Math.round(e.startedAt), e.endedAt]),
  }
}

const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(n => num(n) !== null)

function parseVolume(v: unknown): ArchiveVolume | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const nums = [o.count, o.from, o.to, o.cost, o.tokens, o.time, o.size].map(num)
  if (typeof o.file !== 'string' || !VOLUME_FILE.test(o.file) || nums.some(n => n === null)) return null
  const [count, from, to, cost, tokens, time, size] = nums as number[]
  const s: ArchiveVolume = { file: o.file, count: count!, from: from!, to: to!, cost: cost!, tokens: tokens!, time: time!, size: size! }
  // An index written before 1.0.0007 has no `flows`: the reader learns them from the volume itself.
  if (Array.isArray(o.flows) && o.flows.every(isPair)) s.flows = o.flows.map(p => [Math.round(p[0]), p[1]])
  return s
}

// The latest end each start in a volume has, over every volume that says what it holds.
export function volumeEnds(volumes: ArchiveVolume[]): Map<number, number> {
  const ends = new Map<number, number>()
  for (const s of volumes) for (const [start, end] of s.flows ?? []) ends.set(start, Math.max(end, ends.get(start) ?? -Infinity))
  return ends
}

// Whether a volume holds this flow as it is or newer: then the copy is not shown or saved again; a later snapshot is.
export const isInVolume = (e: ArchiveEntry, ends: Map<number, number>): boolean => (ends.get(Math.round(e.startedAt)) ?? -Infinity) >= e.endedAt

export const notInVolumes = (list: ArchiveEntry[], ends: Map<number, number>): ArchiveEntry[] => (ends.size ? list.filter(e => !isInVolume(e, ends)) : list)

// `history-index.json` (the volume index): the volumes' summaries and the side files already merged into the latest
// part (`history.json`); null when it is no index. Its JSON keeps the field name `segments`.
export function parseIndex(raw: unknown): { volumes: ArchiveVolume[]; merged: string[] } | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { segments?: unknown }).segments)) return null
  const o = raw as { segments: unknown[]; merged?: unknown }
  const volumes = o.segments.flatMap(v => {
    const s = parseVolume(v)
    return s ? [s] : []
  })
  const merged = Array.isArray(o.merged) ? o.merged.filter((n): n is string => typeof n === 'string' && EXTRA_FILE.test(n)) : []
  return { volumes, merged }
}

// The lists as one, each id once, in first-seen order; of two copies the later-ended one is kept.
export function mergeEntries(...lists: ArchiveEntry[][]): ArchiveEntry[] {
  const out: ArchiveEntry[] = []
  const at = new Map<string, number>()
  for (const e of lists.flat()) {
    const i = at.get(e.id)
    if (i === undefined) {
      at.set(e.id, out.length)
      out.push(e)
    } else if (e.endedAt > out[i]!.endedAt) out[i] = e
  }
  return out
}

// `base` in its own order, with each entry of `incoming` it lacks, or holds an older copy of, put before the first entry
// that ended before it: a flow brought back from a side file or the store sits where it belongs in time.
export function placeByEnd(base: ArchiveEntry[], incoming: ArchiveEntry[]): ArchiveEntry[] {
  let out = base
  for (const e of mergeEntries(incoming)) {
    const old = out.find(x => x.id === e.id)
    if (old && old.endedAt >= e.endedAt) continue
    const rest = old ? out.filter(x => x.id !== e.id) : out
    const at = rest.findIndex(x => x.endedAt < e.endedAt)
    out = at < 0 ? [...rest, e] : [...rest.slice(0, at), e, ...rest.slice(at)]
  }
  return out
}

const canonical = (e: ArchiveEntry): string => JSON.stringify(parseArchive([e])[0] ?? e)

// The list without the entries a volume already holds exactly (left behind by a rotation cut short); a changed copy stays.
export function withoutCopies(list: ArchiveEntry[], inVolume: ArchiveEntry[]): { list: ArchiveEntry[]; removed: number } {
  const held = new Map(inVolume.map(e => [e.id, canonical(e)]))
  const next = list.filter(e => held.get(e.id) !== canonical(e))
  return { list: next, removed: list.length - next.length }
}

// The earliest start and the latest end of the entries.
export const spanOf = (entries: ArchiveEntry[]): { from: number; to: number } => ({
  from: entries.length ? Math.min(...entries.map(e => e.startedAt)) : 0,
  to: entries.length ? Math.max(...entries.map(e => e.endedAt)) : 0,
})

function parseEntry(v: unknown): ArchiveEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : null
  const project = text(o.project)
  const title = text(o.title)
  const nums = [o.startedAt, o.endedAt, o.done, o.total, o.cost, o.tokens, o.time].map(num)
  const status = o.status === 'finished' || o.status === 'open' ? o.status : null
  if (id === null || project === null || title === null || status === null || !Array.isArray(o.tasks) || nums.some(n => n === null)) return null
  const [startedAt, endedAt, done, total, cost, tokens, time] = nums as number[]
  const tasks: ArchiveTask[] = o.tasks
    .flatMap(t => {
      const r = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
      const tt = text(r.title)
      const tier = text(r.tier)
      if (tt === null || tier === null) return []
      const task: ArchiveTask = { title: tt, tier }
      if (Array.isArray(r.after)) task.after = afterOf(r.after)
      return [task]
    })
    .slice(0, MAX_TASKS)
  const entry: ArchiveEntry = { id, project, title, startedAt: startedAt!, endedAt: endedAt!, status, done: done!, total: total!, tasks, cost: cost!, tokens: tokens!, time: time! }
  if (Array.isArray(o.agents)) entry.agents = agentsOf(o.agents).slice(-MAX_AGENTS)
  if (o.partial === true) entry.partial = true
  const plan = planOf(o.plan)
  if (plan && plan.stages.length) entry.plan = plan
  return entry
}

export function parseArchive(raw: unknown): ArchiveEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(v => {
    const e = parseEntry(v)
    return e ? [e] : []
  })
}

// A time's day and clock in the given time zone (the local one when none is given).
const partsOf = (at: number, tz?: string) => {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(at))) p[x.type] = x.value
  return { day: `${p.month} ${p.day}`, year: p.year ?? '', time: `${p.hour}:${p.minute} ${p.dayPeriod}` }
}

// When the flow ended, `Oct 26, 2026 · 10:42 AM`; one that started on an earlier day shows the range, `Oct 25 → Oct 26, 2026 · 10:42 AM`.
// `compact` leaves out the time of day.
export function entryDate(entry: ArchiveEntry, tz?: string, compact = false): string {
  const end = partsOf(entry.endedAt, tz)
  const start = partsOf(entry.startedAt, tz)
  const isSameDay = start.day === end.day && start.year === end.year
  const from = isSameDay ? '' : `${start.year === end.year ? start.day : `${start.day}, ${start.year}`} → `
  return `${from}${end.day}, ${end.year}${compact ? '' : ` · ${end.time}`}`
}

const statusOf = (entry: ArchiveEntry): string =>
  entry.partial ? 'archived while the flow runs' : entry.status === 'finished' ? 'finished' : 'ended with the session'

// The group's fold line fitted to `cols`: `Oct 26, 2026 · 10:42 AM · 17 items`, then without the time of day,
// then with the bare count; an entry archived while its flow ran ends in ` · running`. The count is the rows the
// group shows: its runs, or the tasks of an entry saved without runs; a plan's counts its steps, `· 3 steps`.
export function groupLine(entry: ArchiveEntry, cols: number, tz?: string): string {
  const n = entry.plan ? stepsOf(entry.plan).length : entry.agents?.length || entry.tasks.length
  const items = entry.plan ? `${n} ${n === 1 ? 'step' : 'steps'}` : `${n} ${n === 1 ? 'item' : 'items'}`
  const tail = entry.partial ? ' · running' : ''
  const date = entryDate(entry, tz)
  const day = entryDate(entry, tz, true)
  const tries = [`${date} · ${items}${tail}`, `${day} · ${items}${tail}`, `${day} · ${n}${tail}`, `${day} · ${n}`]
  return tries.find(t => t.length <= cols) ?? tries[tries.length - 1]
}

// A span of days, `Oct 20 – Oct 26, 2026`; `Dec 28, 2025 – Jan 3, 2026` across a year; `Oct 26, 2026` within one day.
export function spanText(from: number, to: number, tz?: string): string {
  const a = partsOf(from, tz)
  const b = partsOf(to, tz)
  if (a.day === b.day && a.year === b.year) return `${b.day}, ${b.year}`
  return a.year === b.year ? `${a.day} – ${b.day}, ${b.year}` : `${a.day}, ${a.year} – ${b.day}, ${b.year}`
}

// The group's title, its short line (date, done/total, how it ended) and the task lines for an entry without runs.
export function formatEntry(entry: ArchiveEntry, tz?: string): { head: string; line: string; lines: string[] } {
  const head = entry.title.trim() || 'Untitled flow'
  const line = `${entryDate(entry, tz)} · ${entry.done}/${entry.total} · ${statusOf(entry)}`
  // The flow only counts done tasks, not which ones, so the first `done` in plan order are shown done.
  const lines = entry.tasks.map((t, i) => `${i < entry.done ? '✓' : '○'} ${t.title} (${t.tier})`)
  return { head, line, lines }
}
