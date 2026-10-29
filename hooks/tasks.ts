// The flow's planned tasks and the runs that work on them: which run belongs to which task, which tasks wait on others
// (`after`, task numbers from 1) and which planned task can start now.
import type { AgentRun } from '../types'
import { isComplete } from './agent-state'

export type TaskLike = { title: string; after?: number[]; counted?: boolean }
export type RunLike = Pick<AgentRun, 'id' | 'description' | 'status'> & Partial<Pick<AgentRun, 'stepDone' | 'stepTotal'>>
/** A planned task with its number in plan order, and whether everything it waits for is done. */
export type Numbered<T> = T & { n: number; ready?: boolean }

export const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

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

// Which task each run works on, by run id (the task's index): a run whose description is the task's title.
export function linkRuns(tasks: TaskLike[], runs: RunLike[]): Map<string, number> {
  const byTitle = new Map<string, number>()
  tasks.forEach((t, i) => {
    const k = norm(t.title)
    if (!byTitle.has(k)) byTitle.set(k, i)
  })
  const links = new Map<string, number>()
  for (const a of runs) {
    const i = byTitle.get(norm(a.description))
    if (i !== undefined) links.set(a.id, i)
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
