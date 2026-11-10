// The untracked-work log: one record per main turn that ended with work calls made while task tracking was on and no
// flow was open, in `<project>/.claude/flowdeck/untracked-work.json` (the folder's `*` .gitignore keeps it out of git).
// The file is a JSON list, oldest first, the newest UNTRACKED_MAX kept: each write reads it again and writes the capped
// list back whole (the engine cannot remove a file). A file that cannot be read, or that holds no list, is never written.
import { dataDir, getFile, parseJson, writeData } from './archive-store'
import type { Io } from './archive-store'

export const UNTRACKED_FILE = 'untracked-work.json'
export const UNTRACKED_MAX = 200
export const UNTRACKED_TOOLS = 4

/** `day` local `YYYY-MM-DD`, `time` local 24-hour `HH:MM`; `calls` the turn's work calls, `tools` its most used. */
export type UntrackedTurn = { day: string; time: string; calls: number; tools: string[]; sentBack: boolean }

/** Strict mode's loop guard let a call through after `denied` refusals in a main turn: `strict` names the refusal (no
 * flow open, or a task without a step list), `tool` the call let through. Kept in the same file; asTurn does not count it. */
export type StrictPass = { day: string; time: string; strict: 'flow' | 'step'; tool: string; denied: number }

const path = (project: string): string => `${dataDir(project)}/${UNTRACKED_FILE}`

// One record as read; null for anything else (it is then left in the file as it is and not counted).
export function asTurn(v: unknown): UntrackedTurn | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.day !== 'string' || typeof o.time !== 'string' || typeof o.calls !== 'number' || typeof o.sentBack !== 'boolean') return null
  const tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === 'string') : []
  return { day: o.day, time: o.time, calls: o.calls, tools, sentBack: o.sentBack }
}

// The tools of a turn's tally, most used first (a tie keeps the order they were first used in), at most UNTRACKED_TOOLS.
export const toolsOf = (tally: ReadonlyMap<string, number>): string[] =>
  [...tally].sort((a, b) => b[1] - a[1]).slice(0, UNTRACKED_TOOLS).map(([tool]) => tool)

// The file's records; [] when it is missing, cannot be read or holds no list.
export async function readUntracked(io: Io, project: string): Promise<UntrackedTurn[]> {
  if (!project) return []
  const got = await getFile(io, path(project))
  const raw = got.state === 'ok' ? parseJson(got.text) : null
  return Array.isArray(raw) ? raw.flatMap(v => asTurn(v) ?? []) : []
}

// Appends `rec`, keeping the newest UNTRACKED_MAX; the records as written, or null when nothing was written.
export async function appendUntracked(io: Io, project: string, rec: UntrackedTurn | StrictPass): Promise<UntrackedTurn[] | null> {
  if (!project) return null
  const got = await getFile(io, path(project))
  if (got.state === 'unreadable') return null
  const raw = got.state === 'ok' ? parseJson(got.text) : []
  if (!Array.isArray(raw)) return null
  const list = [...raw, rec].slice(-UNTRACKED_MAX)
  return (await writeData(io, dataDir(project), UNTRACKED_FILE, list)) ? list.flatMap(v => asTurn(v) ?? []) : null
}

// The panel's line under the tabs: today's untracked turns, or null when there were none.
export function untrackedLine(days: readonly string[], day: string): string | null {
  const n = days.filter(d => d === day).length
  if (!n) return null
  return n === 1 ? '1 turn without a flow today' : `${n} turns without a flow today`
}
