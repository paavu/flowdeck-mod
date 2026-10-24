// A record of finished flowdeck flows, kept per project: one entry per flow with its runs, newest first.
import type { AgentRun, AgentStatus, Flow, HistoryAgent, HistoryEntry, HistorySegment, HistoryTask } from '../types'
import { itemsOf } from './agent-items'

const MAX_TASKS = 100
export const MAX_TEXT = 200
// Bounds one entry: the newest runs of a flow, each with its capped items and strings.
export const MAX_AGENTS = 60
// What one history file should stay under (the engine reads and writes at most 4 MiB a file).
export const MAX_HISTORY_CHARS = 3_000_000
// One history file (the active `history.json` or an archive `history-<n>.json`) stays under this.
export const SEGMENT_MAX = MAX_HISTORY_CHARS
export const ARCHIVE_FILE = /^history-(\d+)\.json$/
export const EXTRA_FILE = /^history-extra-\d+(?:-\d+)?\.json$/
export const archiveNumber = (file: string): number => Number(ARCHIVE_FILE.exec(file)?.[1] ?? 0)

const AGENT_STATUSES: readonly AgentStatus[] = ['running', 'done', 'failed']

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null)
const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : null)
const cap = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')
// The numbers of the tasks one waits for, from 1, as the progress tool takes them.
const afterOf = (list: unknown[]): number[] => list.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)

// One run, cleaned for keeping: the fields the rows draw, no live-only ones; null when it is no run.
// `end` closes a run still going when the flow is saved.
function agentOf(v: unknown, end?: number): HistoryAgent | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = cap(o.id)
  const status = AGENT_STATUSES.find(s => s === o.status)
  const startedAt = num(o.startedAt)
  if (!id || !status || startedAt === null) return null
  const a: HistoryAgent = {
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

const agentsOf = (list: unknown[], end?: number): HistoryAgent[] =>
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
}): HistoryEntry {
  const { flow, agents, project, startedAt, endedAt, status } = input
  const newest = [...agents].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_AGENTS)
  return {
    id: `${startedAt}-${project}`,
    project,
    title: flow.title,
    startedAt,
    endedAt,
    status,
    done: flow.done,
    total: flow.total,
    tasks: flow.tasks.map(t => ({ title: t.title, tier: t.tier, after: afterOf(t.after) })),
    cost: agents.reduce((s, a) => s + a.costUsd, 0),
    tokens: agents.reduce((s, a) => s + a.tokens, 0),
    // The span from the first start to the last end, as the panel header counts it (parallel runs overlap).
    time: agents.length ? Math.max(0, Math.max(...agents.map(a => a.endedAt ?? endedAt)) - Math.min(...agents.map(a => a.startedAt))) : 0,
    agents: agentsOf(newest, endedAt),
  }
}

export const isWorthKeeping = (e: HistoryEntry): boolean => e.tasks.length > 0 || e.done > 0 || e.cost > 0 || e.time > 0

// Nothing is ever dropped: a later snapshot of the same flow replaces its entry and moves it to the front.
export function addEntry(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  if (!isWorthKeeping(entry)) return history
  return [entry, ...history.filter(e => e.id !== entry.id)]
}

// The newest entries whose JSON stays under `maxChars`, and the older rest; the order is kept.
export function splitBySize(entries: HistoryEntry[], maxChars: number = MAX_HISTORY_CHARS): { kept: HistoryEntry[]; overflow: HistoryEntry[] } {
  let size = 2 // the brackets
  let at = 0
  for (; at < entries.length; at++) {
    const next = JSON.stringify(entries[at]).length + (at ? 1 : 0)
    if (size + next >= maxChars) break
    size += next
  }
  return { kept: entries.slice(0, at), overflow: entries.slice(at) }
}

// One split that always takes at least one entry, so an entry bigger than the limit still moves on.
const takeSegment = (entries: HistoryEntry[], maxChars: number) => {
  const s = splitBySize(entries, maxChars)
  return s.kept.length || !entries.length ? s : { kept: entries.slice(0, 1), overflow: entries.slice(1) }
}

// Under the limit, nothing moves. Over it, the newest entries within `keepChars` stay active and the rest is cut into
// archive segments under the limit, oldest first. Keeping half, not all, leaves room: else every later save would
// push one entry out into an archive of its own.
export function rotate(entries: HistoryEntry[], maxChars: number = SEGMENT_MAX, keepChars: number = maxChars / 2): { kept: HistoryEntry[]; archives: HistoryEntry[][] } {
  if (JSON.stringify(entries).length < maxChars) return { kept: entries, archives: [] }
  const { kept, overflow } = takeSegment(entries, keepChars)
  const archives: HistoryEntry[][] = []
  let rest = overflow
  while (rest.length) {
    const s = takeSegment(rest, maxChars)
    archives.unshift(s.kept)
    rest = s.overflow
  }
  return { kept, archives }
}

export function summarize(file: string, entries: HistoryEntry[], size: number = JSON.stringify(entries).length): HistorySegment {
  return {
    file,
    count: entries.length,
    from: entries.length ? Math.min(...entries.map(e => e.startedAt)) : 0,
    to: entries.length ? Math.max(...entries.map(e => e.endedAt)) : 0,
    cost: entries.reduce((s, e) => s + e.cost, 0),
    tokens: entries.reduce((s, e) => s + e.tokens, 0),
    time: entries.reduce((s, e) => s + e.time, 0),
    size,
  }
}

function parseSegment(v: unknown): HistorySegment | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const nums = [o.count, o.from, o.to, o.cost, o.tokens, o.time, o.size].map(num)
  if (typeof o.file !== 'string' || !ARCHIVE_FILE.test(o.file) || nums.some(n => n === null)) return null
  const [count, from, to, cost, tokens, time, size] = nums as number[]
  return { file: o.file, count: count!, from: from!, to: to!, cost: cost!, tokens: tokens!, time: time!, size: size! }
}

// `history-index.json`: the archives' summaries and the side files already merged into the active segment; null when it is no index.
export function parseIndex(raw: unknown): { segments: HistorySegment[]; merged: string[] } | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { segments?: unknown }).segments)) return null
  const o = raw as { segments: unknown[]; merged?: unknown }
  const segments = o.segments.flatMap(v => {
    const s = parseSegment(v)
    return s ? [s] : []
  })
  const merged = Array.isArray(o.merged) ? o.merged.filter((n): n is string => typeof n === 'string' && EXTRA_FILE.test(n)) : []
  return { segments, merged }
}

// The lists as one, each id once, in first-seen order; of two copies the later-ended one is kept.
export function mergeEntries(...lists: HistoryEntry[][]): HistoryEntry[] {
  const out: HistoryEntry[] = []
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

const canonical = (e: HistoryEntry): string => JSON.stringify(parseHistory([e])[0] ?? e)

// The list without the entries an archive already holds exactly (left behind by a rotation cut short); a changed copy stays.
export function withoutCopies(list: HistoryEntry[], archived: HistoryEntry[]): { list: HistoryEntry[]; removed: number } {
  const held = new Map(archived.map(e => [e.id, canonical(e)]))
  const next = list.filter(e => held.get(e.id) !== canonical(e))
  return { list: next, removed: list.length - next.length }
}

// The earliest start and the latest end of the entries.
export const spanOf = (entries: HistoryEntry[]): { from: number; to: number } => ({
  from: entries.length ? Math.min(...entries.map(e => e.startedAt)) : 0,
  to: entries.length ? Math.max(...entries.map(e => e.endedAt)) : 0,
})

function parseEntry(v: unknown): HistoryEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : null
  const project = text(o.project)
  const title = text(o.title)
  const nums = [o.startedAt, o.endedAt, o.done, o.total, o.cost, o.tokens, o.time].map(num)
  const status = o.status === 'finished' || o.status === 'open' ? o.status : null
  if (id === null || project === null || title === null || status === null || !Array.isArray(o.tasks) || nums.some(n => n === null)) return null
  const [startedAt, endedAt, done, total, cost, tokens, time] = nums as number[]
  const tasks: HistoryTask[] = o.tasks
    .flatMap(t => {
      const r = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
      const tt = text(r.title)
      const tier = text(r.tier)
      if (tt === null || tier === null) return []
      const task: HistoryTask = { title: tt, tier }
      if (Array.isArray(r.after)) task.after = afterOf(r.after)
      return [task]
    })
    .slice(0, MAX_TASKS)
  const entry: HistoryEntry = { id, project, title, startedAt: startedAt!, endedAt: endedAt!, status, done: done!, total: total!, tasks, cost: cost!, tokens: tokens!, time: time! }
  if (Array.isArray(o.agents)) entry.agents = agentsOf(o.agents).slice(-MAX_AGENTS)
  return entry
}

export function parseHistory(raw: unknown): HistoryEntry[] {
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
export function entryDate(entry: HistoryEntry, tz?: string): string {
  const end = partsOf(entry.endedAt, tz)
  const start = partsOf(entry.startedAt, tz)
  const isSameDay = start.day === end.day && start.year === end.year
  const from = isSameDay ? '' : `${start.year === end.year ? start.day : `${start.day}, ${start.year}`} → `
  return `${from}${end.day}, ${end.year} · ${end.time}`
}

// A span of days, `Oct 20 – Oct 26, 2026`; `Dec 28, 2025 – Jan 3, 2026` across a year; `Oct 26, 2026` within one day.
export function spanText(from: number, to: number, tz?: string): string {
  const a = partsOf(from, tz)
  const b = partsOf(to, tz)
  if (a.day === b.day && a.year === b.year) return `${b.day}, ${b.year}`
  return a.year === b.year ? `${a.day} – ${b.day}, ${b.year}` : `${a.day}, ${a.year} – ${b.day}, ${b.year}`
}

// The group's title, its short line (date, done/total, how it ended) and the task lines for an entry without runs.
export function formatEntry(entry: HistoryEntry, tz?: string): { head: string; line: string; lines: string[] } {
  const head = entry.title.trim() || 'Untitled flow'
  const status = entry.status === 'finished' ? 'finished' : 'ended with the session'
  const line = `${entryDate(entry, tz)} · ${entry.done}/${entry.total} · ${status}`
  // The flow only counts done tasks, not which ones, so the first `done` in plan order are shown done.
  const lines = entry.tasks.map((t, i) => `${i < entry.done ? '✓' : '○'} ${t.title} (${t.tier})`)
  return { head, line, lines }
}
