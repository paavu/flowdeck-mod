// The archive (formerly History): a record of finished flowdeck flows, kept per project, one entry per flow with its runs,
// and one per finished plan an older flowdeck saved, newest first by their end. Each entry is a session file of its own (see archive-store.ts).
import type { AgentRun, AgentStatus, ArchiveAgent, ArchiveEntry, ArchiveTask, Flow, PlanStage, PlanState, PlanStep, StepStatus, TaskPlan } from '../types'
import { itemsOf } from './agent-items'
import { sortNewest } from './order'
import { cleanText, NOTE_MAX, noteOf } from './notes'
import { stepsOfTask } from './orchestrator'
import { isFinished, isStoredStep } from './plan'
import { acceptedOf, linkRuns, modelOf, taskTag } from './tasks'
import type { RunLike, TaskLike } from './tasks'
import { dayKey, dayParts, isDayKey } from './time'

const MAX_TASKS = 100
export const MAX_TEXT = 200
// Bounds one entry: the newest runs of a flow, each with its capped items and strings.
export const MAX_AGENTS = 60
// Bounds a day's session (many flows in one): its tasks, its runs and the flows merged into it.
export const DAY_MAX = 2000
// What a file should stay under, in UTF-8 bytes: the engine reads and writes at most 4 MiB (4,194,304 bytes) a file, and
// the rest is room for one save's growth. The archive's indexes stay under it (an index past it is said).
export const MAX_ARCHIVE_BYTES = 2_500_000
export const VOLUME_MAX = MAX_ARCHIVE_BYTES
export const INDEX_MAX = MAX_ARCHIVE_BYTES
// No write bigger than this is ever sent: it counts as a failed write. A session file may take up to it.
export const WRITE_MAX = 3_900_000
// The files the archive kept before 1.0.0025 (its History names), read once by the migration and never written again:
// `history.json`, the volumes `history-<n>.json`, the volume index `history-index.json` and the side files
// `history-extra-<startedAt>.json` (`-2`, `-3` … when that name held another flow).
export const ACTIVE_FILE = 'history.json'
export const LEGACY_INDEX = 'history-index.json'
export const VOLUME_FILE = /^history-(\d+)\.json$/
export const EXTRA_FILE = /^history-extra-(\d+)(?:-\d+)?\.json$/
export const isLegacyFile = (name: string): boolean => name === ACTIVE_FILE || name === LEGACY_INDEX || VOLUME_FILE.test(name) || EXTRA_FILE.test(name)

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
// When each accepted task was accepted, by its number; anything else is left out, and nothing at all is undefined.
export function stampsOf(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
    const n = num(at)
    if (/^[1-9]\d*$/.test(k) && n !== null) out[k] = n
  }
  return Object.keys(out).length ? out : undefined
}

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
  const brief = cleanText(o.brief, NOTE_MAX.brief)
  if (brief) a.brief = brief
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
    tasks: flow.tasks.slice(0, MAX_TASKS).map(t => ({ title: cap(t.title), tier: cap(t.tier), after: afterOf(t.after).slice(0, MAX_TASKS), ...(modelOf(t.model) ? { model: modelOf(t.model) } : {}), ...noteOf(t), ...stepsOfTask(t) })),
    ...(flow.accepted ? { accepted: afterOf(flow.accepted).slice(0, MAX_TASKS) } : {}),
    ...(stampsOf(flow.acceptedAt) ? { acceptedAt: stampsOf(flow.acceptedAt) } : {}),
    cost: agents.reduce((s, a) => s + a.costUsd, 0),
    tokens: agents.reduce((s, a) => s + a.tokens, 0),
    // The span from the first start to the last end, as the panel header counts it (parallel runs overlap).
    time: agents.length ? Math.max(0, Math.max(...agents.map(a => a.endedAt ?? endedAt)) - Math.min(...agents.map(a => a.startedAt))) : 0,
    agents: agentsOf(newest, endedAt),
    day: dayKey(endedAt),
  }
}

// The id of a day's session in a project (dayEntry).
export const dayId = (day: string, project: string): string => `day-${day}-${project}`

/** One flow's rows as a day's list takes them; `sealed`: its runs were linked to its tasks when it was put together, so no run gets a task by likeness any more. */
export type DayPart<T extends TaskLike, R extends RunLike> = { tasks: T[]; runs: R[]; accepted: number[]; acceptedAt?: Record<string, number>; fallback?: number; sealed?: boolean }

// Several flows as one list: their tasks one after another (each flow's numbers and waits moved past the tasks before
// it), each run tied to the task its own flow gave it by a `#n` before its description (one its flow linked to no task
// keeps its description), the accepted tasks renumbered with their times (`fallback` for one without a time).
export function combineParts<T extends TaskLike, R extends RunLike>(parts: DayPart<T, R>[]): { tasks: T[]; runs: R[]; accepted: number[]; acceptedAt: Record<string, number> } {
  const tasks: T[] = []
  const runs: R[] = []
  const accepted: number[] = []
  const acceptedAt: Record<string, number> = {}
  for (const p of parts) {
    const o = tasks.length
    const links = linkRuns(p.sealed ? p.tasks.map(t => ({ ...t, counted: true })) : p.tasks, p.runs)
    for (const t of p.tasks) tasks.push(t.after ? { ...t, after: t.after.map(d => d + o) } : t)
    for (const a of p.runs) {
      const i = links.get(a.id)
      runs.push(i === undefined ? a : { ...a, description: `#${o + i + 1} ${taskTag(a.description).rest}` })
    }
    for (const n of p.accepted) {
      accepted.push(n + o)
      const at = p.acceptedAt?.[String(n)] ?? p.fallback
      if (at !== undefined) acceptedAt[String(n + o)] = at
    }
  }
  return { tasks, runs, accepted, acceptedAt }
}

// An entry as one part of a day's list: its runs ended by its own end at the latest.
export const dayPartOf = (e: ArchiveEntry): DayPart<ArchiveTask, ArchiveAgent> => ({
  tasks: e.tasks,
  runs: (e.agents ?? []).map(a => (a.endedAt === undefined ? { ...a, endedAt: e.endedAt } : a)),
  accepted: acceptedOf(e),
  acceptedAt: e.acceptedAt,
  fallback: e.endedAt,
  sealed: !!e.mergedIds,
})

// The finished flows of one day as one session: titled with the day's date, from the first start to the last end, their
// tasks and runs one after another in the order the flows started (combineParts), their totals added up. `base` is the
// day's session saved before, which the flows join; a flow it holds already is not added again.
export function dayEntry(day: string, project: string, flows: ArchiveEntry[], base?: ArchiveEntry): ArchiveEntry {
  const had = base?.mergedIds ?? []
  const added = flows.filter(e => !had.includes(e.id))
  const parts = [...(base ? [base] : []), ...added].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const c = combineParts(parts.map(dayPartOf))
  const startedAt = Math.min(...parts.map(e => e.startedAt))
  const endedAt = Math.max(...parts.map(e => e.endedAt))
  const sum = (k: 'done' | 'total' | 'cost' | 'tokens' | 'time') => parts.reduce((s, e) => s + e[k], 0)
  return {
    id: dayId(day, project),
    project,
    title: entryDate({ startedAt: endedAt, endedAt }, undefined, true),
    startedAt,
    endedAt,
    status: 'finished',
    done: sum('done'),
    total: sum('total'),
    tasks: c.tasks,
    accepted: c.accepted,
    ...(Object.keys(c.acceptedAt).length ? { acceptedAt: c.acceptedAt } : {}),
    cost: sum('cost'),
    tokens: sum('tokens'),
    time: sum('time'),
    agents: c.runs,
    day,
    mergedIds: [...had, ...parts.filter(e => e !== base).map(e => e.id)],
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

// A finished plan as its own entry, as flowdeck saved one before 1.0.0035 (the tests build archived plans with it): one
// id per plan and project, so saving it again replaces it. Dated by its end, or `at`
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

// The entries in the panel's one order: the latest end on top (order.ts).
export const byEnd = (list: ArchiveEntry[]): ArchiveEntry[] => sortNewest(list, e => ({ end: e.endedAt, start: e.startedAt, id: e.id }))

// Nothing is ever dropped: a later snapshot of the same flow replaces its entry; every entry sits where its end puts it.
export function addEntry(archive: ArchiveEntry[], entry: ArchiveEntry): ArchiveEntry[] {
  if (!isWorthKeeping(entry)) return archive
  return byEnd([entry, ...archive.filter(e => e.id !== entry.id)])
}

// Of two copies of one session, the one to keep: the later-ended; at the same end a full save over a partial one and a
// finished one over an open one; else the first.
export const isNewer = (e: { endedAt: number; partial?: boolean; status: string }, than: { endedAt: number; partial?: boolean; status: string }): boolean =>
  e.endedAt !== than.endedAt ? e.endedAt > than.endedAt : (!e.partial && !!than.partial) || (e.status === 'finished' && than.status !== 'finished' && !e.partial === !than.partial)

// The lists as one, each id once, in first-seen order; of two copies the newer one is kept.
export function mergeEntries(...lists: ArchiveEntry[][]): ArchiveEntry[] {
  const out: ArchiveEntry[] = []
  const at = new Map<string, number>()
  for (const e of lists.flat()) {
    const i = at.get(e.id)
    if (i === undefined) {
      at.set(e.id, out.length)
      out.push(e)
    } else if (isNewer(e, out[i]!)) out[i] = e
  }
  return out
}

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
  // A day's session holds many flows: its own, larger bounds.
  const mergedIds = Array.isArray(o.mergedIds) ? o.mergedIds.filter((x): x is string => typeof x === 'string' && !!x).slice(0, DAY_MAX) : null
  const maxTasks = mergedIds ? DAY_MAX : MAX_TASKS
  const tasks: ArchiveTask[] = o.tasks
    .flatMap(t => {
      const r = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
      const tt = text(r.title)
      const tier = text(r.tier)
      if (tt === null || tier === null) return []
      const task: ArchiveTask = { title: tt, tier, ...noteOf(r), ...stepsOfTask(r) }
      const model = modelOf(r.model)
      if (model) task.model = model
      if (Array.isArray(r.after)) task.after = afterOf(r.after)
      return [task]
    })
    .slice(0, maxTasks)
  const entry: ArchiveEntry = { id, project, title, startedAt: startedAt!, endedAt: endedAt!, status, done: done!, total: total!, tasks, cost: cost!, tokens: tokens!, time: time! }
  if (Array.isArray(o.agents)) entry.agents = agentsOf(o.agents).slice(-(mergedIds ? DAY_MAX : MAX_AGENTS))
  if (o.partial === true) entry.partial = true
  if (Array.isArray(o.accepted)) entry.accepted = afterOf(o.accepted).slice(0, maxTasks)
  const stamps = stampsOf(o.acceptedAt)
  if (stamps) entry.acceptedAt = stamps
  const plan = planOf(o.plan)
  if (plan && plan.stages.length) entry.plan = plan
  if (isDayKey(o.day)) entry.day = o.day
  if (mergedIds) entry.mergedIds = mergedIds
  return entry
}

// One session file's entry, or null when it holds none.
export const parseSession = (raw: unknown): ArchiveEntry | null => (raw && typeof raw === 'object' && !Array.isArray(raw) ? parseEntry(raw) : null)

export function parseArchive(raw: unknown): ArchiveEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(v => {
    const e = parseEntry(v)
    return e ? [e] : []
  })
}

// When the flow ended, `Oct 26, 2026 · 10:42`; one that started on an earlier day shows the range, `Oct 25 → Oct 26, 2026 · 10:42`.
// `compact` leaves out the time of day.
export function entryDate(entry: { startedAt: number; endedAt: number }, tz?: string, compact = false): string {
  const end = dayParts(entry.endedAt, tz)
  const start = dayParts(entry.startedAt, tz)
  const isSameDay = start.day === end.day && start.year === end.year
  const from = isSameDay ? '' : `${start.year === end.year ? start.day : `${start.day}, ${start.year}`} → `
  return `${from}${end.day}, ${end.year}${compact ? '' : ` · ${end.time}`}`
}

const statusOf = (entry: ArchiveEntry): string =>
  entry.partial ? 'archived while the flow runs' : entry.status === 'finished' ? 'finished' : 'ended with the session'

// The rows a session's group shows: its runs, or the tasks of an entry saved without runs; a plan's steps.
export const itemCountOf = (entry: ArchiveEntry): number => (entry.plan ? stepsOf(entry.plan).length : entry.agents?.length || entry.tasks.length)
export const taskCountOf = (entry: ArchiveEntry): number => (entry.plan ? stepsOf(entry.plan).length : entry.tasks.length)

// The group's fold line fitted to `cols`: the session's name and its item count, `Oct 26, 2026 · 10:42 (17)`, then
// without the time of day; an entry archived while its flow ran ends in ` · running`, dropped last. It needs no session
// file: the index record carries all of it.
export function groupLine(entry: { startedAt: number; endedAt: number; partial?: boolean; itemCount: number }, cols: number, tz?: string): string {
  const n = entry.itemCount
  const tail = entry.partial ? ' · running' : ''
  const date = entryDate(entry, tz)
  const day = entryDate(entry, tz, true)
  const tries = [`${date} (${n})${tail}`, `${day} (${n})${tail}`, `${day} (${n})`]
  return tries.find(t => t.length <= cols) ?? tries[tries.length - 1]
}

// The group's title, its short line (date, done/total, how it ended) and the task lines for an entry without runs.
export function formatEntry(entry: ArchiveEntry, tz?: string): { head: string; line: string; lines: string[] } {
  const head = entry.title.trim() || 'Untitled flow'
  const line = `${entryDate(entry, tz)} · ${entry.done}/${entry.total} · ${statusOf(entry)}`
  // The accepted tasks are ticked: the ones the flow named, or for an older flow that only counted them the first `done`.
  const accepted = new Set(acceptedOf(entry))
  const lines = entry.tasks.map((t, i) => `${accepted.has(i + 1) ? '✓' : '○'} ${t.title} (${t.tier})`)
  return { head, line, lines }
}
