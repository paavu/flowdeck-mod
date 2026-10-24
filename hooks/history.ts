// A record of finished flowdeck flows, kept per project: one summary per flow, newest first.
import type { AgentRun, Flow, HistoryEntry, HistoryTask } from '../types'
import { tokens as fmtTokens } from './context'

export const MAX_ENTRIES = 50
const MAX_TASKS = 100
export const MAX_TEXT = 200
const MIN = 60_000

export function snapshot(input: {
  flow: Flow
  agents: AgentRun[]
  project: string
  startedAt: number
  endedAt: number
  status: 'finished' | 'open'
}): HistoryEntry {
  const { flow, agents, project, startedAt, endedAt, status } = input
  return {
    id: `${startedAt}-${project}`,
    project,
    title: flow.title,
    startedAt,
    endedAt,
    status,
    done: flow.done,
    total: flow.total,
    tasks: flow.tasks.map(t => ({ title: t.title, tier: t.tier })),
    cost: agents.reduce((s, a) => s + a.costUsd, 0),
    tokens: agents.reduce((s, a) => s + a.tokens, 0),
    // The span from the first start to the last end, as the panel header counts it (parallel runs overlap).
    time: agents.length ? Math.max(0, Math.max(...agents.map(a => a.endedAt ?? endedAt)) - Math.min(...agents.map(a => a.startedAt))) : 0,
  }
}

export const isWorthKeeping = (e: HistoryEntry): boolean => e.tasks.length > 0 || e.done > 0 || e.cost > 0 || e.time > 0

export function addEntry(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  if (!isWorthKeeping(entry)) return history
  return [entry, ...history.filter(e => e.id !== entry.id)].slice(0, MAX_ENTRIES)
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null)
const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : null)

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
      return tt === null || tier === null ? [] : [{ title: tt, tier }]
    })
    .slice(0, MAX_TASKS)
  return { id, project, title, startedAt: startedAt!, endedAt: endedAt!, status, done: done!, total: total!, tasks, cost: cost!, tokens: tokens!, time: time! }
}

export function parseHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(v => {
    const e = parseEntry(v)
    return e ? [e] : []
  })
}

const fmtCost = (usd: number) => `≈$${usd < 100 ? usd.toFixed(2) : usd.toFixed(0)}`

const fmtSpan = (ms: number) => {
  const m = Math.round(ms / MIN)
  if (m < 1) return ms > 0 ? '<1m' : '0m'
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

const fmtDate = (at: number, now: number, tz?: string) => {
  const year = (t: number) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', timeZone: tz })
  const older = year(at) < year(now)
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: older ? 'numeric' : undefined, timeZone: tz })
}

export function formatEntry(entry: HistoryEntry, now: number, tz?: string): { head: string; lines: string[] } {
  const title = entry.title.trim() || 'Untitled flow'
  const head = `${title} · ${entry.done}/${entry.total} · ${fmtCost(entry.cost)} · ${fmtDate(entry.endedAt, now, tz)}`
  const status = entry.status === 'finished' ? 'finished' : 'ended with the session'
  const lines = [`${entry.project} · ${fmtSpan(entry.time)} · ${fmtTokens(entry.tokens)} tokens · ${status}`]
  // The flow only counts done tasks, not which ones, so the first `done` in plan order are shown done.
  entry.tasks.forEach((t, i) => lines.push(`${i < entry.done ? '✓' : '○'} ${t.title} (${t.tier})`))
  return { head, lines }
}
