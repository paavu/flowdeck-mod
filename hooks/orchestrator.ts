// The orchestrator's own work. A planned task no worker run belongs to is the orchestrator's (the main session's): it may
// keep a step list on it, as a worker does on its run (the `step` tool called from the main session, stored on the task
// as `items`), and `startedAt` dates when it started on it (its first `step` call, or its first own work call while the
// task was the one it is on, `ownTask`). The panel draws such a task as an Orchestrator row: running while its list has a
// step left (or, without a list, while it is the task the orchestrator is on), done once every step ended, accepted
// with `done` as `Accepted · Orchestrator`.
import type { AgentItem, OrchestratorSteps, Phase } from '../types'
import { itemsOf } from './agent-items'
import { isLive } from './agent-state'
import { isWorkCall } from './nudge'
import { linkRuns, unstarted } from './tasks'
import type { RunLike, TaskLike } from './tasks'

/** One Orchestrator row's state: its steps (none without a list), when it started and, once every step ended, when. */
export type Orch = { state: 'running' | 'done'; items: AgentItem[]; startedAt?: number; endedAt?: number }

// A held or saved task's step list (cleaned by agent-items.ts itemsOf: at most MAX_ITEMS) and start; nothing it lacks.
export function stepsOfTask(v: unknown): OrchestratorSteps {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const items = itemsOf(o.items)
  const isStart = typeof o.startedAt === 'number' && Number.isFinite(o.startedAt)
  return { ...(items.length ? { items } : {}), ...(isStart ? { startedAt: o.startedAt as number } : {}) }
}

// The phases in which the orchestrator works through the tasks: not while it plans or designs, nor once it closed.
const WORKING: readonly Phase[] = ['delegate', 'review']

// Main-session calls that hand work on or keep the books: never the orchestrator's own work on a task.
const NOT_OWN: ReadonlySet<string> = new Set(['Agent', 'Task', 'TaskCreate', 'TaskUpdate'])
/** A main-session call that is work the orchestrator does itself (an edit, a shell, …: nudge.ts `isWorkCall`). */
export const isOwnWork = (tool: string): boolean => isWorkCall(tool) && !NOT_OWN.has(tool)

const isOpenItem = (it: AgentItem): boolean => it.status === 'pending' || it.status === 'active'
const hasOpenList = (t: TaskLike): boolean => itemsOf(t.items).some(isOpenItem)

// The task a `step` call from the main session goes to, by index. `asked` (the call's `task`, from 1) names any task no
// worker run belongs to, accepted or not. Without it: the open task (not accepted, not completed in the session task
// list, no worker run) whose list still has a step left, else the lowest ready open task without a list, else the lowest
// ready open task. `error` says why no task takes the call.
export function stepTask(tasks: TaskLike[], runs: RunLike[], accepted: number[], asked?: unknown): { i: number } | { error: string } {
  if (asked !== undefined && asked !== null) {
    const n = typeof asked === 'number' && Number.isInteger(asked) ? asked : 0
    if (n < 1 || n > tasks.length) return { error: `the flow has no task ${typeof asked === 'number' ? asked : JSON.stringify(asked)}` }
    if (new Set(linkRuns(tasks, runs).values()).has(n - 1)) return { error: `task ${n} has a worker run; its worker reports its own steps` }
    return { i: n - 1 }
  }
  const open = unstarted(tasks, runs, accepted).filter(t => !t.counted)
  const pick = open.find(hasOpenList) ?? open.find(t => t.ready && !itemsOf(t.items).length) ?? open.find(t => t.ready)
  return pick ? { i: pick.n - 1 } : { error: 'no open task without a worker run is ready; name the task with task' }
}

// The open task the orchestrator is on without a step list, by index, or null: while the flow is in its delegate or
// review phase, no run is live, no worker's result waits for review (an ended run of a task not accepted) and no list
// of the orchestrator has a step left, it is the lowest ready open task without a list (not completed in the session
// task list). Its first own work call dates its start (register.tsx `stampOwnWork`).
export function ownTask(tasks: TaskLike[], runs: RunLike[], accepted: number[], phase: Phase): number | null {
  if (!WORKING.includes(phase) || runs.some(isLive)) return null
  const links = linkRuns(tasks, runs)
  if (runs.some(a => links.has(a.id) && !accepted.includes(links.get(a.id)! + 1))) return null
  const open = unstarted(tasks, runs, accepted)
  if (open.some(hasOpenList)) return null
  const next = open.find(t => t.ready && !t.counted && !itemsOf(t.items).length)
  return next ? next.n - 1 : null
}

// The Orchestrator rows the step lists of the open tasks (no worker run, not accepted) give, by task number: a list runs
// while a step is left and is done once every step ended. A saved flow (the archive) has these rows only, since it keeps
// no phase to tell which task the orchestrator was on without a list.
export function listed(tasks: TaskLike[], runs: RunLike[], accepted: number[]): Map<number, Orch> {
  const out = new Map<number, Orch>()
  for (const t of unstarted(tasks, runs, accepted)) {
    const items = itemsOf(t.items)
    if (!items.length) continue
    const isRunning = items.some(isOpenItem)
    const startedAt = t.startedAt ?? items.find(it => it.startedAt !== undefined)?.startedAt
    const ends = items.flatMap(it => (it.doneAt === undefined ? [] : [it.doneAt]))
    out.set(t.n, {
      state: isRunning ? 'running' : 'done',
      items,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(isRunning || !ends.length ? {} : { endedAt: Math.max(...ends) }),
    })
  }
  return out
}

// The Orchestrator rows of the open flow, by task number: the ones its lists give (`listed`), and the task the
// orchestrator is on without a list (`ownTask`), running from its start once one is dated.
export function orchestrated(tasks: TaskLike[], runs: RunLike[], accepted: number[], phase: Phase): Map<number, Orch> {
  const out = listed(tasks, runs, accepted)
  const i = ownTask(tasks, runs, accepted, phase)
  const startedAt = i === null ? undefined : tasks[i]?.startedAt
  if (i !== null && startedAt !== undefined) out.set(i + 1, { state: 'running', items: [], startedAt })
  return out
}
