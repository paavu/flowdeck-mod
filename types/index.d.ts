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

/** One step of a worker's own list, sent through the `step` tool. */
export type AgentItemStatus = 'pending' | 'active' | 'done' | 'error'
export type AgentItem = { title: string; status: AgentItemStatus; startedAt?: number; doneAt?: number }

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
  /** The worker's own step list, when it sent one; the counts and the note above derive from it. */
  items?: AgentItem[]
  /** The tool the running agent called last, from its own tool calls; cleared when the run ends. */
  tool?: string
  /** True while a permission dialog for one of the agent's calls is up. */
  isAsked?: boolean
  /** A finished run moved into the archive from the live panel; it leaves the live Finished list but still counts in the flow's totals. */
  archived?: boolean
}

export type ArchiveTask = { title: string; tier: string; after?: number[] }

/** An agent run as it was when its flow was saved, without the live-only fields. */
export type ArchiveAgent = Omit<AgentRun, 'tool' | 'isAsked' | 'archived'>

export type ArchiveEntry = {
  id: string
  project: string
  title: string
  startedAt: number
  endedAt: number
  status: 'finished' | 'open'
  done: number
  total: number
  tasks: ArchiveTask[]
  cost: number // USD
  tokens: number
  time: number // ms
  /** The flow's runs at the end; absent in entries saved before runs were kept. */
  agents?: ArchiveAgent[]
  /** Saved while the flow runs, with only the runs archived so far; the flow's next full save replaces it. */
  partial?: boolean
}

/** One archive volume (a `history-<n>.json` file) in the volume index `history-index.json`: its entries summed up. */
export type ArchiveVolume = {
  file: string // `history-<n>.json`
  count: number
  from: number // earliest startedAt
  to: number // latest endedAt
  cost: number // USD
  tokens: number
  time: number // ms
  size: number // serialized UTF-8 bytes
  /** Each flow it holds as [startedAt, endedAt]; absent in an index written before 1.0.0007. */
  flows?: [number, number][]
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  isContextShown: boolean
  isUsageShown: boolean
  isPlansShown: boolean
  isBandHidden: boolean
  /** Stored under the engine-store key `historyShown`, its name from before the rename. */
  isArchiveShown: boolean
  openEntries: string[]
  /** Agent rows unfolded to show their items; this session only. */
  openAgents: string[]
  /** Archive groups whose finished list is open; this session only. */
  openFinished: string[]
  /** How many archive groups are shown; this session only. */
  archiveLimit: number
  /** The list of archive volumes is open; this session only. */
  archiveListOpen: boolean
  /** The volume file shown, null for the latest part (history.json); this session only. */
  archiveVolume: string | null
  /** The volume file that could not be loaded, '' when none; this session only. */
  archiveError: string
  /** Why the latest view shows only recovered entries ('' when history.json was read); this session only. */
  archiveWarning?: string
  autoOpenedFor: string
}

// The task plan, a model beside Flow for any task: stages of steps (ported from plan-progress 0.8.2).
export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
export type PlanSubstep = { title: string; status: StepStatus }
export type PlanStep = { title: string; status: StepStatus; substeps: PlanSubstep[]; doneAt?: number }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
export type TaskPlan = {
  id: string
  title: string
  kind: 'plan' | 'todo'
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  endedAt?: number | null
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
      archive: ArchiveEntry[]
      volumes: ArchiveVolume[]
      flowMeta: { startedAt: number; project: string } | null
      plans: TaskPlan[]
    }
  }
}
