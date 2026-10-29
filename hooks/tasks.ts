// The flow's planned tasks and the runs that work on them: which run belongs to which task, which tasks wait on others
// (`after`, task numbers from 1) and which planned task can start now.
import type { AgentRun } from '../types'
import { isComplete } from './agent-state'

export type TaskLike = { title: string; tier?: string; after?: number[]; counted?: boolean; mirrored?: boolean }
export type RunLike = Pick<AgentRun, 'id' | 'description' | 'status'> & Partial<Pick<AgentRun, 'stepDone' | 'stepTotal' | 'type' | 'startedAt'>>
/** A planned task with its number in plan order, and whether everything it waits for is done. */
export type Numbered<T> = T & { n: number; ready?: boolean }

export const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// A flowdeck worker's tier from its agent type (`flowdeck-careful`, or `flowdeck:flowdeck-careful` from the plugin);
// null for any other agent.
export const workerTier = (type: string): string | null => /^(?:[^:]*:)?flowdeck-(.+)$/.exec(type)?.[1]?.toLowerCase() ?? null

// A task number at the start of a description: `#3 …`, `[3] …` or `task 3 …`; `rest` is the description without it.
const TAG = /^\s*(?:#\s*(\d+)|\[\s*(\d+)\s*\]|task\s+(\d+)(?![\p{L}\p{N}]))[\s:.)\-–—]*/iu
export function taskTag(description: string): { n: number | null; rest: string } {
  const m = TAG.exec(description)
  if (!m) return { n: null, rest: description }
  const rest = description.slice(m[0].length)
  return { n: Number(m[1] ?? m[2] ?? m[3]), rest: rest.trim() ? rest : description }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'task', 'this', 'that'])
const words = (s: string): Set<string> => new Set(norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)))

// How well a description names a task, 0 to 1: one holds the other whole (as whole words, at least 4 letters), or the
// share of the shorter one's words they have in common.
export function titleScore(description: string, title: string): number {
  const d = norm(description)
  const t = norm(title)
  if (!d || !t) return 0
  const holds = (outer: string, inner: string) => inner.length >= 4 && ` ${outer} `.includes(` ${inner} `)
  if (holds(d, t) || holds(t, d)) return 1
  const a = words(description)
  const b = words(title)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size)
}

// The least share of words a description must have in common with a task's title to belong to it.
export const MATCH_SCORE = 0.6

// Every task's waits cleaned: whole numbers of tasks that exist, never itself, once each, and no wait that would close a
// cycle (a wait is kept only when the waited-for task does not already wait, directly or not, on this one).
export function cleanAfter<T extends TaskLike>(tasks: T[]): T[] {
  const kept: number[][] = tasks.map(() => [])
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>()
    const stack = [from]
    while (stack.length) {
      const at = stack.pop()!
      if (at === to) return true
      if (seen.has(at)) continue
      seen.add(at)
      stack.push(...(kept[at - 1] ?? []))
    }
    return false
  }
  tasks.forEach((t, i) => {
    for (const d of t.after ?? []) {
      const n = i + 1
      if (!Number.isInteger(d) || d < 1 || d > tasks.length || d === n || kept[i]!.includes(d) || reaches(d, n)) continue
      kept[i]!.push(d)
    }
  })
  return tasks.map((t, i) => (t.after === undefined && !kept[i]!.length ? t : { ...t, after: kept[i]! }))
}

// Which task each run works on, by run id (the task's index). The rules, in order; a run gets at most one task:
// 1. The description is the task's title, letter case and punctuation aside (the rule before all others).
// 2. A task number at the start of the description (`#3 …`, `[3] …`, `task 3 …`) names the task, if it exists; else
//    the description without it is tried as a title.
//    Rules 1 and 2 may give one task several runs: a return round reuses the task's description.
// 3. Otherwise the task whose title best matches the description (titleScore, at least MATCH_SCORE), among the tasks no
//    run has yet; on a tie the one of the worker's own tier wins, and a tie that stays links nothing.
// 4. Otherwise, for a flowdeck worker: when exactly one task of the worker's tier had no run yet when it started (a task
//    the session's task list mirrored or completed does not count), the worker is on that task.
// Runs are taken in the order they started; a run that matches nothing keeps its own row without a number.
export function linkRuns(tasks: TaskLike[], runs: RunLike[]): Map<string, number> {
  const byTitle = new Map<string, number>()
  tasks.forEach((t, i) => {
    const k = norm(t.title)
    if (!byTitle.has(k)) byTitle.set(k, i)
  })
  const order = runs.map((a, k) => ({ a, k })).sort((x, y) => (x.a.startedAt ?? 0) - (y.a.startedAt ?? 0) || x.k - y.k).map(x => x.a)
  const links = new Map<string, number>()
  const rest = new Map<string, string>()
  for (const a of order) {
    const tag = taskTag(a.description)
    rest.set(a.id, tag.rest)
    const exact = byTitle.get(norm(a.description))
    const i = exact ?? (tag.n !== null && tag.n >= 1 && tag.n <= tasks.length ? tag.n - 1 : byTitle.get(norm(tag.rest)))
    if (i !== undefined) links.set(a.id, i)
  }
  const claimed = (): Set<number> => new Set(links.values())
  const isOpen = (t: TaskLike, i: number, taken: Set<number>) => !taken.has(i) && !t.counted
  for (const a of order) {
    if (links.has(a.id)) continue
    const taken = claimed()
    const tier = workerTier(a.type ?? '')
    const scored = tasks
      .map((t, i) => ({ i, score: isOpen(t, i, taken) ? titleScore(rest.get(a.id) ?? a.description, t.title) : 0, same: tier !== null && t.tier === tier }))
      .filter(c => c.score >= MATCH_SCORE)
      .sort((x, y) => y.score - x.score || Number(y.same) - Number(x.same))
    const [best, next] = scored
    if (best && !(next && next.score === best.score && next.same === best.same)) links.set(a.id, best.i)
  }
  for (const a of order) {
    const tier = workerTier(a.type ?? '')
    if (links.has(a.id) || tier === null) continue
    // Only what was started by then counts: a task taken by a later run was still free when this one started.
    const taken = new Set(order.filter(b => b !== a && links.has(b.id) && (b.startedAt ?? 0) <= (a.startedAt ?? 0)).map(b => links.get(b.id)!))
    const free = tasks.flatMap((t, i) => (isOpen(t, i, taken) && !t.mirrored && t.tier === tier ? [i] : []))
    if (free.length === 1) links.set(a.id, free[0]!)
  }
  return links
}

// The task a run belongs to, numbered from 1, with its waits; null when it matches none.
export function taskOf(tasks: TaskLike[], links: Map<string, number>, a: RunLike): { n: number; after: number[] } | null {
  const i = links.get(a.id)
  const t = i === undefined ? undefined : tasks[i]
  return t && i !== undefined ? { n: i + 1, after: (t.after ?? []).filter(d => Number.isInteger(d) && d > 0) } : null
}

// A task is done when a run that belongs to it is complete, or the session task list completed it.
const doneTasks = (tasks: TaskLike[], runs: RunLike[], links: Map<string, number>): Set<number> => {
  const done = new Set<number>()
  tasks.forEach((t, i) => t.counted && done.add(i))
  for (const a of runs) {
    const i = links.get(a.id)
    if (i !== undefined && isComplete(a)) done.add(i)
  }
  return done
}

// The tasks no run was started for, numbered in plan order; `ready` when every task it waits for is done (a task that
// waits for nothing is ready too): those can be started now, in parallel.
export function unstarted<T extends TaskLike>(tasks: T[], runs: RunLike[]): Numbered<T>[] {
  const links = linkRuns(tasks, runs)
  const started = new Set(links.values())
  const done = doneTasks(tasks, runs, links)
  return tasks
    .map((t, i) => ({ ...t, n: i + 1, ready: (t.after ?? []).every(d => done.has(d - 1)) }))
    .filter((_, i) => !started.has(i))
}
