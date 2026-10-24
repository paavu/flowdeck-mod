// A subagent row's state on its progress line: the plan states' names and colours, the live tool after Running.
import type { AgentRun } from '../types'
import { STATE_COLOR } from './plan-view'

// flowdeck's own bookkeeping calls: they never become the tool word
export const HOUSEKEEPING: ReadonlySet<string> = new Set(['mcp__flowdeck__step', 'mcp__flowdeck__progress', 'mcp__flowdeck__plan'])

export type AgentState = { name: string; color: string }

type Shown = Pick<AgentRun, 'status'> & Partial<Pick<AgentRun, 'tool' | 'isAsked'>>

export const agentState = (a: Shown): AgentState => {
  if (a.status === 'done') return { name: 'Done', color: STATE_COLOR.done }
  if (a.status === 'failed') return { name: 'Error', color: STATE_COLOR.error }
  if (a.isAsked) return { name: 'Needs approval', color: STATE_COLOR.needs_input }
  return { name: 'Running', color: STATE_COLOR.running }
}

export const stateText = (a: Shown): string => {
  const { name } = agentState(a)
  return a.status === 'running' && !a.isAsked && a.tool ? `${name} · ${a.tool}` : name
}

// A fitted line back into its coloured head and the rest; a line cut inside the head is all head.
export const splitHead = (line: string, head: string): [string, string] => [line.slice(0, head.length), line.slice(head.length)]
