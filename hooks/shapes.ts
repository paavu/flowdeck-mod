// The held values as the panel and the band read them. A reload keeps what an older flowdeck wrote, in its older shape,
// so every read goes through these: defaults fill what is missing, a field of the wrong kind falls back to its default,
// fields no longer used are dropped, and entries that are no entry at all are left out.
import type { AgentRun, AgentStatus, ArchiveDetail, ArchiveEntry, ArchiveLists, CacheFacts, CacheFold, Flow, LiveState, Panel, PanelTab, Phase, PlannedTask, Reading, Sample, Samples, UsageWindow } from '../types'
import { parseArchive, stampsOf } from './archive'
import { parseRecords } from './archive-index'

/** How many Archive or Trash rows are drawn at first; `Show more` adds as many. */
export const ARCHIVE_PAGE = 50

export const PANEL_DEFAULT: Panel = {
  isContextShown: true,
  isUsageShown: true,
  // The reset lines count down to the reset unless the user switched to the exact time (the store key `usageRemaining` wins at session start).
  isUsageRemaining: true,
  isPlansShown: true,
  isBandHidden: false,
  // Shown unless the user hid it (the store key `historyShown` wins at session start).
  isArchiveShown: true,
  openEntries: [],
  openAgents: [],
  closedEntries: [],
  archiveLimit: ARCHIVE_PAGE,
  trashLimit: ARCHIVE_PAGE,
  confirm: null,
  autoOpenedFor: '',
  tab: 'active',
}

const TABS: readonly PanelTab[] = ['active', 'finished', 'plans', 'archive', 'trash']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const text = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function asPanel(v: unknown): Panel {
  const o = isObj(v) ? v : {}
  const d = PANEL_DEFAULT
  // `isCompact` (the Collapse button, gone in 1.0.0029) is dropped like any field no longer used.
  return {
    isContextShown: bool(o.isContextShown, d.isContextShown),
    isUsageShown: bool(o.isUsageShown, d.isUsageShown),
    isUsageRemaining: bool(o.isUsageRemaining, d.isUsageRemaining),
    isPlansShown: bool(o.isPlansShown, d.isPlansShown),
    isBandHidden: bool(o.isBandHidden, d.isBandHidden),
    isArchiveShown: bool(o.isArchiveShown, d.isArchiveShown),
    openEntries: strings(o.openEntries),
    openAgents: strings(o.openAgents),
    closedEntries: strings(o.closedEntries),
    // A page is never smaller than the default (a panel held from before 1.0.0025 had 10).
    archiveLimit: Math.max(ARCHIVE_PAGE, num(o.archiveLimit) ?? d.archiveLimit),
    trashLimit: Math.max(ARCHIVE_PAGE, num(o.trashLimit) ?? d.trashLimit),
    confirm: isObj(o.confirm) && (o.confirm.list === 'archive' || o.confirm.list === 'trash') && typeof o.confirm.id === 'string' ? { list: o.confirm.list, id: o.confirm.id } : null,
    autoOpenedFor: text(o.autoOpenedFor, d.autoOpenedFor),
    tab: TABS.includes(o.tab as PanelTab) ? (o.tab as PanelTab) : d.tab,
  }
}

const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']

const asTask = (t: unknown): PlannedTask[] => {
  if (!isObj(t) || typeof t.title !== 'string') return []
  const task: PlannedTask = { title: t.title, tier: text(t.tier, ''), after: Array.isArray(t.after) ? t.after.filter((n): n is number => Number.isInteger(n) && n > 0) : [] }
  if (typeof t.mirrored === 'boolean') task.mirrored = t.mirrored
  if (typeof t.counted === 'boolean') task.counted = t.counted
  return [task]
}

export function asFlow(v: unknown): Flow | null {
  if (!isObj(v)) return null
  return {
    title: text(v.title, 'flowdeck'),
    total: num(v.total) ?? 0,
    done: num(v.done) ?? 0,
    running: num(v.running) ?? 0,
    phase: PHASES.includes(v.phase as Phase) ? (v.phase as Phase) : 'plan',
    isFinished: bool(v.isFinished, false),
    isLinked: bool(v.isLinked, false),
    tasks: (Array.isArray(v.tasks) ? v.tasks : []).flatMap(asTask),
    ...(Array.isArray(v.accepted) ? { accepted: v.accepted.filter((n): n is number => Number.isInteger(n) && n > 0) } : {}),
    ...(stampsOf(v.acceptedAt) ? { acceptedAt: stampsOf(v.acceptedAt) } : {}),
  }
}

const STATUSES: readonly AgentStatus[] = ['running', 'done', 'failed']
const OPTIONAL_TEXT = ['agentId', 'effort', 'stepNote', 'tool'] as const
const OPTIONAL_NUM = ['endedAt', 'stepDone', 'stepTotal'] as const
const OPTIONAL_BOOL = ['isAsked', 'archived'] as const

// One run, or null when it has no id, status or start: the rows can draw nothing of it. Other fields it may carry stay.
export function asAgent(v: unknown): AgentRun | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id || !STATUSES.includes(v.status as AgentStatus) || num(v.startedAt) === undefined) return null
  const a = {
    ...v,
    type: text(v.type, ''),
    description: text(v.description, ''),
    model: text(v.model, ''),
    contextTokens: num(v.contextTokens) ?? 0,
    contextMax: num(v.contextMax) ?? 0,
    tokens: num(v.tokens) ?? 0,
    costUsd: num(v.costUsd) ?? 0,
    steps: num(v.steps) ?? 0,
    round: num(v.round) ?? 1,
  } as AgentRun & Obj
  for (const k of OPTIONAL_TEXT) if (a[k] !== undefined && typeof a[k] !== 'string') delete a[k]
  for (const k of OPTIONAL_NUM) if (a[k] !== undefined && num(a[k]) === undefined) delete a[k]
  for (const k of OPTIONAL_BOOL) if (a[k] !== undefined && typeof a[k] !== 'boolean') delete a[k]
  if (a.items !== undefined && !Array.isArray(a.items)) delete a.items
  return a
}

export const asAgents = (v: unknown): AgentRun[] =>
  (Array.isArray(v) ? v : []).flatMap(x => {
    const a = asAgent(x)
    return a ? [a] : []
  })

const ENTRY_NUMS = ['startedAt', 'endedAt', 'done', 'total', 'cost', 'tokens', 'time'] as const

// An entry as the archive writes it passes as it is; anything else goes through the archive's own parser (which may drop
// it). An entry with a plan always does, so the plan it draws is checked.
const isEntry = (e: unknown): e is ArchiveEntry =>
  isObj(e) &&
  e.plan === undefined &&
  typeof e.id === 'string' &&
  !!e.id &&
  typeof e.project === 'string' &&
  typeof e.title === 'string' &&
  (e.status === 'finished' || e.status === 'open') &&
  Array.isArray(e.tasks) &&
  (e.agents === undefined || Array.isArray(e.agents)) &&
  (e.accepted === undefined || (Array.isArray(e.accepted) && e.accepted.every(n => Number.isInteger(n) && n > 0))) &&
  e.acceptedAt === undefined &&
  ENTRY_NUMS.every(k => num(e[k]) !== undefined)

export const asArchive = (v: unknown): ArchiveEntry[] => (Array.isArray(v) ? v.flatMap(e => (isEntry(e) ? [e] : parseArchive([e]))) : [])

export const asLists = (v: unknown): ArchiveLists => {
  const o = isObj(v) ? v : {}
  return { records: parseRecords(o.records), trash: parseRecords(o.trash), warnings: strings(o.warnings) }
}

// The session files held for open groups; one that is no detail is left out, an entry that does not parse reads as an error.
export const asDetails = (v: unknown): ArchiveDetail[] =>
  (Array.isArray(v) ? v : []).flatMap((d): ArchiveDetail[] => {
    if (!isObj(d) || (d.list !== 'archive' && d.list !== 'trash') || typeof d.id !== 'string') return []
    const state = d.state === 'loading' || d.state === 'ok' ? d.state : 'error'
    if (state !== 'ok') return [{ list: d.list, id: d.id, state }]
    const entry = asArchive([d.entry])[0]
    return entry ? [{ list: d.list, id: d.id, state, entry }] : [{ list: d.list, id: d.id, state: 'error' }]
  })

const KINDS = ['five_hour', 'seven_day'] as const

const asWindow = (w: unknown): UsageWindow[] =>
  isObj(w) && KINDS.includes(w.kind as (typeof KINDS)[number]) && typeof w.label === 'string' && num(w.percent) !== undefined && num(w.length) !== undefined
    ? [{ ...(w as UsageWindow), resetsAt: num(w.resetsAt) ?? null }]
    : []

const asSamples = (v: unknown): Samples => {
  const out: Samples = {}
  if (!isObj(v)) return out
  for (const [k, list] of Object.entries(v)) {
    out[k] = (Array.isArray(list) ? list : []).filter((s): s is Sample => isObj(s) && num(s.at) !== undefined && num(s.pct) !== undefined)
  }
  return out
}

export const asUsage = (v: unknown): { windows: UsageWindow[]; samples: Samples } => {
  const o = isObj(v) ? v : {}
  return { windows: (Array.isArray(o.windows) ? o.windows : []).flatMap(asWindow), samples: asSamples(o.samples) }
}

const SLICE_KINDS = ['used', 'free', 'buffer']

export function asReading(v: unknown): Reading | null {
  if (!isObj(v) || !Array.isArray(v.slices)) return null
  const total = num(v.total)
  const window = num(v.window)
  const percent = num(v.percent)
  if (total === undefined || window === undefined || percent === undefined) return null
  const slices = v.slices.filter(
    (s): s is Reading['slices'][number] => isObj(s) && typeof s.name === 'string' && num(s.tokens) !== undefined && typeof s.color === 'string' && SLICE_KINDS.includes(s.kind as string),
  )
  const r: Reading = { slices, total, window, percent }
  const at = num(v.compactsAt)
  if (at !== undefined) r.compactsAt = at
  return r
}

export const asMeta = (v: unknown): { startedAt: number; project: string } | null =>
  isObj(v) && num(v.startedAt) !== undefined && typeof v.project === 'string' ? { startedAt: v.startedAt as number, project: v.project } : null

export const asNow = (v: unknown): number => num(v) ?? 0

// The prompt cache's facts: null without a request time; a size or window of the wrong kind reads as 0, a model as unknown.
export const asCacheFacts = (v: unknown): CacheFacts | null => {
  if (!isObj(v)) return null
  const lastAt = num(v.lastAt)
  if (lastAt === undefined) return null
  return { lastAt, tokens: Math.max(0, num(v.tokens) ?? 0), window: Math.max(0, num(v.window) ?? 0), model: typeof v.model === 'string' && v.model ? v.model : null }
}

// The cache card's open-or-folded choice (the chevron beside the chip); anything else is no choice (the mode's default).
export const asCacheFold = (v: unknown): CacheFold | null =>
  isObj(v) && (v.mode === 'warm' || v.mode === 'cold') && typeof v.open === 'boolean' ? { mode: v.mode, open: v.open } : null

export const asCacheTick = (v: unknown): string => text(v, '')

export const LIVE_DEFAULT: LiveState = { owner: '', activityAt: 0, key: '', writtenAt: 0 }

// The flow's own bookkeeping for flow-live.json; a value held from before 1.0.0028 (none) reads as the default.
export const asLive = (v: unknown): LiveState => {
  const o = isObj(v) ? v : {}
  return { owner: text(o.owner, ''), activityAt: Math.max(0, num(o.activityAt) ?? 0), key: text(o.key, ''), writtenAt: Math.max(0, num(o.writtenAt) ?? 0) }
}
