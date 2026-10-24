export type Slice = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

export type Reading = {
  slices: Slice[]
  total: number // tokens in use
  window: number // the window measured against
  percent: number
  compactsAt?: number // where auto-compaction runs, when it is on
}

export type UsageWindow = {
  kind: 'five_hour' | 'seven_day'
  label: string
  percent: number
  resetsAt: number | null
  length: number
  expired?: boolean
}
export type Sample = { at: number; pct: number }
export type Samples = Record<string, Sample[]>

export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
  mirrored?: boolean
  counted?: boolean
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  isLinked: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type HistoryTask = { title: string; tier: string }

export type HistoryEntry = {
  id: string
  project: string
  title: string
  startedAt: number
  endedAt: number
  status: 'finished' | 'open'
  done: number
  total: number
  tasks: HistoryTask[]
  cost: number // USD
  tokens: number
  time: number // ms
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  isContextShown: boolean
  isUsageShown: boolean
  isBandHidden: boolean
  isHistoryShown: boolean
  openEntries: string[]
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'flowdeck': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      reading: Reading | null
      usage: { windows: UsageWindow[]; samples: Samples }
      now: number
      history: HistoryEntry[]
      flowMeta: { startedAt: number; project: string } | null
    }
  }
}
