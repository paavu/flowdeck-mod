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
  /** The task numbers (from 1) accepted after review, when `progress` named them; without it the first `done` tasks count as accepted. */
  accepted?: number[]
  /** When each accepted task was accepted, by task number; absent for tasks accepted before 1.0.0025. */
  acceptedAt?: Record<string, number>
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
  /** The task numbers (from 1) accepted after review, when the flow named them; without it the first `done` tasks count. */
  accepted?: number[]
  /** When each accepted task was accepted, by task number; without it the entry's `endedAt` stands in. */
  acceptedAt?: Record<string, number>
  cost: number // USD
  tokens: number
  time: number // ms
  /** The flow's runs at the end; absent in entries saved before runs were kept. */
  agents?: ArchiveAgent[]
  /** Saved while the flow runs, with only the runs archived so far; the flow's next full save replaces it. */
  partial?: boolean
  /** A finished plan's own entry (id `plan-<plan id>-<startedAt>-<project>`): the plan as it finished; no tasks or runs. */
  plan?: TaskPlan
}

/**
 * One saved session as `archive-index.json` (or `.trash/trash-index.json`) lists it: what the collapsed row draws, so the
 * list never reads a session file. The session itself is the file `file`, in `archive/` (or in `.trash/`).
 */
export type ArchiveRecord = {
  id: string
  file: string
  kind: 'flow' | 'plan'
  title: string
  startedAt: number
  /** The session's own end (a trashed one keeps it): the lists are ordered by it. */
  endedAt: number
  status: 'finished' | 'open'
  partial?: boolean
  /** The rows its group holds: its runs, or the tasks of a flow saved without runs, or a plan's steps. */
  itemCount: number
  taskCount: number
  cost: number // USD
  tokens: number
  time: number // ms
  size: number // the file's UTF-8 bytes
  /** The file was not in its folder when the index was last checked; the record is kept. */
  missing?: boolean
  /** When it went to the trash (archive-index) or when this trash copy was made (trash-index). */
  trashedAt?: number
  /** When it came back from the trash. */
  restoredAt?: number
  /** Trash-index only: the file's name in `archive/`. */
  originalFile?: string
  /** In memory only: a session only the shared store holds (no project folder, or the folder refused it). */
  source?: 'store'
}

/** The Archive and Trash tabs' lists, newest first by the session's end, and what the last read or save could not do. */
export type ArchiveLists = { records: ArchiveRecord[]; trash: ArchiveRecord[]; warnings: string[] }

/** One session's file read for an open group; at most 10 are held. */
export type ArchiveDetail = { list: 'archive' | 'trash'; id: string; state: 'loading' | 'ok' | 'error'; entry?: ArchiveEntry }

export type Panel = {
  isCompact: boolean
  isContextShown: boolean
  isUsageShown: boolean
  /** The usage reset lines say the time left (true) or the exact 24-hour time (false); one global choice, stored under the engine-store key `usageRemaining`. */
  isUsageRemaining: boolean
  isPlansShown: boolean
  isBandHidden: boolean
  /** Stored under the engine-store key `historyShown`, its name from before the rename. */
  isArchiveShown: boolean
  /** Archive groups the user opened (the first group shown is open by default), by session id, a Trash group's as `trash:<id>`; this session only. */
  openEntries: string[]
  /** Agent rows unfolded to show their items; this session only. */
  openAgents: string[]
  /** Archive and Trash groups the user folded, the default-open first one included; this session only. */
  closedEntries: string[]
  /** How many Archive rows are drawn (`Show more` adds a page); this session only. */
  archiveLimit: number
  /** How many Trash rows are drawn; this session only. */
  trashLimit: number
  /** The one move-to-trash or restore confirmation open, null when none; this session only. */
  confirm: { list: 'archive' | 'trash'; id: string } | null
  autoOpenedFor: string
  /** The list the panel's flowdeck group shows under its tabs; this session only. */
  tab: PanelTab
}

export type PanelTab = 'active' | 'finished' | 'plans' | 'archive' | 'trash'

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

/** WARM for an hour after the main thread's last request, then COLD. */
export type CacheMode = 'warm' | 'cold'

/**
 * The prompt cache as the band last saw it: when the main thread last sent a request (clock ms), the context the next
 * request re-sends (tokens), the model's context window, and the model (null when not known yet).
 */
export type CacheFacts = { lastAt: number; tokens: number; window: number; model: string | null }

/** Whether the cache card is open, remembered only for the mode it was chosen in. */
export type CacheFold = { mode: CacheMode; open: boolean }

declare module 'claude-code' {
  interface PluginState {
    'flowdeck': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      reading: Reading | null
      usage: { windows: UsageWindow[]; samples: Samples }
      now: number
      /** The Archive and Trash lists, from their indexes. */
      archiveLists: ArchiveLists
      /** The session files read for open groups, at most 10. */
      archiveDetails: ArchiveDetail[]
      flowMeta: { startedAt: number; project: string } | null
      plans: TaskPlan[]
      /** Why the band above the prompt last failed in this load (the panel's `band error` line), '' when it has not. */
      bandError: string
      /** The prompt cache's facts for this session, null until the main thread made a request (or a resume seeded them). */
      cache: CacheFacts | null
      /** The cache card's Show/Hide choice, for the mode it was made in; null for the default (warm folded, cold open). */
      cacheFold: CacheFold | null
      /** The cache texts the band last showed (`cacheKey`): the 5-second tick writes it when they change, so the band redraws once a minute at most. */
      cacheTick: string
    }
  }
}
