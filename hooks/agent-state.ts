// A subagent row's state on its progress line: the plan states' names and colours, the live tool after Running.
import type { AgentRun } from '../types'
import { STATE_COLOR } from './plan-view'

// flowdeck's own bookkeeping calls: they never become the tool word
export const HOUSEKEEPING: ReadonlySet<string> = new Set(['mcp__flowdeck__step', 'mcp__flowdeck__progress', 'mcp__flowdeck__plan'])

export type AgentState = { name: string; color: string }

type Shown = Pick<AgentRun, 'status'> & Partial<Pick<AgentRun, 'tool' | 'isAsked' | 'endedAt' | 'stepDone' | 'stepTotal'>>

// A live run has no end yet; one that is running with an end was saved in the archive while it still ran.
export const isRunningAtFinish = (a: Shown): boolean => a.status === 'running' && a.endedAt !== undefined

// A run that is still going: running with no end. A run restored from flow-live.json that was running when its session
// ended has an end and reads `Running at finish`: it no longer runs, holds up nothing and sits among the finished rows.
export const isLive = (a: Shown): boolean => a.status === 'running' && a.endedAt === undefined

// A run that ended OK with a step list it did not finish: Incomplete, never Done. Derived from the saved counts only, so
// old saved runs and held values read the same way.
export const isIncomplete = (a: Shown): boolean => a.status === 'done' && !!a.stepTotal && (a.stepDone ?? 0) < a.stepTotal

// Ended OK with no step list, or with every step done: the only run drawn Done, full and green.
export const isComplete = (a: Shown): boolean => a.status === 'done' && !isIncomplete(a)

// What the Archive collects: a complete run or a failed one; an Incomplete run stays in the live list.
export const isSettled = (a: Shown): boolean => a.status === 'failed' || isComplete(a)

// The row's `n/total`: a live run with an active step names that step's place (5 done of 7, the 6th active: `6/7`); any
// other run, or one with no active step, its done count. The bar stays the done fraction (progressOf).
export const stepCount = (a: Shown & Partial<Pick<AgentRun, 'stepNote'>>): string => {
  const total = a.stepTotal ?? 0
  const done = a.stepDone ?? 0
  return `${isLive(a) && a.stepNote ? Math.min(total, done + 1) : done}/${total}`
}

// The row's status mark: its status, or `incomplete` for a run that ended OK with steps left.
export const markOf = (a: Shown): AgentRun['status'] | 'incomplete' => (isIncomplete(a) ? 'incomplete' : a.status)

export const agentState = (a: Shown): AgentState => {
  if (isIncomplete(a)) return { name: 'Incomplete', color: STATE_COLOR.needs_input }
  if (a.status === 'done') return { name: 'Done', color: STATE_COLOR.done }
  if (a.status === 'failed') return { name: 'Error', color: STATE_COLOR.error }
  if (isRunningAtFinish(a)) return { name: 'Running at finish', color: STATE_COLOR.running }
  if (a.isAsked) return { name: 'Needs approval', color: STATE_COLOR.needs_input }
  return { name: 'Running', color: STATE_COLOR.running }
}

export const stateText = (a: Shown): string => {
  const { name } = agentState(a)
  return a.status === 'running' && !a.isAsked && a.tool && !isRunningAtFinish(a) ? `${name} · ${a.tool}` : name
}

// The task's own progress when the worker reports steps; only a complete run is full.
export const progressOf = (a: Shown): number | null => {
  if (isComplete(a)) return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

// A fitted line back into its coloured head and the rest; a line cut inside the head is all head.
export const splitHead = (line: string, head: string): [string, string] => [line.slice(0, head.length), line.slice(head.length)]
