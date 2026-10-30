import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRun, ArchiveDetail, ArchiveEntry, ArchiveLists, ArchiveRecord, Flow, Panel, PanelTab, Phase, PlannedTask, PlanStage, Reading, Samples, TaskPlan, UsageWindow } from '../types'
import { derive, finishItems, hasItemOps, ITEM_H, itemAlt, itemLine, itemsOf, itemSvg, noteSvg, stepItems, timedItems } from './agent-items'
import type { StepInput } from './agent-items'
import { agentState, HOUSEKEEPING, isComplete, isIncomplete, isLive, isSettled, markOf, progressOf, splitHead, stateText, stepCount } from './agent-state'
import { contextRows, contextSvg, toReading } from './context'
import { isWorthKeeping, keyOf, planEntry, snapshot, VOLUME_MAX } from './archive'
import { INDEX_FILE, parseIndexFile, recordOf, TRASH_DIR, TRASH_INDEX } from './archive-index'
import { dataDir, emptyTrash, getFile, listing, loadArchive, parseJson, readSession, restoreSession, saveSession, saveToStore, trashSession, writeData } from './archive-store'
import type { Emptied, Io, Moved } from './archive-store'
import { archiveSection, groupKey, isGroupOpen } from './archive-view'
import type { ArchiveWords, FlowDrawing, FlowView, Planned } from './archive-view'
import { foldGlyph } from './fold'
import { sortNewest } from './order'
import { doneText } from './time'
import { importPlan, isFinished, isStoredStep, normalize, percent, PLAN_ID, placeBar, planId, str, where } from './plan'
import { planBandSvg, planBandText, planRows, planSvg, STATE_COLOR, stateLabel } from './plan-view'
import { acceptedOf, acceptedOnly, allTasksDone, cleanAfter, linkRuns, norm, shortTitle, taskOf, taskTag, unstarted, workerTier } from './tasks'
import type { TaskLike } from './tasks'
import { ARCHIVE_PAGE, asAgents, asCacheFacts, asCacheFold, asCacheTick, asDetails, asFlow, asKeepWarm, asLists, asLive, asMeta, asNow, asPanel, asReading, asUsage, LIVE_DEFAULT, PANEL_DEFAULT } from './shapes'
import { changeLive, endRuns, IDLE_FINISH_MS, isGone, LIVE_BEAT_MS, LIVE_STALE_MS, liveKey, readLive, without } from './live'
import type { LiveRecord } from './live'
import { VERSION } from './version'
import { live, record, resetKey, resets, toWindows, usageRows, usageSvg } from './usage'
import { cacheKey, isCardOpen, isRenewDue, isShowable, KEEP_WARM_DEFAULT, measured, remeasured, renewalEnded, seeded, stamped, toggledFold, userSpoke, viewOf } from './cache'
import type { CacheFacts, KeepWarm } from './cache'
import { cacheDrawing } from './cache-view'
import type { CacheDrawing, CacheUi } from './cache-view'

const flow = atom({ plugin: 'flowdeck', key: 'flow' } as const, null)
const agents = atom({ plugin: 'flowdeck', key: 'agents' } as const, [])
const panel = atom({ plugin: 'flowdeck', key: 'panel' } as const, PANEL_DEFAULT)
const usageState = atom({ plugin: 'flowdeck', key: 'usage' } as const, { windows: [] as UsageWindow[], samples: {} as Samples })
const reading = atom({ plugin: 'flowdeck', key: 'reading' } as const, null as Reading | null)
const now = atom({ plugin: 'flowdeck', key: 'now' } as const, 0)
// The Archive and Trash lists, from their indexes; the session files read for open groups (at most DETAILS_MAX).
const archiveLists = atom({ plugin: 'flowdeck', key: 'archiveLists' } as const, { records: [], trash: [], warnings: [] } as ArchiveLists)
const archiveDetails = atom({ plugin: 'flowdeck', key: 'archiveDetails' } as const, [] as ArchiveDetail[])
const flowMeta = atom({ plugin: 'flowdeck', key: 'flowMeta' } as const, null as { startedAt: number; project: string } | null)
const plans = atom({ plugin: 'flowdeck', key: 'plans' } as const, [] as TaskPlan[])
// Why the band above the prompt last failed in this load, '' when it has not; the panel shows it, the band never reads it.
const bandError = atom({ plugin: 'flowdeck', key: 'bandError' } as const, '')
// The prompt cache (cache.ts): its facts, the card's open-or-folded choice, and the texts last shown (the band's minute tick).
const cacheFacts = atom({ plugin: 'flowdeck', key: 'cache' } as const, null as CacheFacts | null)
const cacheFold = atom({ plugin: 'flowdeck', key: 'cacheFold' } as const, null)
const cacheTick = atom({ plugin: 'flowdeck', key: 'cacheTick' } as const, '')
// Keep warm's bookkeeping (cache.ts `keepStatus`): the main turn running, the user's last message, renewals, failures.
const keepWarm = atom({ plugin: 'flowdeck', key: 'keepWarm' } as const, KEEP_WARM_DEFAULT)
// The shown flow's owner session and activity (flow-live.json), and what reading or writing that file could not do.
const liveState = atom({ plugin: 'flowdeck', key: 'live' } as const, LIVE_DEFAULT)
const liveError = atom({ plugin: 'flowdeck', key: 'liveError' } as const, '')

// A reload keeps the held values an older flowdeck wrote, in its older shape: every read goes through its normalizer
// (shapes.ts), and every update hands its change the normalized value. A change that returns that value unchanged hands
// the stored one back, so it writes as little as it did before.
const readPanel = async ($: EngineInterface): Promise<Panel> => asPanel(await read($, panel))
const updatePanel = async ($: EngineInterface, change: (p: Panel) => Panel): Promise<Panel> =>
  asPanel(await update($, panel, prev => {
    const was = asPanel(prev)
    const next = change(was)
    return next === was ? prev : next
  }))
const readFlow = async ($: EngineInterface): Promise<Flow | null> => asFlow(await read($, flow))
const updateFlow = async ($: EngineInterface, change: (f: Flow | null) => Flow | null): Promise<Flow | null> =>
  asFlow(await update($, flow, prev => {
    const was = asFlow(prev)
    const next = change(was)
    return next === was ? prev : next
  }))
const readAgents = async ($: EngineInterface): Promise<AgentRun[]> => asAgents(await read($, agents))
const updateAgents = async ($: EngineInterface, change: (list: AgentRun[]) => AgentRun[]): Promise<AgentRun[]> =>
  asAgents(await update($, agents, prev => {
    const was = asAgents(prev)
    const next = change(was)
    return next === was ? prev : next
  }))
const readPlans = async ($: EngineInterface): Promise<TaskPlan[]> => asPlans(await read($, plans))
const updatePlans = async ($: EngineInterface, change: (list: TaskPlan[]) => TaskPlan[]): Promise<TaskPlan[]> =>
  asPlans(await update($, plans, prev => change(asPlans(prev))))
const readMeta = async ($: EngineInterface): Promise<Meta | null> => asMeta(await read($, flowMeta))
const updateMeta = async ($: EngineInterface, change: (m: Meta | null) => Meta | null): Promise<Meta | null> =>
  asMeta(await update($, flowMeta, prev => {
    const was = asMeta(prev)
    const next = change(was)
    return next === was ? prev : next
  }))
const readLists = async ($: EngineInterface): Promise<ArchiveLists> => asLists(await read($, archiveLists))
const readDetails = async ($: EngineInterface): Promise<ArchiveDetail[]> => asDetails(await read($, archiveDetails))
const updateDetails = async ($: EngineInterface, change: (list: ArchiveDetail[]) => ArchiveDetail[]): Promise<ArchiveDetail[]> =>
  asDetails(await update($, archiveDetails, prev => change(asDetails(prev))))
const readUsage = async ($: EngineInterface) => asUsage(await read($, usageState))
const readReading = async ($: EngineInterface): Promise<Reading | null> => asReading(await read($, reading))
const readNow = async ($: EngineInterface): Promise<number> => asNow(await read($, now))
const readLiveState = async ($: EngineInterface) => asLive(await read($, liveState))
const readCache = async ($: EngineInterface): Promise<CacheFacts | null> => asCacheFacts(await read($, cacheFacts))
const updateCache = async ($: EngineInterface, change: (c: CacheFacts | null) => CacheFacts | null): Promise<void> => {
  await update($, cacheFacts, prev => change(asCacheFacts(prev)))
}
const readKeepWarm = async ($: EngineInterface): Promise<KeepWarm> => asKeepWarm(await read($, keepWarm))
const updateKeepWarm = async ($: EngineInterface, change: (k: KeepWarm) => KeepWarm): Promise<void> => {
  await update($, keepWarm, prev => {
    const was = asKeepWarm(prev)
    const next = change(was)
    return next === was ? prev : next
  })
}

const TOOL = 'mcp__flowdeck__progress'
const STEP_TOOL = 'mcp__flowdeck__step'
const PLAN_TOOL = 'mcp__flowdeck__plan'
const TICK_MS = 5000
const PLAN_RULE = `# Progress plans
A task needing more than ~3 edits or commands gets a plan via ${PLAN_TOOL}: create it once with the full breakdown (2-7 stages of steps {title}, or kind: "todo" for one flat list; titles of at most 4 words, in the user's language; one id per task; the first open step becomes active). Move it with short calls: {id, next:true}, {id, done:["A"], active:"B"}, {id, failed:"B", note}, {id, state:"needs_input", note} before asking the user, {id, state:"done"} to finish. When the plan changes, resend stages under the same id. The tasks themselves always go to ${TOOL} (the flow rule), never into a second plan of the same work. No edit is ever blocked for lack of a plan.`
// Every task goes through flowdeck: this rule is in every session's system prompt, so the mod alone sets it.
const FLOW_RULE = `# flowdeck flows
Every task goes through flowdeck: report it with ${TOOL} (load it with ToolSearch \`select:${TOOL}\` when it is deferred; a flowdeck worker reports only its own steps, with ${STEP_TOOL}). Send the plan once: title, \`tasks\` [{title, tier, after}] numbered from 1 (tasks that edit the same files are chained with \`after\`; independent ones get none), phase "delegate". Add each new task with \`add\`; send \`done: [numbers]\` as tasks are accepted. Begin every worker's Agent description with \`#<n> <title>\`. Never leave a task unreported. A flow finishes by itself once every task is done and no worker runs; send \`finished: true\` only when the user asks to end it.`
const PANE = 'flowdeck-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  /** The accepted count, or the numbers (from 1) of the tasks accepted. */
  done?: number | number[]
  phase?: Phase
  finished?: boolean
  restart?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
  add?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: {
    pane: 'flowdeck',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'flowdeck panel opened.',
    closed: 'flowdeck panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
    ready: 'ready',
    acceptedRow: 'Accepted',
    noRun: 'no worker run',
    acceptedTag: 'accepted',
    nothingQueued: 'Nothing running or queued',
    noFinished: 'No finished items yet',
    started: 'started',
    noSteps: 'No steps reported yet',
    noPlans: 'No plans',
    untitled: 'Untitled',
    noArchive: 'no archive yet',
    trashEmpty: 'Trash is empty',
    loading: 'loading…',
    couldNotRead: 'could not read',
    fileMissing: 'file missing',
    showMore: 'Show more ({n})',
    trashAsk: 'Move this session to the trash?',
    trashTell: 'It leaves the Archive and shows in the Trash tab, where Restore brings it back. Its file is copied to .claude/flowdeck/.trash/; nothing is erased.',
    moveToTrash: 'Move to trash',
    restoreAsk: 'Move back to the Archive?',
    restoreTell: 'It leaves the Trash and shows in the Archive again, in its place by when it ended.',
    restore: 'Restore',
    cancel: 'Cancel',
    trashFailed: 'could not move it to the trash',
    restoreFailed: 'could not restore it',
    emptyTrash: 'Empty Trash ({n})',
    emptyAsk: 'Erase {n} sessions for good? This cannot be undone.',
    emptyAskOne: 'Erase 1 session for good? This cannot be undone.',
    erase: 'Erase',
    emptied: '{n} sessions erased, {m} failed',
    emptiedOne: '1 session erased, {m} failed',
    emptyFailed: 'could not empty the trash',
  },
  ru: {
    pane: 'flowdeck',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель flowdeck открыта.',
    closed: 'Панель flowdeck закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    ready: 'можно начать',
    acceptedRow: 'Принята',
    noRun: 'без запуска исполнителя',
    acceptedTag: 'принята',
    nothingQueued: 'Ничего не выполняется и не ждёт запуска',
    noFinished: 'Завершённых пока нет',
    started: 'начат',
    noSteps: 'Шагов пока нет',
    noPlans: 'Планов нет',
    untitled: 'Без названия',
    noArchive: 'архив пока пуст',
    trashEmpty: 'Корзина пуста',
    loading: 'загрузка…',
    couldNotRead: 'не удалось прочитать',
    fileMissing: 'файл не найден',
    showMore: 'Показать ещё ({n})',
    trashAsk: 'Переместить эту сессию в корзину?',
    trashTell: 'Она уйдёт из Архива во вкладку Trash, откуда её вернёт кнопка Восстановить. Её файл копируется в .claude/flowdeck/.trash/; ничего не стирается.',
    moveToTrash: 'В корзину',
    restoreAsk: 'Вернуть в Архив?',
    restoreTell: 'Она уйдёт из Корзины и снова появится в Архиве, на своём месте по времени завершения.',
    restore: 'Восстановить',
    cancel: 'Отмена',
    trashFailed: 'не удалось переместить в корзину',
    restoreFailed: 'не удалось восстановить',
    emptyTrash: 'Очистить корзину ({n})',
    emptyAsk: 'Стереть навсегда сессии: {n}? Это нельзя отменить.',
    emptyAskOne: 'Стереть навсегда сессии: 1? Это нельзя отменить.',
    erase: 'Стереть',
    emptied: 'стёрто сессий: {n}, не удалось: {m}',
    emptiedOne: 'стёрто сессий: 1, не удалось: {m}',
    emptyFailed: 'не удалось очистить корзину',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]
// The session's working folder, the project an archive entry names; set the same way.
let project = ''
// The session the task plans and the flow's record are saved under; empty when the engine names none.
let sessionId = ''
// The session's transcript file, when classic.SessionStart named it (kept in the flow's record).
let transcript = ''
// The session that ended here (session.end): its record is not written again until a new session is adopted.
let endedSession = ''
// When the records of other sessions that may still run are looked at again (0: none left).
let sweepAt = 0
// When the tick last did the lifecycle's share (tickLive).
let liveTickAt = 0

// The engine's current session id, '' when it cannot say; a /clear changes it without a new session.start.
const currentSessionId = async ($: EngineInterface): Promise<string> => {
  const id: unknown = await Promise.resolve()
    .then(() => $.session.id())
    .catch(() => '')
  return typeof id === 'string' ? id : ''
}

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

const blank = (): Flow => ({
  title: 'flowdeck',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  isLinked: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (!prev.isLinked && input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: (t.tier ?? '').replace(/^flowdeck-/, '').trim().toLowerCase(),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
    }))

const unionTasks = (kept: PlannedTask[], incoming: PlannedTask[]): PlannedTask[] => {
  const byTitle = new Map(incoming.map(t => [t.title.toLowerCase(), t]))
  const old = kept.map(t => {
    const next = byTitle.get(t.title.toLowerCase())
    return next ? { ...t, tier: next.tier || t.tier, after: next.after } : t
  })
  const have = new Set(kept.map(t => t.title.toLowerCase()))
  return [...old, ...incoming.filter(t => !have.has(t.title.toLowerCase()))]
}

// `at` dates the tasks this call accepts (none without a clock).
const merge = (prev: Flow | null, input: ProgressInput, at: number | null = null): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const incoming = cleanTasks(input.tasks)
  // A linked flow never loses a task: a re-plan updates the tasks it names and adds the new ones.
  const planned = !incoming ? base.tasks : base.isLinked ? unionTasks(base.tasks, incoming) : incoming
  const known = new Set(planned.map(t => t.title.toLowerCase()))
  const fresh = (cleanTasks(input.add) ?? []).filter(t => !known.has(t.title.toLowerCase()) && known.add(t.title.toLowerCase()))
  // Waits on unknown tasks, on the task itself or closing a cycle are dropped.
  const tasks = cleanAfter([...planned, ...fresh])
  const asked = Math.max(0, Math.round(input.total ?? (fresh.length && !input.tasks ? base.total + fresh.length : input.tasks ? tasks.length : base.total)))
  const total = base.isLinked ? Math.max(asked, tasks.length) : asked
  // Task numbers name which tasks were accepted, on top of those accepted before (a count before it means the first ones);
  // a bare count still works and leaves the named list as it is.
  const named = Array.isArray(input.done) ? input.done.filter(n => Number.isInteger(n) && n >= 1 && n <= tasks.length) : null
  const before = acceptedOf({ ...base, tasks })
  const accepted = named ? [...new Set([...before, ...named])].sort((a, b) => a - b) : base.accepted
  const isNew = named && at !== null ? named.filter(n => !before.includes(n)) : []
  const acceptedAt = isNew.length ? { ...base.acceptedAt, ...Object.fromEntries(isNew.map(n => [String(n), at as number])) } : base.acceptedAt
  const count = named ? accepted?.length ?? 0 : typeof input.done === 'number' && Number.isFinite(input.done) ? input.done : base.done
  const done = Math.min(total || Infinity, Math.max(0, Math.round(count)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    ...(accepted ? { accepted } : {}),
    ...(acceptedAt ? { acceptedAt } : {}),
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    isLinked: true,
    tasks,
  }
}

// `isAt` (the band): while a task runs, X is where the flow is, the running task's number (done + 1, at most the total);
// idle, the done count. The bar, percent and colour still say what is done.
const label = (f: Flow, isAt = false): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const x = isAt && f.running > 0 ? Math.min(f.total, f.done + 1) : f.done
  const count = f.total ? `${x}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const MAX_BAND_W = 1600 // the widest the desktop band's drawing gets
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// The band's title when no task names where the flow is: never the flow's own title (named after the first request).
const BAND_LABEL = 'FlowDeck'

const rowSvg = (f: Flow, W: number, isWorking: boolean, name: string): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(name, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f, true)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each flowdeck tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, string> = {
  fable: 'Fable · high',
  heavy: 'Opus · xhigh',
  careful: 'Opus · high',
  medium: 'Opus · medium',
  light: 'Opus · low',
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

// A worker's type is `flowdeck-careful`, or `flowdeck:flowdeck-careful` when the agents ship in the plugin.
const isWorker = (type: string): boolean => workerTier(type) !== null

const tierOf = (type: string): string => {
  const t = workerTier(type)
  return t && t in TIER_COLOR ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => (!f || f.isFinished ? [] : unstarted(f.tasks ?? [], list, acceptedOf(f)))

// Where a row sits in a finished list (order.ts): when it finished, then when it started. A run without an end sits
// last; an accepted task without a time sits at `fallback` (an archive entry's end), else last.
const runPlace = (a: AgentRun) => ({ end: a.endedAt ?? 0, start: a.startedAt, id: a.id })
const acceptedPlace = (pl: Planned) => ({ end: pl.doneAt ?? 0, start: pl.doneAt ?? 0, id: `accepted-${pl.n}` })
const finishedFirst = (list: AgentRun[]): AgentRun[] => sortNewest(list, runPlace)

// One flow's rows as the panel draws and counts them, live or from the archive.
const rowsOf = (tasks: TaskLike[], list: AgentRun[], accepted: number[], acceptedAt?: Record<string, number>, fallback?: number) => {
  const links = linkRuns(tasks, list)
  return {
    links,
    // An accepted task no run belongs to is an Accepted row of its own, placed by when it was accepted.
    acceptedRows: acceptedOnly(tasks, links, accepted).map((t): Planned => {
      const doneAt = acceptedAt?.[String(t.n)] ?? fallback
      return { title: t.title, tier: t.tier ?? '', after: t.after ?? [], n: t.n, ...(doneAt === undefined ? {} : { doneAt }) }
    }),
    running: list.filter(isLive).reverse(),
    // Archived rows leave the finished list; the totals and the planned tasks still count them. A run that was going when
    // its session ended (`Running at finish`) is among the finished rows.
    finished: finishedFirst(list.filter(a => !isLive(a) && !a.archived)),
    archivedCount: list.filter(a => !isLive(a) && a.archived).length,
  }
}

// The live flow's numbers from the rows its lists draw, the one source of the tab counts and the band's X/Y and bar:
// Active = running runs + queued tasks; Finished = finished runs not archived + Accepted rows; done = the finished rows
// that are complete (a Done run or an Accepted row; Incomplete and failed ones are not); total = every row (archived
// runs stay counted, as finished, so archiving never moves the band back). `hasRows` is false for a flow with no row
// at all, which keeps the orchestrator's own total and accepted count (a fresh plan without tasks).
const flowProgress = (f: Flow | null, list: AgentRun[]) => {
  const r = rowsOf(f?.tasks ?? [], list, f ? acceptedOf(f) : [])
  const archived = list.filter(a => !isLive(a) && a.archived)
  const active = r.running.length + plannedOf(f, list).length
  const finished = r.finished.length + r.acceptedRows.length
  const done = [...r.finished, ...archived].filter(isComplete).length + r.acceptedRows.length
  const total = active + finished + archived.length
  return { active, finished, done, total, running: r.running.length, hasRows: total > 0 }
}

const flowCounts = (f: Flow | null, list: AgentRun[]): { active: number; finished: number } => {
  const { active, finished } = flowProgress(f, list)
  return { active, finished }
}

// The band's title, where the flow is: the running task (its task's title, else the run's description without its `#n`;
// with several running, the lowest-numbered one and ` +N` for the others), else the next ready task (else the next
// queued one), else `FlowDeck`. Never the flow's own title.
const bandTitle = (f: Flow, list: AgentRun[]): string => {
  if (f.isFinished) return BAND_LABEL
  const tasks = f.tasks ?? []
  const links = linkRuns(tasks, list)
  const running = list
    .filter(isLive)
    .map(a => {
      const t = taskOf(tasks, links, a)
      return { n: t?.n ?? Infinity, at: a.startedAt, title: ((t && tasks[t.n - 1]?.title) || taskTag(a.description || '').rest).trim() }
    })
    .filter(r => r.title)
    .sort((x, y) => x.n - y.n || x.at - y.at)
  if (running.length) return `${running[0]!.title}${running.length > 1 ? ` +${running.length - 1}` : ''}`
  const queued = plannedOf(f, list)
  return (queued.find(p => p.ready) ?? queued[0])?.title.trim() || BAND_LABEL
}

// The flow as the band draws it (label, bar, percent, ticks): its done/total/running from flowProgress.
const shownFlow = (f: Flow, list: AgentRun[]): Flow => {
  const g = flowProgress(f, list)
  return g.hasRows ? { ...f, done: g.done, total: g.total, running: g.running } : f
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  // Ended OK with steps left: a half-filled amber ring, never the tick.
  if (status === 'incomplete') return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${STATE_COLOR.needs_input}" stroke-width="1.4"/><path d="M${x} ${y - 5}a5 5 0 0 0 0 10z" fill="${STATE_COLOR.needs_input}"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// A plan row's alt text in the band; the band's handler has its own `percent`.
const planAlt = (pl: TaskPlan): string => `${pl.title}: ${stateLabel(pl)}, ${percent(pl, where(pl))}%`

// The flow's header: the three tiles only. The flow's title is never shown in the panel (it is named after the first request).
const HEADER_H = 44
const headerSvg = (W: number, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 6
  const tw = (W - gap * 2) / 3
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(W, HEADER_H, `${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`)
}

// The archive icon: one single-width glyph, never an emoji.
const ARCHIVE_ICON = '⤓'
// The usage reset switch: a clock face, single width and without an emoji form (U+23F1 draws as an emoji in some fonts).
const RESET_ICON = '◷'

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// The longest form of the stats that fits `room`: the time goes first, then the tokens, then the cost; ctx stays last.
const fitStats = (a: AgentRun, at: number, gap: string, room: number, width: (s: string) => number): string => {
  const ctx = `ctx ${ctxOf(a)}%`
  const tokens = `${ctx} · ${fmtTokens(a.contextTokens)}`
  const cost = `≈${fmtCost(a.costUsd)}`
  const forms = [`${tokens}${gap}${cost}${gap}${fmtTime(elapsed(a, at))}`, `${tokens}${gap}${cost}`, `${ctx}${gap}${cost}`, ctx]
  return forms.find(f => width(f) <= room) ?? ''
}

// The desktop row draws the task name natively above the drawing (`titleOutside`): the drawing then
// drops its title line, everything moves up by that line and the crab is centred on what is left.
const AGENT_H = 66
const TITLE_LINE = 18
const agentHeight = (titleOutside = false): number => AGENT_H - (titleOutside ? TITLE_LINE : 0)

// What a task waits for, as its meta line says it: `after 2, 3`.
const afterText = (after: number[] | undefined): string => (after?.length ? `${tr().after} ${after.join(', ')}` : '')

// The state words of a row: an Incomplete run of an accepted task says both, the acceptance never hides the open steps.
const headOf = (a: AgentRun, isAccepted = false): string => (isAccepted && isIncomplete(a) ? `${stateText(a)} · ${tr().acceptedTag}` : stateText(a))

// `after` is the run's task's waits; it follows the effort on the meta line and is the first thing dropped when the
// line is short: it never takes room from the stats.
const agentSvg = (W: number, a: AgentRun, at: number, opts: { titleOutside?: boolean; after?: number[]; isAccepted?: boolean } = {}): string => {
  const out = opts.titleOutside === true
  const dy = out ? TITLE_LINE : 0
  const s = tr()
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
  const tail: string[] = []
  if (a.round > 1) tail.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') tail.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const tierWord = tier === 'other' ? a.type : tier
  const metaW = (m: string[]) => textWidth(`${tierWord}  ${m.join('  ·  ')}`, 11)
  // The stats share the model line, right-aligned; the meta keeps its room first.
  const bare = [model, ...tail]
  const stats = fitStats(a, at, '  ', barW - metaW(bare) - 12, t => textWidth(t, 11))
  const waits = afterText(opts.after)
  const withWaits = [model, waits, ...tail]
  const meta = waits && metaW(withWaits) + (stats ? textWidth(stats, 11) + 12 : 0) <= barW ? withWaits : bare
  const steps = a.stepTotal ? `${stepCount(a)}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = barW
  // The state leads the line in its colour; the reported steps follow it.
  const state = agentState(a)
  const head = headOf(a, opts.isAccepted)
  const [lead, rest] = splitHead(fitText(steps ? `${head} · ${steps}` : head, 11, stepsW), head)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  const H = agentHeight(out)
  return svg(
    W,
    H,
    `${crab(0, out ? 10 : 14, costumeOf(a.type), false, a.status === 'running')}
${out ? '' : `<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>`}
<text x="42" y="${34 - dy}" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tierWord)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${stats ? `<text class="s" x="${42 + barW}" y="${34 - dy}" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>` : ''}
${stepsW > 30 ? `<text x="42" y="${49 - dy}" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums"><tspan fill="${state.color}">${xml(lead)}</tspan>${rest ? `<tspan class="t">${xml(rest)}</tspan>` : ''}</text>` : ''}
<rect class="k" x="42" y="${55 - dy}" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="${55 - dy}" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${state.color}"`}/>
${statusMark(W - 8, out ? 12 : 16, markOf(a), color)}
<line class="ln" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>`,
  )
}

// The native task name starts at the drawing's text column (x 42): the fold chevron at the far left (in the crab's column),
// at its own width, then an empty drawing of the rest of the 42 px. A Box's `width` counts character cells (about 8-9 px
// each on the desktop), not pixels, so no Box sizes this line: 1.0.0025's 18-cell chevron slot pushed every name about
// 160 px in. CHEVRON_W is the desktop's plain one-glyph Button as measured on a screenshot (about 20 px).
const TITLE_INDENT = 42
const CHEVRON_W = 20
const INDENT_W = TITLE_INDENT - CHEVRON_W
const INDENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${INDENT_W}" height="1" viewBox="0 0 ${INDENT_W} 1"/>`

// A planned row: the tier and its model, what it waits for, and `ready` once that is done (the wait goes first when short).
const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const ready = p.ready ? tr().ready : ''
  const line = (m: string[]) => `${tier}  ${m.filter(Boolean).join('  ·  ')}${ready ? `  ·  ${ready}` : ''}`
  const full = [TIER_MODEL[tier] ?? '', afterText(p.after)]
  const meta = textWidth(line(full), 11) <= textW ? full : [TIER_MODEL[tier] ?? '']
  const readyW = ready ? textWidth(`  ·  ${ready}`, 11) : 0
  const metaText = fitText(meta.filter(Boolean).join('  ·  '), 11, Math.max(0, textW - textWidth(`${tier}  `, 11) - readyW))
  return svg(
    W,
    46,
    `${crab(0, 6, tier, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(metaText)}</tspan>${ready ? `<tspan class="m">  ·  </tspan><tspan fill="${STATE_COLOR.running}" font-weight="600">${xml(ready)}</tspan>` : ''}</text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

// An accepted task no worker run belongs to: its number and title, its tier, `Accepted · no worker run` in green and the
// tick; no step bar and no archive icon.
const ACCEPTED_H = 46
const acceptedSvg = (W: number, p: Planned, done = ''): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const textW = W - 42 - 22
  const word = `${tr().acceptedRow} · ${tr().noRun}`
  // When it was accepted, dim at the right of the title line; the title gives way to it.
  const doneW = done ? textWidth(done, 11) + 10 : 0
  return svg(
    W,
    ACCEPTED_H,
    `${crab(0, 6, tier, true)}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, Math.max(0, textW - doneW)))}</text>
${done ? `<text class="s" x="${42 + textW}" y="18" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(done)}</text>` : ''}
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${colorOf(tier)}">${xml(tier)}</tspan><tspan fill="${STATE_COLOR.done}">  ${xml(fitText(word, 11, Math.max(0, textW - textWidth(`${tier}  `, 11))))}</tspan></text>
${statusMark(W - 8, 16, 'done', colorOf(tier))}
<line class="ln" x1="0" y1="${ACCEPTED_H - 0.5}" x2="${W}" y2="${ACCEPTED_H - 0.5}"/>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', incomplete: '◐', planned: '◷' }
// The terminal glyph's colour: green tick, red cross, amber half ring, else the tier colour.
const glyphColor = (a: AgentRun, tierColor: string): string => {
  const mark = markOf(a)
  return mark === 'failed' ? 'red' : mark === 'done' ? 'green' : mark === 'incomplete' ? STATE_COLOR.needs_input : tierColor
}

// Asks the engine for /context's breakdown (estimated locally, no token-count calls) and the rate-limit windows, in one call.
// It answers the context's size, which the prompt cache's facts take after a main turn.
async function refreshContext($: EngineInterface): Promise<{ tokens?: number; window?: number }> {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  if (b && b.rawMaxTokens > 0) await update($, reading, () => toReading(b)) // otherwise there is no window to measure against
  const windows = toWindows(Array.isArray(u.rateLimits) ? u.rateLimits : [])
  const at = await $.clock.now()
  await update($, usageState, prev => ({ windows, samples: record(asUsage(prev).samples, windows, at) }))
  return u.context
}

type TodoItem = { title: string; completed: boolean }

// A linked flow takes the session task list's items as planned tasks (medium tier, display only) and counts one done when the list completes it.
// With no open flow, a list with an item still to do starts one, named after its first item: every task goes through flowdeck.
async function mirrorTasks($: EngineInterface, items: TodoItem[]): Promise<void> {
  if (!items.length) return
  const shown = await readFlow($)
  if ((!shown || shown.isFinished) && items.some(i => !i.completed)) await startFlow($, shown, items[0]!.title)
  const at = await clockAt($)
  await updateFlow($, prev => {
    if (!prev || !prev.isLinked || prev.isFinished) return prev
    const tasks = [...prev.tasks]
    // A flow that names its accepted tasks names the completed items too.
    const accepted = prev.accepted ? [...prev.accepted] : undefined
    let total = prev.total
    let done = prev.done
    for (const item of items) {
      const at = tasks.findIndex(t => t.title.toLowerCase() === item.title.toLowerCase())
      if (at < 0) {
        tasks.push({ title: item.title, tier: 'medium', after: [], mirrored: true, counted: item.completed })
        total++
        if (item.completed) {
          done++
          accepted?.push(tasks.length)
        }
      } else if (tasks[at]!.mirrored && item.completed && !tasks[at]!.counted) {
        tasks[at] = { ...tasks[at]!, counted: true }
        done++
        accepted?.push(at + 1)
      }
    }
    // The items completed now are dated now, as tasks accepted through `progress` are.
    const added = accepted && at !== null ? accepted.filter(n => !(prev.accepted ?? []).includes(n)) : []
    const acceptedAt = added.length ? { ...prev.acceptedAt, ...Object.fromEntries(added.map(n => [String(n), at as number])) } : prev.acceptedAt
    return { ...prev, tasks, total, done: Math.min(total, done), ...(accepted ? { accepted } : {}), ...(acceptedAt ? { acceptedAt } : {}) }
  })
}

const todoItems = (todos: unknown): TodoItem[] =>
  (Array.isArray(todos) ? todos : []).flatMap(t => {
    const title = typeof t?.content === 'string' ? t.content.trim() : ''
    return title ? [{ title, completed: t.status === 'completed' }] : []
  })

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await readPanel($)
  if (p.autoOpenedFor === key) return
  await updatePanel($, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

// The engine calls archive-store.ts makes (the plans' files use them too): `$` itself never crosses an import.
const io = ($: EngineInterface): Io => ({
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  stat: path => $.fs.stat(path),
  list: dir => $.fs.list(dir),
  exists: path => $.fs.exists(path),
  storeGet: () => $.store.get('history'), // the store key keeps its name from before the rename
  storeSet: value => $.store.set('history', value),
  statReal: path => $.fs.stat(path, { resolve: true }),
  run: (argv, env) => $.process.run(argv, env ? { env, timeoutMs: 15_000 } : { timeoutMs: 15_000 }),
})

// The clock, or null when it cannot be read.
const clockAt = async ($: EngineInterface): Promise<number | null> => {
  const at: unknown = await Promise.resolve()
    .then(() => $.clock.now())
    .catch(() => null)
  return typeof at === 'number' ? at : null
}

const clockOr = async ($: EngineInterface, d: number): Promise<number> => {
  const at: unknown = await Promise.resolve()
    .then(() => $.clock.now())
    .catch(() => d)
  return typeof at === 'number' ? at : d
}

// At most this many session files are held for open groups; opening one more folds the one opened longest ago.
const DETAILS_MAX = 10

// One session's file held for its open group, the newest kept last; past DETAILS_MAX the oldest is let go and its group
// folded, so a group shown open always has its file or is being read.
async function holdDetail($: EngineInterface, d: ArchiveDetail): Promise<void> {
  let dropped: ArchiveDetail[] = []
  await updateDetails($, prev => {
    const rest = prev.filter(x => !(x.list === d.list && x.id === d.id))
    const next = [...rest, d]
    dropped = next.slice(0, Math.max(0, next.length - DETAILS_MAX))
    return next.slice(-DETAILS_MAX)
  })
  if (dropped.length) {
    const keys = dropped.map(x => groupKey(x.list, x.id))
    await updatePanel($, prev => ({ ...prev, openEntries: prev.openEntries.filter(k => !keys.includes(k)), closedEntries: [...prev.closedEntries.filter(k => !keys.includes(k)), ...keys] }))
  }
}

const dropDetail = ($: EngineInterface, list: 'archive' | 'trash', id: string) => updateDetails($, prev => prev.filter(x => !(x.list === list && x.id === id)))

// Reads one session's file for its open group, unless it is held or being read: `loading…` meanwhile, then the entry or
// `could not read`. Never throws.
async function loadDetail($: EngineInterface, list: 'archive' | 'trash', rec: ArchiveRecord): Promise<void> {
  try {
    const held = (await readDetails($)).find(x => x.list === list && x.id === rec.id)
    if (held && held.state !== 'error') return
    await holdDetail($, { list, id: rec.id, state: 'loading' })
    const entry = await readSession(io($), project, list, rec).catch(() => null)
    await holdDetail($, entry ? { list, id: rec.id, state: 'ok', entry } : { list, id: rec.id, state: 'error' })
  } catch {
    // A failing store leaves the group saying loading; the next press reads it again.
  }
}

// The open groups of both lists whose files are not held yet are read: the first group of each list is open unless
// folded. Called whenever the lists change.
async function loadOpenDetails($: EngineInterface): Promise<void> {
  const lists = await readLists($)
  const p = await readPanel($)
  for (const [list, records] of [['archive', lists.records], ['trash', lists.trash]] as const) {
    const shown = records.slice(0, list === 'archive' ? p.archiveLimit : p.trashLimit)
    for (const [i, rec] of shown.entries()) if (isGroupOpen(p, list, rec.id, i)) await loadDetail($, list, rec)
  }
}

// The lists as a load, save or move left them; a held file of a session that changed is let go (read again when open).
async function showLists($: EngineInterface, lists: ArchiveLists, saved?: ArchiveEntry): Promise<void> {
  const before = await readLists($)
  await update($, archiveLists, () => lists)
  const changed = (list: 'archive' | 'trash', recs: ArchiveRecord[], old: ArchiveRecord[]) =>
    recs.filter(r => {
      const o = old.find(x => x.id === r.id)
      return !o || o.endedAt !== r.endedAt || o.file !== r.file
    }).map(r => `${list}\n${r.id}`)
  const stale = new Set([...changed('archive', lists.records, before.records), ...changed('trash', lists.trash, before.trash)])
  await updateDetails($, prev => prev.filter(d => !stale.has(`${d.list}\n${d.id}`)))
  // The entry just saved is in memory already: its group, when open, needs no read.
  const at = saved ? lists.records.findIndex(r => r.id === saved.id) : -1
  if (saved && at >= 0 && isGroupOpen(await readPanel($), 'archive', saved.id, at)) await holdDetail($, { list: 'archive', id: saved.id, state: 'ok', entry: saved })
  await loadOpenDetails($)
}

// Without a project folder, or when the project files cannot take it, the save goes to the shared store as before. True
// when the entry was kept somewhere: its session file or the shared store.
async function saveArchive($: EngineInterface, entry: ArchiveEntry): Promise<boolean> {
  if (!isWorthKeeping(entry)) return false
  const now = await clockOr($, entry.endedAt)
  let note = ''
  if (project) {
    const saved = await saveSession(io($), project, entry, now).catch(() => null)
    if (saved?.isSaved && saved.lists) {
      await showLists($, saved.lists, entry)
      return true
    }
    if (saved?.isTooBig) note = `"${entry.title || entry.id}" is over 3,900,000 bytes and was not saved to the project folder`
  }
  const isKept = await saveToStore(io($), entry).catch(() => false)
  // One kept nowhere still shows for this session, and says so.
  if (!isKept) note = `could not save "${entry.title || entry.id}" anywhere; it shows for this session only`
  const lists = await readLists($)
  const records = [...lists.records.filter(r => r.id !== entry.id), storeRecordOf(entry)]
  await showLists($, { ...lists, records: sortRecords(records), warnings: note ? [...lists.warnings.filter(w => w !== note), note] : lists.warnings }, entry)
  return isKept
}

const storeRecordOf = (e: ArchiveEntry): ArchiveRecord => ({ ...recordOf(e, '', 0), source: 'store' })
const sortRecords = (records: ArchiveRecord[]): ArchiveRecord[] => sortNewest(records, r => ({ end: r.endedAt, start: r.startedAt, id: r.id }))

// Moves a session to the trash or back, after its confirmation; the lists show the result, and a failure is said above
// them. Never throws into the press.
async function moveSession($: EngineInterface, to: 'trash' | 'archive', id: string): Promise<void> {
  try {
    await updatePanel($, prev => ({ ...prev, confirm: null }))
    const now = await clockOr($, Date.now())
    const moved: Moved = to === 'trash' ? await trashSession(io($), project, id, now) : await restoreSession(io($), project, id, now)
    const failed = moved.ok ? [] : [`${to === 'trash' ? tr().trashFailed : tr().restoreFailed}: ${moved.error ?? ''}`]
    if (moved.lists) await showLists($, { ...moved.lists, warnings: [...moved.lists.warnings, ...failed] })
    else if (failed.length) await update($, archiveLists, prev => ({ ...asLists(prev), warnings: [...asLists(prev).warnings, ...failed] }))
    await dropDetail($, to === 'trash' ? 'archive' : 'trash', id)
  } catch {
    // A failing store leaves both lists as they are.
  }
}

// Empty Trash, after its confirmation: the trashed sessions erased (archive-store.ts `emptyTrash`); `n sessions erased,
// m failed` is said above the list when any session is left. Never throws into the press.
async function emptyTrashPress($: EngineInterface): Promise<void> {
  try {
    await updatePanel($, prev => ({ ...prev, confirm: null }))
    const now = await clockOr($, Date.now())
    const done: Emptied = await emptyTrash(io($), project, now).catch((): Emptied => ({ ok: false, erased: 0, failed: 0, error: 'the erase stopped' }))
    const s = tr()
    const counts = (done.erased === 1 ? s.emptiedOne : s.emptied).replace('{n}', String(done.erased)).replace('{m}', String(done.failed))
    const said = done.ok ? [] : [done.failed || done.erased ? counts : '', done.error ? `${s.emptyFailed}: ${done.error}` : ''].filter(Boolean)
    if (done.lists) await showLists($, { ...done.lists, warnings: [...done.lists.warnings, ...said] })
    else if (said.length) await update($, archiveLists, prev => ({ ...asLists(prev), warnings: [...asLists(prev).warnings, ...said] }))
    await updateDetails($, prev => prev.filter(d => d.list !== 'trash'))
  } catch {
    // A failing store leaves both lists as they are.
  }
}

// The archive saves and moves, one after another.
const queueArchive = <T,>(run: () => Promise<T>): Promise<T> => {
  const next = archiving.then(run)
  archiving = next.catch(() => {})
  return next
}

// The archive presses, one after another; a flow's own record waits for the one under way, so a partial entry never
// lands after the flow's full one.
let archiving: Promise<unknown> = Promise.resolve()

// The finished rows of the flow that can still be archived, latest completion first as the live Finished list shows
// them: rows that began before the flow belong to the flow before it. An Incomplete row is not finished work: it stays,
// and a press on a newer row passes over it.
const archivable = (list: AgentRun[], meta: Meta | null): AgentRun[] =>
  finishedFirst(list.filter(a => isSettled(a) && !a.archived && (!meta || a.startedAt >= meta.startedAt)))

// Archives the row and every finished row not archived yet that completed before it (by completion time, whatever the
// order of the presses): the open flow's entry is saved with all its archived rows (`partial`), and only once it was
// kept do they leave the live list. Never throws into the press.
async function archiveRows($: EngineInterface, id: string): Promise<void> {
  try {
    const f = await readFlow($)
    if (!f || f.isFinished) return
    const list = await readAgents($)
    const endedAt = await $.clock.now()
    let meta = await readMeta($)
    if (!meta) {
      // As recordFlow starts one, but from the first run's start, so the flow's later records keep these rows.
      const fresh = { startedAt: Math.min(endedAt, ...list.map(a => a.startedAt)), project }
      meta = (await updateMeta($, m => m ?? fresh)) ?? fresh
    }
    const shown = archivable(list, meta)
    const at = shown.findIndex(a => a.id === id)
    if (at < 0) return
    const ids = new Set(shown.slice(at).map(a => a.id))
    const start = meta.startedAt
    const rows = list.filter(a => a.status !== 'running' && a.startedAt >= start && (a.archived || ids.has(a.id)))
    const entry: ArchiveEntry = { ...snapshot({ flow: f, agents: rows, project: meta.project, startedAt: start, endedAt, status: 'open' }), partial: true }
    if (!(await saveArchive($, entry))) return
    await updateAgents($, l => l.map(a => (ids.has(a.id) && a.status !== 'running' ? { ...a, archived: true } : a)))
  } catch {
    // A failing clock or store leaves the rows where they are.
  }
}

const pressArchive = ($: EngineInterface, id: string): Promise<unknown> => {
  const run = archiving.then(() => archiveRows($, id))
  archiving = run.catch(() => {})
  return run
}

// The finished plans kept in the archive this session, so one is saved again only once it changed (reopened and done again).
const archivedPlans = new Set<string>()
const planKey = (p: TaskPlan): string => `${p.id}\n${p.startedAt}\n${p.endedAt ?? ''}`

// Every place a plan becomes done calls this: the plan is saved as its own Archive entry, after the archive saves under
// way, on the flows' path; saving it again replaces the entry. True when it was kept. Never throws into the tool call,
// the turn or the press.
function archivePlan($: EngineInterface, plan: TaskPlan): Promise<boolean> {
  if (plan.state !== 'done') return Promise.resolve(false)
  if (archivedPlans.has(planKey(plan))) return Promise.resolve(true)
  const run = archiving.then(async () => {
    try {
      const isKept = await saveArchive($, planEntry(plan, project, await $.clock.now()))
      if (isKept) archivedPlans.add(planKey(plan))
      return isKept
    } catch {
      return false
    }
  })
  archiving = run.catch(() => {})
  return run
}

type Meta = { startedAt: number; project: string }
const isSameMeta = (a: Meta | null, b: Meta | null): boolean => !!a && !!b && a.startedAt === b.startedAt && a.project === b.project

// Saves the flow as it stands, or as `at` captured it (its record's meta and agents); returns the meta the record used, null
// when it could not be saved. `end` dates it (its last activity), else the clock. Never throws into the tool call or the
// turn that asked.
async function recordFlow($: EngineInterface, f: Flow, status: 'finished' | 'open', at?: { meta: Meta | null; agents: AgentRun[] }, end?: number): Promise<Meta | null> {
  try {
    await archiving
    const endedAt = end ?? (await $.clock.now())
    let meta = at ? at.meta : await readMeta($)
    const isFresh = !meta
    if (!meta) {
      // A flow no progress call created (a worker launch): it starts its record now, under one id from here on.
      const fresh = { startedAt: endedAt, project }
      meta = fresh
      await updateMeta($, m => m ?? fresh)
    }
    const start = meta.startedAt
    // Only the agents that began during this flow: one still running from the flow before is counted there.
    const list = (at ? at.agents : await readAgents($)).filter(a => isFresh || a.startedAt >= start)
    await saveArchive($, snapshot({ flow: f, agents: list, project: meta.project, startedAt: meta.startedAt, endedAt, status }))
    return meta
  } catch {
    // A failing store or clock costs the record, not the call.
    return null
  }
}

// Ends the flow with the input's last fields: one finished record, then whatever comes next starts a new one. The flow's
// meta and agents are taken first, so a restart meanwhile neither renames this record nor loses the new flow's meta; a
// second finish (the turn's end and the tool at once) finds the flow finished and records nothing. `end` dates the record
// (an idle flow: its last activity), else the clock.
async function finishFlow($: EngineInterface, input: ProgressInput = {}, end?: number): Promise<Flow | null> {
  const meta = await readMeta($)
  const list = await readAgents($)
  const at = await clockAt($)
  let isEnding = false
  const next = await updateFlow($, p => {
    isEnding = !p?.isFinished
    return isEnding ? merge(p, { ...input, finished: true }, at) : p
  })
  if (next && isEnding) {
    const used = (await recordFlow($, next, 'finished', { meta, agents: list }, end)) ?? meta
    await updateMeta($, m => (isSameMeta(m, used) ? null : m))
  }
  return next
}

// A new flow takes the panel's place: the open one goes to the archive first (a finished one is there already), the new
// one starts its record now under this session, the finished runs leave the list (running ones stay) and the band comes
// back. The caller then sets the new flow.
async function beginFlow($: EngineInterface, prev: Flow | null): Promise<void> {
  if (prev && !prev.isFinished) await recordFlow($, prev, 'finished')
  // Without a clock the record starts when the flow is saved, as for a flow no progress call created.
  const startedAt = await clockAt($)
  await update($, flowMeta, () => (startedAt === null ? null : { startedAt, project }))
  await updateAgents($, list => list.filter(isLive))
  await update($, liveState, l => ({ ...asLive(l), owner: sessionId }))
  await updatePanel($, p => (p.isBandHidden ? { ...p, isBandHidden: false } : p))
}

// Every task goes through flowdeck: with no open flow, a task list or a worker start opens one by itself, named after the
// first task or the worker's description, in the delegate phase (the work is underway).
async function startFlow($: EngineInterface, prev: Flow | null, name: string): Promise<void> {
  await beginFlow($, prev)
  const at = await clockAt($)
  // One opened meanwhile (two calls at once) is kept.
  await updateFlow($, p => (p && !p.isFinished ? p : merge(null, { title: shortTitle(taskTag(name).rest) || 'flowdeck', phase: 'delegate' }, at)))
}

type SavedPlans = Record<string, TaskPlan[]>

const isStoredStage = (s: unknown): s is PlanStage =>
  !!s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string' && Array.isArray((s as { steps?: unknown }).steps) && (s as { steps: unknown[] }).steps.every(isStoredStep)

// The stored plans by session; anything that is not an object of plan arrays reads as empty.
// A broken stage is dropped; a plan left with none of the stages it had is dropped too.
function parsePlans(v: unknown): SavedPlans {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: SavedPlans = {}
  for (const [sid, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const valid = list.flatMap((p): TaskPlan[] => {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.stages) || typeof p.startedAt !== 'number') return []
      const stages = (p.stages as unknown[]).filter(isStoredStage)
      return stages.length || !p.stages.length ? [{ ...(p as TaskPlan), stages }] : []
    })
    if (valid.length) out[sid] = valid
  }
  return out
}

// The held plans list, validated as the stored plans are; a plan without a title gets an empty one.
const asPlans = (v: unknown): TaskPlan[] =>
  (Array.isArray(v) ? (parsePlans({ list: v }).list ?? []) : []).map(p => (typeof p.title === 'string' ? p : { ...p, title: '' }))

const isPlansObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// This session's plans set in; every other session's entry stays exactly as it was, one that does not parse too. None is
// ever dropped for age: only this session's own key goes when its list is empty.
const mergePlans = (all: Record<string, unknown>, list: TaskPlan[]): Record<string, unknown> => {
  const next = { ...all }
  if (list.length) next[sessionId] = list
  else delete next[sessionId]
  return next
}

// A session's own plans file, when plans.json cannot take its plans: `plans-extra-<session id>.json`, the id's letters,
// digits and '-' as they are and any other character as `_` and its four hex digits, so two sessions never share a name.
const plansSide = (sid: string): string => `plans-extra-${sid.replace(/[^A-Za-z0-9-]/g, c => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}.json`

// The session whose plans live in their side file: from then on only that file is written for it, so it is the newest copy.
let plansAside = ''

// plans.json takes this session's plans when it is missing or reads as an object of sessions and stays under the limit; one
// that cannot be read, does not parse, may be there or would pass the limit is never written. The plans then go to the
// session's side file, never over one that cannot be read or parsed. False when neither could take them.
async function savePlansToProject($: EngineInterface, list: TaskPlan[]): Promise<boolean> {
  const dir = dataDir(project)
  if (plansAside !== sessionId) {
    const got = await getFile(io($), `${dir}/plans.json`)
    const raw = got.state === 'ok' ? parseJson(got.text) : got.state === 'missing' ? {} : undefined
    if (isPlansObject(raw) && (await writeData(io($), dir, 'plans.json', mergePlans(raw, list), VOLUME_MAX))) return true
  }
  const file = plansSide(sessionId)
  const side = await getFile(io($), `${dir}/${file}`)
  if (side.state === 'unreadable' || (side.state === 'ok' && !Array.isArray(parseJson(side.text)))) return false
  if (!(await writeData(io($), dir, file, list, VOLUME_MAX))) return false
  plansAside = sessionId
  return true
}

// This session's saved plans: its side file (the newest copy when there is one), else its entry in plans.json, else the store's.
async function loadPlans($: EngineInterface): Promise<TaskPlan[]> {
  plansAside = ''
  if (project) {
    const side = await getFile(io($), `${dataDir(project)}/${plansSide(sessionId)}`)
    const raw = side.state === 'ok' ? parseJson(side.text) : undefined
    if (Array.isArray(raw)) {
      plansAside = sessionId
      return parsePlans({ [sessionId]: raw })[sessionId] ?? []
    }
    const got = await getFile(io($), `${dataDir(project)}/plans.json`)
    const all = got.state === 'ok' ? parseJson(got.text) : undefined
    if (isPlansObject(all) && sessionId in all) return parsePlans(all)[sessionId] ?? []
  }
  return parsePlans(await $.store.get('plans').catch(() => undefined))[sessionId] ?? []
}

// Re-reads the project file first so other sessions' plans stay; a missing file starts empty (plans are not imported).
// Without a project folder, or when no project file can take them, the store is used: there a failed read skips the write rather than overwrite.
async function savePlans($: EngineInterface, list: TaskPlan[]): Promise<void> {
  sessionId = (await currentSessionId($)) || sessionId
  if (!sessionId) return
  try {
    if (project && (await savePlansToProject($, list))) return
    const all: unknown = await $.store.get('plans')
    await $.store.set('plans', mergePlans(isPlansObject(all) ? all : {}, list)).catch(() => {})
  } catch {
    // A failing store costs the save, not the call.
  }
}

// A plan left running with every step finished is done once the main turn ends.
async function closeFinishedPlans($: EngineInterface): Promise<void> {
  const list = await readPlans($)
  const isOpen = (p: TaskPlan) => p.state === 'running' && p.stages.some(s => s.steps.length) && p.stages.every(s => s.steps.every(st => isFinished(st.status)))
  if (!list.some(isOpen)) return
  const at = await $.clock.now()
  const closed = new Set<string>()
  const next = await updatePlans($, prev =>
    prev.map(p => {
      if (!isOpen(p)) return p
      closed.add(p.id)
      return { ...p, state: 'done' as const, endedAt: at }
    }),
  )
  await savePlans($, next)
  for (const p of next) if (closed.has(p.id)) await archivePlan($, p)
}

// Clear finished: each done plan is archived first (one saved already is not saved again), and only the plans the archive
// kept leave the list; one whose save failed stays. Never throws into the press.
async function clearFinishedPlans($: EngineInterface): Promise<void> {
  try {
    const kept = new Set<string>()
    for (const p of (await readPlans($)).filter(pl => pl.state === 'done')) if (await archivePlan($, p)) kept.add(planKey(p))
    if (!kept.size) return
    await savePlans($, await updatePlans($, prev => prev.filter(p => !(p.state === 'done' && kept.has(planKey(p))))))
  } catch {
    // A failing store leaves the plans where they are.
  }
}

const planLine = (p: TaskPlan): string => {
  const w = where(p)
  const active = p.stages.flatMap(s => s.steps).find(st => st.status === 'active')
  return `${p.id}: ${w.pos}/${w.total}, ${p.state}${active ? `, active "${active.title}"` : ''}`
}

// ---------------------------------------------------------------------------
// The flow's lifecycle: it starts by itself (startFlow), finishes by itself (autoFinish, idleFinish), is kept in
// flow-live.json while it is shown (persistLive) and is closed by the next session (adoptLive). See live.ts.

// The flow shown, written to flow-live.json when it changed and at least every LIVE_BEAT_MS while one is shown (the
// heartbeat by which another session tells this one lives); `ended` marks the session's end. A change of what the panel
// holds is activity: the idle finish and the next session's close date the flow by it. Never throws.
async function persistLive($: EngineInterface, ended = false): Promise<void> {
  try {
    if (!project || !sessionId || sessionId === endedSession) return
    const l = await readLiveState($)
    // A flow another session owns is that session's to keep; the next adoption closes it.
    if (l.owner && l.owner !== sessionId) return
    const f = await readFlow($)
    const now = await $.clock.now()
    if (!f) {
      if (!l.key) return
      const done = await changeLive(io($), project, s => without(s, [sessionId]))
      if (done.state === 'bad') noteFault($, 'live', done.why)
      await update($, liveState, () => ({ ...l, key: '', writtenAt: now }))
      return
    }
    const list = await readAgents($)
    const meta = await readMeta($)
    const key = liveKey(f, list, meta)
    const isChanged = key !== l.key
    const activityAt = isChanged || !l.activityAt ? now : l.activityAt
    if (!isChanged && !ended && now - l.writtenAt < LIVE_BEAT_MS) return
    const rec: LiveRecord = { sessionId, ...(transcript ? { transcript } : {}), flow: f, agents: list, meta, lastActivityAt: activityAt, beatAt: now, ...(ended ? { endedAt: now } : {}) }
    const done = await changeLive(io($), project, s => ({ ...s, [sessionId]: rec }))
    if (done.state === 'bad') noteFault($, 'live', done.why)
    // The next try waits for the next change or heartbeat; after a failed one, for LIVE_STALE_MS.
    const next = done.state === 'ok' ? now : now + LIVE_STALE_MS - LIVE_BEAT_MS
    await update($, liveState, () => ({ owner: sessionId, activityAt, key, writtenAt: next }))
  } catch {
    // A failing clock, store or fs costs this write; the next tick tries again.
  }
}

// The id the archive gives a flow's entry (archive.ts `snapshot`): a record closed twice merges into one entry.
const entryIdOf = (meta: Meta): string => `${meta.startedAt}-${meta.project}`

// Every session id the archive and the trash index list, hidden ones too; null when the archive's index cannot be read.
async function archivedIds($: EngineInterface): Promise<Set<string> | null> {
  const dir = dataDir(project)
  const ids = new Set<string>()
  const lists = await readLists($)
  for (const r of [...lists.records, ...lists.trash]) ids.add(r.id)
  // Without a project folder the store's entries are all there is, and the lists hold them.
  if (!project) return ids
  for (const [name, mustRead] of [[INDEX_FILE, true], [`${TRASH_DIR}/${TRASH_INDEX}`, false]] as const) {
    const got = await getFile(io($), `${dir}/${name}`)
    const recs = got.state === 'ok' ? parseIndexFile(parseJson(got.text)) : got.state === 'missing' ? [] : null
    if (!recs) {
      if (mustRead) return null
      continue
    }
    for (const r of recs) ids.add(r.id)
  }
  return ids
}

// Closes one session's flow: finished at its last activity, its running runs ended then (`Running at finish`), saved as an
// Archive session. A flow finished in its session was saved then and is saved again only when the archive does not hold
// it. True when the record may leave flow-live.json (archived, or nothing worth keeping); `closed` holds the entries done
// in this pass, so none is saved twice.
async function closeRecord($: EngineInterface, rec: LiveRecord, closed: Set<string>): Promise<boolean> {
  const at = rec.lastActivityAt || rec.beatAt || (await clockOr($, 0))
  const meta = rec.meta ?? { startedAt: Math.min(at, ...rec.agents.map(a => a.startedAt)), project }
  const id = entryIdOf(meta)
  if (closed.has(id)) return true
  if (rec.flow.isFinished && (await archivedIds($))?.has(id)) {
    closed.add(id)
    return true
  }
  const flow = rec.flow.isFinished ? rec.flow : merge(rec.flow, { finished: true })
  const agents = endRuns(rec.agents.filter(a => a.startedAt >= meta.startedAt), at)
  const entry = snapshot({ flow, agents, project: meta.project, startedAt: meta.startedAt, endedAt: at, status: 'finished' })
  const isKept = !isWorthKeeping(entry) || (await queueArchive(() => saveArchive($, entry)).catch(() => false))
  if (isKept) closed.add(id)
  return isKept
}

// The panel without a flow: what it showed belonged to a session that ended.
async function clearShown($: EngineInterface): Promise<void> {
  await update($, flow, () => null)
  await update($, agents, () => [])
  await update($, flowMeta, () => null)
  await update($, liveState, () => ({ ...LIVE_DEFAULT, owner: sessionId }))
}

// This session's own record back in the panel (a resumed session in a new process): its runs that were going when the
// process ended are `Running at finish` (the engine says nothing of agents from before), its activity as recorded.
async function restoreLive($: EngineInterface, rec: LiveRecord): Promise<void> {
  const list = endRuns(rec.agents, rec.lastActivityAt || rec.beatAt)
  await update($, flow, () => rec.flow)
  await update($, agents, () => list)
  await update($, flowMeta, () => rec.meta)
  await update($, liveState, () => ({ owner: sessionId, activityAt: rec.lastActivityAt, key: liveKey(rec.flow, list, rec.meta), writtenAt: 0 }))
}

// The records of flow-live.json sorted out for session `cur`: its own is restored when the panel holds no flow (a record
// found by the session's transcript is taken over under `cur`); another session's is closed and taken out of the file once
// that session ended or stopped writing it (isGone); one that may still run elsewhere is left and looked at again later.
// A file that cannot be read or holds no flowdeck state is never written, and said once. `closed` as in closeRecord.
async function sortLive($: EngineInterface, cur: string, closed: Set<string>): Promise<void> {
  if (!project) return
  const got = await readLive(io($), project)
  if (got.state === 'bad') return noteFault($, 'live', got.why)
  if (got.state === 'missing') return
  const now = await clockOr($, 0)
  const out: string[] = []
  let isWaiting = false
  for (const rec of got.records) {
    const isMine = rec.sessionId === cur || (!!transcript && rec.transcript === transcript)
    if (isMine) {
      if (!(await readFlow($))) await restoreLive($, rec)
      if (rec.sessionId !== cur) out.push(rec.sessionId)
      continue
    }
    if (!isGone(rec, now)) {
      isWaiting = true
      continue
    }
    if (await closeRecord($, rec, closed)) out.push(rec.sessionId)
  }
  sweepAt = isWaiting ? now + LIVE_STALE_MS : 0
  if (!out.length) return
  const done = await changeLive(io($), project, s => without(s, out))
  if (done.state === 'bad') noteFault($, 'live', done.why)
}

// A session starts (session.start; /clear, /resume or a fork through classic.SessionStart): the flow the panel shows,
// when it belongs to the session that ended here, is closed and the panel starts clean; then flow-live.json is sorted
// out. Running it twice closes nothing twice. Never throws.
async function adoptLive($: EngineInterface, cur: string): Promise<void> {
  try {
    if (!cur) return
    sessionId = cur
    endedSession = ''
    const closed = new Set<string>()
    const held = await readLiveState($)
    const f = await readFlow($)
    if (f && held.owner && held.owner !== cur) {
      const at = held.activityAt || (await clockOr($, 0))
      const rec: LiveRecord = { sessionId: held.owner, flow: f, agents: await readAgents($), meta: await readMeta($), lastActivityAt: at, beatAt: at }
      await closeRecord($, rec, closed)
      await clearShown($)
    } else if (!held.owner) await update($, liveState, l => ({ ...asLive(l), owner: cur }))
    await sortLive($, cur, closed)
  } catch {
    // A failing clock, store or fs leaves the panel as it is; the next start sorts it out.
  }
}

// The finished plans other sessions left (plans.json, their plans-extra files) that the archive does not hold yet are
// archived as this session's are; running plans of other sessions are left alone, and no plans file is written.
async function collectPlans($: EngineInterface): Promise<void> {
  try {
    if (!project) return
    const known = await archivedIds($)
    if (!known) return
    const dir = dataDir(project)
    const found: TaskPlan[] = []
    const got = await getFile(io($), `${dir}/plans.json`)
    const all = got.state === 'ok' ? parseJson(got.text) : undefined
    if (isPlansObject(all)) for (const [sid, list] of Object.entries(parsePlans(all))) if (sid !== sessionId) found.push(...list)
    for (const name of (await listing(io($), dir)) ?? []) {
      if (!/^plans-extra-.+\.json$/.test(name) || name === plansSide(sessionId)) continue
      const side = await getFile(io($), `${dir}/${name}`)
      const raw = side.state === 'ok' ? parseJson(side.text) : undefined
      if (Array.isArray(raw)) found.push(...(parsePlans({ side: raw }).side ?? []))
    }
    for (const p of found) if (p.state === 'done' && !known.has(planEntry(p, project, 0).id)) await archivePlan($, p)
  } catch {
    // A failing fs leaves them for the next start.
  }
}

// A flow with at least one task, every task done (a complete run, completed in the task list, or accepted) and no run
// going finishes by itself when the main turn ends; it stays in the panel, finished, until a new flow or session.
async function autoFinish($: EngineInterface): Promise<void> {
  const f = await readFlow($)
  if (!f || f.isFinished) return
  const list = await readAgents($)
  if (list.some(isLive) || !allTasksDone(f.tasks, list, acceptedOf(f))) return
  await finishFlow($)
  await persistLive($)
}

// A flow with no run going and no task queued, idle for IDLE_FINISH_MS while the session lives, finishes itself, dated by
// its last activity: a flow that ended without anyone closing it.
async function idleFinish($: EngineInterface, now: number, f: Flow | null): Promise<void> {
  const l = await readLiveState($)
  if (!f || f.isFinished || !l.activityAt || now - l.activityAt < IDLE_FINISH_MS) return
  const list = await readAgents($)
  if (list.some(isLive) || plannedOf(f, list).length) return
  await finishFlow($, {}, l.activityAt)
  await persistLive($)
}

// The lifecycle's share of the 5-second tick: the record written when due, the idle finish, and the records of other
// sessions left for later looked at again once they may have gone stale.
async function tickLive($: EngineInterface): Promise<void> {
  // Nothing shown and no other session's record waiting: nothing to do (one read a tick).
  const f = await readFlow($)
  if (!sweepAt && !f) return
  const now = await $.clock.now()
  // At most once per TICK_MS of the clock, however often the engine runs the tick.
  if (Math.abs(now - liveTickAt) < TICK_MS) return
  liveTickAt = now
  await persistLive($)
  if (f && !f.isFinished) await idleFinish($, now, f)
  if (sweepAt && now >= sweepAt) {
    sweepAt = 0
    await sortLive($, sessionId, new Set())
  }
}

// A subagent's calls in flight by tool_use_id: the tool, and whether a permission dialog for it is up.
// Per call, since one agent may run several at once. A reload starts it empty: a request then marks
// the agent itself, and its next call clears the mark.
type Flight = { agentId: string; tool: string; isAsked: boolean }
const flights = new Map<string, Flight>()
let flightCount = 0

// What showAgent last wrote per agent, so a call that changes neither the word nor the flag writes nothing.
// Kept here rather than read back: a hook held open across a call may read an older list than another hook has since written.
const shown = new Map<string, { tool?: string; isAsked: boolean }>()

const forgetFlights = (agentId: string): void => {
  for (const [id, f] of flights) if (f.agentId === agentId) flights.delete(id)
  shown.delete(agentId)
}

// A running agent's tool word and approval flag from its calls in flight.
async function showAgent($: EngineInterface, agentId: string, endedTool?: string, isForced = false): Promise<void> {
  const mine = [...flights.values()].filter(f => f.agentId === agentId)
  const isAsked = isForced || mine.some(f => f.isAsked)
  const last = shown.get(agentId)
  const tool = mine.at(-1)?.tool ?? endedTool ?? last?.tool
  if (last && last.tool === tool && last.isAsked === isAsked) return
  await updateAgents($, list => {
    const at = list.findIndex(a => a.agentId === agentId && a.status === 'running')
    const run = list[at]
    if (!run || (run.tool === tool && !!run.isAsked === isAsked)) return list
    const next = [...list]
    next[at] = { ...run, tool, isAsked }
    return next
  })
  shown.set(agentId, { tool, isAsked }) // an agent the panel does not list is skipped the same way
}

// The reasons said in this load, per kind: each is said once, since a band that keeps failing redraws often (a refused
// tree is known only after the hook returned, so a draw cannot tell it worked) and the tick tries flow-live.json often.
const faults = { band: new Set<string>(), live: new Set<string>() }
const FAULT_LOG = { band: 'the band above the prompt could not be drawn: ', live: '' }

// A fault is said once: a dim transcript line the model does not read (the debug log has it too), with the running
// version, and the panel's line for its kind (`band error`, or the flow-live.json line), so what is missing says why. A
// drawing may not write held values, so the panel's line is written by a timer of its own.
function noteFault($: EngineInterface, kind: 'band' | 'live', why: string): void {
  const text = why.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
  const seen = faults[kind]
  if (seen.has(text) || seen.size >= 20) return
  seen.add(text)
  try {
    $.ui.log(`flowdeck: ${FAULT_LOG[kind]}${text} (v${VERSION})`)
    $.clock.after(1, () => {
      const said = kind === 'band' ? update($, bandError, () => text) : update($, liveError, () => text)
      void said.catch(() => {})
    })
  } catch {
    // Saying so never stands in the band's or the flow's way.
  }
}

// The prompt cache in the band (cache.ts, cache-view.tsx), held per session. Only the main thread's requests count: a
// subagent's do not touch the session's cache.

// A main request starts: the hour starts again. One after the cache went cold (or the first) drops the card's choice,
// which holds only for the mode it was made in.
async function stampCache($: EngineInterface, model: string): Promise<void> {
  const at = await $.clock.now()
  const was = viewOf(await readCache($), at, await readKeepWarm($))
  await updateCache($, c => stamped(c, at, model))
  if (was?.mode !== 'warm' && asCacheFold(await read($, cacheFold))) await update($, cacheFold, () => null)
}

// The cache at `now` with keep warm's bookkeeping and the panel's switch.
const cacheView = async ($: EngineInterface, c: CacheFacts | null, now: number) =>
  isShowable(c) ? viewOf(c, now, await readKeepWarm($), (await readPanel($)).isKeepWarm) : null

// The band shows whole minutes: the tick writes the texts it would show only when they change, so the band redraws once
// a minute at most (each redraw gives its buttons new handles). It also sends keep warm's renewal when one is due.
async function tickCache($: EngineInterface): Promise<void> {
  const c = await readCache($)
  const shown = asCacheTick(await read($, cacheTick))
  if (!isShowable(c) && !shown) return
  const now = await $.clock.now()
  const k = isShowable(c) ? await readKeepWarm($) : KEEP_WARM_DEFAULT
  const isOn = isShowable(c) && (await readPanel($)).isKeepWarm
  const key = cacheKey(viewOf(c, now, k, isOn))
  if (key !== shown) await update($, cacheTick, () => key)
  if (isRenewDue(c, k, isOn, now)) await renewNow($, k, now)
}

// Keep warm (cache.ts `keepStatus`, README "Keep warm"). One renewal at a time; while one is out, a main turn that
// no prompt started is the renewal's own request, should the engine raise one, and is not taken for the user's.
let renewing = false
let prompted = false
const RENEW_PROMPT = 'This request only renews the prompt cache for an idle session. Reply with the single word: ok'

const isRenewalEcho = async ($: EngineInterface): Promise<boolean> => renewing && (await readKeepWarm($)).turnAt === 0

// The renewal itself: one tool-less side request over the main thread's transcript as it was last sent (`$.model.fork`,
// Claude Code 2.1.288 and later), so the API reads the whole context from the cache and its hour starts again. Nothing
// is added to the transcript. True when the request was made and answered (a reply without text read the cache too).
async function renewCache($: EngineInterface): Promise<boolean> {
  const r = await $.model.fork({ prompt: RENEW_PROMPT })
  return r.isAnswered || r.reason === 'empty-reply'
}

// A renewal now (cache.ts `isRenewDue` said so), never once the session ended. A failure is counted, backs off and
// shows on the card; it never reaches the band or the panel as an error.
async function renewNow($: EngineInterface, k: KeepWarm, at: number): Promise<void> {
  if (renewing || (endedSession && endedSession === sessionId)) return
  renewing = true
  prompted = false // only a prompt from now on starts a real turn while the renewal is out
  try {
    await updateKeepWarm($, x => ({ ...x, triedAt: at }))
    const isRenewed = await renewCache($).catch(() => false)
    await updateKeepWarm($, x => renewalEnded(x, at, k.userAt, isRenewed))
  } finally {
    renewing = false
  }
}

// The band's cache part, null with nothing to show yet. A part that cannot be drawn is said (noteFault) and left out,
// so the flow row still draws.
async function cacheBandPart($: EngineInterface, ui: CacheUi, bandW: number): Promise<CacheDrawing | null> {
  try {
    await read($, cacheTick) // read so the minute tick redraws the band
    const c = await readCache($)
    const v = isShowable(c) ? await cacheView($, c, await $.clock.now()) : null
    if (!v) return null
    const toggle = async () => {
      const mode = (await cacheView($, await readCache($), await $.clock.now()))?.mode
      if (mode) await update($, cacheFold, f => toggledFold(asCacheFold(f), mode))
    }
    return cacheDrawing(ui, v, isCardOpen(asCacheFold(await read($, cacheFold)), v.mode), toggle, bandW, svg)
  } catch (err) {
    noteFault($, 'band', `cache: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// Keep warm's switch per project: the engine-store key `keepWarm` maps each project folder to its choice (on unless set).
const KEEP_WARM_KEY = 'keepWarm'
async function saveKeepWarm($: EngineInterface, on: boolean): Promise<void> {
  const all: unknown = await $.store.get(KEEP_WARM_KEY)
  await $.store.set(KEEP_WARM_KEY, { ...(isPlansObject(all) ? all : {}), [project]: on })
}
async function loadKeepWarm($: EngineInterface): Promise<boolean | undefined> {
  const all: unknown = await $.store.get(KEEP_WARM_KEY)
  const on = isPlansObject(all) ? all[project] : undefined
  return typeof on === 'boolean' ? on : undefined
}

// The buttons on top of the panel, and at the row's far end the dim version of the code running (version.ts). They read
// only the panel's own toggles, so the panel can draw them whatever else fails.
function topToggleRow($: EngineInterface, ui: Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>, p: Panel): RenderChildren {
  const { Box, Text, Button } = ui
  const toggleContext = (
    <Button
      key="context"
      label={`${p.isContextShown ? '▾' : '▸'} Context`}
      plain
      onPress={async () => {
        const shown = !p.isContextShown
        await updatePanel($, prev => ({ ...prev, isContextShown: shown }))
        await $.store.set('contextShown', shown).catch(() => {})
      }}
    />
  )
  const toggleUsage = (
    <Button
      key="usage"
      label={`${p.isUsageShown ? '▾' : '▸'} Usage`}
      plain
      onPress={async () => {
        const shown = !p.isUsageShown
        await updatePanel($, prev => ({ ...prev, isUsageShown: shown }))
        await $.store.set('usageShown', shown).catch(() => {})
      }}
    />
  )
  const toggleBand = (
    <Button
      key="band"
      label={`${p.isBandHidden ? '▸' : '▾'} Band`}
      plain
      onPress={async () => {
        const hidden = !p.isBandHidden
        await updatePanel($, prev => ({ ...prev, isBandHidden: hidden }))
      }}
    />
  )
  const toggleKeepWarm = (
    <Button
      key="keep-warm"
      label={`${p.isKeepWarm ? '▾' : '▸'} Keep warm`}
      plain
      onPress={async () => {
        const on = !p.isKeepWarm
        await updatePanel($, prev => ({ ...prev, isKeepWarm: on }))
        await saveKeepWarm($, on).catch(() => {})
      }}
    />
  )
  // One line, never wrapped: the buttons keep their width and only the spacer gives way.
  return (
    <Box key="top-toggles" flexDirection="row" flexWrap="nowrap" gap={1}>
      <Box flexDirection="row" flexShrink={0} gap={1}>
        {toggleContext}
        {toggleUsage}
        {toggleBand}
        {toggleKeepWarm}
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text key="version" dimColor>{`v${VERSION}`}</Text>
      </Box>
    </Box>
  )
}

const TABS: readonly PanelTab[] = ['active', 'finished', 'plans', 'archive', 'trash']
const TAB_LABEL: Record<PanelTab, string> = { active: 'Active', finished: 'Finished', plans: 'Plans', archive: 'Archive', trash: 'Trash' }

// The flowdeck group's tabs, one list shown at a time, each with its count (left out when it could not be read). The
// selected tab is bold in the accent and underlined; pressing it changes nothing.
// Two spaces between tabs: the terminal draws a plain Button as its bare label, so 2 columns; a native (desktop) button
// pads its own label, which is about that much already, so no gap is added there.
const tabGap = (surface: string): number => (surface === 'terminal' ? 2 : 0)

function tabRow($: EngineInterface, ui: Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>, p: Panel, counts: Record<PanelTab, number | null>, gap: number): RenderChildren {
  const { Box, Text, Button } = ui
  const tabs = TABS.map(tab => {
    const n = counts[tab]
    const text = n === null ? TAB_LABEL[tab] : `${TAB_LABEL[tab]} (${n})`
    const select = async () => {
      // Leaving the Trash closes an open Empty Trash confirmation.
      await updatePanel($, prev => (prev.tab === tab ? prev : { ...prev, tab, confirm: prev.confirm?.all ? null : prev.confirm }))
      if (tab === 'archive' || tab === 'trash') await loadOpenDetails($)
    }
    return tab === p.tab ? (
      <Button key={`tab-${tab}`} plain onPress={() => undefined}>
        <Text bold underline color={ACCENT}>
          {text}
        </Text>
      </Button>
    ) : (
      <Button key={`tab-${tab}`} label={text} plain dimColor onPress={select} />
    )
  })
  return (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={gap}>
      {tabs}
    </Box>
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language).catch((): Lang => 'en')
    project = typeof e.cwd === 'string' ? e.cwd : ''
    const stored = await $.store.get('contextShown').catch(() => undefined)
    if (typeof stored === 'boolean') await updatePanel($, prev => ({ ...prev, isContextShown: stored }))
    const storedUsage = await $.store.get('usageShown').catch(() => undefined)
    if (typeof storedUsage === 'boolean') await updatePanel($, prev => ({ ...prev, isUsageShown: storedUsage }))
    const storedRemaining = await $.store.get('usageRemaining').catch(() => undefined)
    if (typeof storedRemaining === 'boolean') await updatePanel($, prev => ({ ...prev, isUsageRemaining: storedRemaining }))
    const storedPlansShown = await $.store.get('plansShown').catch(() => undefined)
    if (typeof storedPlansShown === 'boolean') await updatePanel($, prev => ({ ...prev, isPlansShown: storedPlansShown }))
    const storedArchiveShown = await $.store.get('historyShown').catch(() => undefined)
    if (typeof storedArchiveShown === 'boolean') await updatePanel($, prev => ({ ...prev, isArchiveShown: storedArchiveShown }))
    const storedKeepWarm = await loadKeepWarm($).catch(() => undefined)
    if (typeof storedKeepWarm === 'boolean') await updatePanel($, prev => ({ ...prev, isKeepWarm: storedKeepWarm }))
    // The Archive and Trash lists from their indexes (healed, the old archive imported once, this project's store entries
    // put into files), then the first group's file.
    const loadedAt = await clockOr($, 0)
    const loaded = await loadArchive(io($), project, loadedAt).catch((): ArchiveLists => ({ records: [], trash: [], warnings: [] }))
    await update($, archiveDetails, () => [])
    await updatePanel($, prev => ({ ...prev, confirm: null }))
    await showLists($, loaded)
    const sid = (started as { sessionId?: unknown }).sessionId
    sessionId = (await currentSessionId($)) || (typeof sid === 'string' ? sid : '')
    if (sessionId) {
      const mine = await loadPlans($).catch((): TaskPlan[] => [])
      await update($, plans, () => mine)
    }
    void refreshContext($).catch(() => {})
    // A (re)load starts with no band or flow-live.json error: one that still happens is said again.
    faults.band.clear()
    faults.live.clear()
    if (await read($, bandError).catch(() => '')) await update($, bandError, () => '').catch(() => '')
    if (await read($, liveError).catch(() => '')) await update($, liveError, () => '').catch(() => '')
    await $.tool.register({
      name: 'progress',
      description:
        'Report every task to the progress bar above the prompt and the agents panel: every task goes through flowdeck. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done: [its number]), ' +
        'when switching phase or re-planning (tasks), phase "close" when the current work is done, and finished: true only when the user ends the flow ' +
        '(a flow whose tasks are all done finishes by itself when your turn ends). ' +
        'For a new /flowdeck <task> while a flow is linked, send the new plan with restart: true: the open flow is finished first and the new one starts. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: {
            description:
              'The tasks accepted after review: their numbers (from 1), e.g. [1, 3], added to those accepted before. Name them, so the panel knows which tasks are done; a task accepted without a worker run (you did it, or one run covered it) shows as Accepted. A plain count still works and means the first N tasks.',
            anyOf: [{ type: 'array', items: { type: 'integer', minimum: 1 } }, { type: 'integer', minimum: 0 }],
          },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          restart: {
            type: 'boolean',
            description: 'True to end the open flow (recorded as finished) and start a new one from the rest of this call. Without an open flow it just starts one.',
          },
          add: {
            type: 'array',
            description:
              'Tasks to append to the running flow without touching the plan or the accepted count: new requests and new items in the session task list. Titles already in the flow are ignored.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for (1-based, in the whole task list).' },
              },
              required: ['title'],
            },
          },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Delegate each with the Agent tool `description` `#<number> <title>` (e.g. `#3 History module`; a return round reuses it): the panel links the worker to its task by that number, else by the title. Tasks that edit the same files must be chained with `after` (they never run in parallel); give every waiting task its `after`; independent tasks get none. The panel marks a planned task `ready` once all it waits for is done, and every ready task should be launched at once, in parallel.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; the Agent description is `#<number> <title>`.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: {
                  type: 'array',
                  items: { type: 'integer' },
                  description:
                    'Numbers (from 1) of the tasks this one waits for; leave out for a task that can start at once. Unknown numbers, the task itself and waits that close a cycle are ignored.',
                },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    }).catch(() => {}) // each registration on its own: one refused never stops the others
    await $.tool.register({
      name: 'step',
      description:
        'For flowdeck workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, send your plan once as `steps` (3-8 titles of a few words); ' +
        'then move it with `next: true` as each step finishes, `done` (titles), `active` or `failed`. ' +
        'Without a list, `total` (your plan in 3-8 steps) and `done` (a count, 0 at first) with a `note` still work. ' +
        'Cheap and silent: it only draws the agent row.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Your plan in up to 12 steps, sent once (again only when it changes); the first step starts as active.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'At most 4-5 words.' },
                status: { type: 'string', enum: ['pending', 'active', 'done', 'error'] },
              },
              required: ['title'],
            },
          },
          next: { type: 'boolean', description: 'Finish the step in progress and start the next.' },
          done: {
            description: 'Titles of steps now finished; or, without a list, the number of steps finished so far.',
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'integer', minimum: 0 }],
          },
          active: { type: 'string', description: 'Title of the step now in progress.' },
          failed: { type: 'string', description: 'Title of the step that failed.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned, without a list; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words; with a list, its active title is used.' },
        },
      },
    }).catch(() => {})
    const planStep = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'At most 4 words.' },
        status: { type: 'string', enum: ['pending', 'active', 'done', 'error', 'skipped'] },
      },
      required: ['title'],
    }
    await $.tool.register({
      name: 'plan',
      description:
        'Show a plan for any task as a progress bar: stages of steps, or a flat list with kind "todo". ' +
        'Create it once with id, title and the whole stages list, then move it with short ops: next, done, active, failed, state, note. ' +
        'Resend stages under the same id when the plan changes; finished steps are kept. Titles of at most 4 words.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short id of the plan; every later call names it.' },
          title: { type: 'string', description: 'At most 4 words.' },
          kind: { type: 'string', enum: ['plan', 'todo'] },
          stages: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, steps: { type: 'array', items: planStep } }, required: ['name', 'steps'] },
          },
          next: { type: 'boolean', description: 'Finish the current step and start the next.' },
          done: { type: 'array', items: { type: 'string' }, description: 'Titles of steps now finished.' },
          active: { type: 'string', description: 'Title of the step now in progress.' },
          failed: { type: 'string', description: 'Title of the step that failed.' },
          state: { type: 'string', enum: ['running', 'needs_input', 'error', 'done'] },
          note: { type: 'string', description: 'A short line under the bar.' },
        },
        required: ['id'],
      },
    }).catch(() => {})
    await $.command.register({
      name: 'flowdeck-agents',
      description: 'Show or hide the flowdeck panel: context window, subagents running, finished and planned, with model, cost and time',
    }).catch(() => {}) // a name Claude Code already has is refused: start anyway

    // The flow shown and flow-live.json sorted into this session's and the last sessions' (closed and archived), then the
    // finished plans other sessions left.
    await adoptLive($, sessionId)
    void collectPlans($)

    // Ticks the running agents' clocks; quiet when nothing runs. Every tick redraws the pane and gives its buttons new
    // handles, so it stays slow: a click on a handle from before the redraw is refused by the desktop app.
    $.clock.every(TICK_MS, () => {
      void tickCache($).catch(() => {}) // the band's WARM countdown, its flip to COLD and keep warm's renewal
      void tickLive($).catch(() => {}) // flow-live.json, the idle finish, other sessions' records
      void (async () => {
        const list = await readAgents($)
        if (!list.some(isLive)) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })().catch(() => {})
    })
    return started
  })

  // The rules are added to whatever the engine and other mods composed; a failure below is not masked (that would replace the real prompt with ours alone).
  on('prompt.compose', async ($, e, next) => {
    const rules = [
      { id: 'flowdeck:plan-rule', text: PLAN_RULE, scope: 'session' as const },
      { id: 'flowdeck:flow-rule', text: FLOW_RULE, scope: 'session' as const },
    ]
    const result = await next(e)
    return { sections: [...result.sections, ...rules] }
  })

  on('command.run', { command: 'flowdeck-agents' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    let prev = await readFlow($)
    // Finishing a flow that is already finished changes nothing; it would otherwise open a blank one. So does a call on a
    // finished flow that names no new work (a late `done` or phase after the flow finished by itself).
    const isNewWork = input.title !== undefined || !!input.tasks?.length || !!input.add?.length || input.restart === true
    if (prev?.isFinished && (input.finished === true || !isNewWork)) return { result: `ok: ${label(prev)}` }
    // A restart ends the open flow as finished: true does; the rest of the input then starts the new one.
    if (input.restart === true && prev && !prev.isFinished) prev = await finishFlow($)
    // The flow being replaced goes to the archive first, with its own agents; a finished one is there already.
    if (isNewFlow(prev, input)) await beginFlow($, prev)
    const at = await clockAt($)
    const next = input.finished === true ? await finishFlow($, input) : await updateFlow($, p => merge(p, input, at))
    if (next && (input.tasks?.length || input.add?.length)) await autoOpen($, next.title)
    await persistLive($)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // Every task the session adds goes into the flow: the model's task list items are mirrored as planned tasks, and a list
  // with no open flow starts one.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      // a worker's own steps are not session tasks
      await mirrorTasks($, todoItems((e as unknown as { todos?: unknown }).todos)).catch(() => {})
      await persistLive($)
    }
    return result
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    const input = e as unknown as { subject?: unknown; title?: unknown }
    const title = typeof input.subject === 'string' ? input.subject.trim() : typeof input.title === 'string' ? input.title.trim() : ''
    if (!e.agentId && title) {
      await mirrorTasks($, [{ title, completed: false }]).catch(() => {})
      await persistLive($)
    }
    return result
  })

  // A subagent's own call names its tool word; flowdeck's bookkeeping calls do not. Never alters the call.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || HOUSEKEEPING.has(e.tool)) return next(e)
    const useId = e.tool_use_id ?? `${agentId}#${++flightCount}`
    try {
      flights.set(useId, { agentId, tool: e.tool, isAsked: false })
      await showAgent($, agentId)
    } catch {
      // A failing read costs the word, not the call.
    }
    try {
      return await next(e)
    } finally {
      flights.delete(useId)
      await showAgent($, agentId, e.tool).catch(() => {})
    }
  })

  // Amber only while a permission dialog for the agent's call is really up: a settings hook's answer raises none.
  on('classic.PermissionRequest', async ($, e, next) => {
    const agentId = e.agent_id
    let flight: Flight | undefined
    let isMarked = false
    try {
      if (agentId && !HOUSEKEEPING.has(e.tool_name)) {
        // The request names no call: the agent's oldest call of this tool not yet asked, else its oldest not asked.
        const open = [...flights.values()].filter(f => f.agentId === agentId && !f.isAsked)
        flight = open.find(f => f.tool === e.tool_name) ?? open[0]
        if (flight) flight.isAsked = true
        await showAgent($, agentId, undefined, !flight)
        isMarked = true
      }
    } catch {
      // A failing read costs the mark, not the request.
    }
    const answer = await next(e)
    if (agentId && isMarked && answer.decision) {
      if (flight) flight.isAsked = false
      await showAgent($, agentId).catch(() => {})
    }
    return answer
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    const agentId = e.agent_id
    if (agentId) {
      const flight = flights.get(e.tool_use_id) ?? [...flights.values()].find(f => f.agentId === agentId && f.isAsked)
      if (flight) flight.isAsked = false
      await showAgent($, agentId).catch(() => {})
    }
    return next(e)
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as StepInput
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    // Sent counts and note win for this call; otherwise a list gives them.
    const sent = { done: num(input.done), total: num(input.total), note: typeof input.note === 'string' ? input.note.trim() : '' }
    let at: number | undefined
    if (hasItemOps(input)) {
      try {
        at = await $.clock.now()
      } catch {
        // No clock: the items go unstamped.
      }
    }
    let unknown: string[] = []
    try {
      await updateAgents($, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          const moved = stepItems(a.items, input, at)
          if (moved) unknown = moved.unknown
          if (!moved?.items.length) {
            const total = Math.max(0, Math.round(sent.total ?? a.stepTotal ?? 0))
            const done = Math.max(0, Math.round(sent.done ?? a.stepDone ?? 0))
            return { ...a, ...(moved ? { items: undefined } : {}), stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: sent.note || undefined }
          }
          const d = derive(moved.items)
          const total = Math.max(0, Math.round(sent.total ?? d.total))
          const done = Math.max(0, Math.round(sent.done ?? d.done))
          return { ...a, items: moved.items, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: sent.note || d.note }
        }),
      )
    } catch {
      return { result: 'ok (the panel could not be updated)' }
    }
    if (!unknown.length) return { result: 'ok' }
    return { result: `ok (unknown step${unknown.length > 1 ? 's' : ''} ${unknown.map(t => `"${t.slice(0, 60)}"`).join(', ')} ignored)` }
  })

  // A task plan of the main session; a refused call changes nothing.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: only the main session plans' }
    try {
      const input = e as unknown as Record<string, unknown>
      const id = planId(input)
      const list = await readPlans($)
      const made = normalize(input, list.find(p => p.id === id) ?? null, await $.clock.now(), id)
      if (typeof made === 'string') return { result: 'flowdeck plan: ' + made }
      const placed = await updatePlans($, prev => placeBar(prev, made))
      await savePlans($, placed)
      if (made.state === 'done') await archivePlan($, made)
      return { result: planLine(made) }
    } catch {
      return { result: 'flowdeck plan: could not update the plan' }
    }
  })

  // The plan the user approves in plan mode becomes the plan "plan"; approving a revision updates it.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined || ran.isError === true) return ran
    try {
      const fromResult = (ran.result as { plan?: unknown } | undefined)?.plan
      const fromInput = (e as unknown as { plan?: unknown }).plan
      const text = typeof fromResult === 'string' && fromResult.trim() ? fromResult : fromInput
      if (typeof text !== 'string') return ran
      const list = await readPlans($)
      const made = importPlan(text, list.find(p => p.id === PLAN_ID) ?? null, await $.clock.now())
      if (!made) return ran
      const placed = await updatePlans($, prev => placeBar(prev, made))
      await savePlans($, placed)
    } catch {
      // A failing store or clock costs the plan, not the approval.
    }
    return ran
  })

  // A question to the user marks the newest running plan as waiting until the answer comes back.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    let waiting: string | undefined
    try {
      const first = ((e as unknown as { questions?: unknown }).questions as { header?: unknown; question?: unknown }[] | undefined)?.[0]
      const note = str(first?.header, 160) || str(first?.question, 160) || null
      const live = (await readPlans($)).filter(p => p.state === 'running').pop()
      if (live) {
        waiting = live.id
        await savePlans($, await updatePlans($, list => list.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const, note } : p))))
      }
    } catch {
      // A failing store costs the waiting mark, not the question.
    }
    const ran = await next(e)
    if (waiting) {
      try {
        const id = waiting
        await savePlans($, await updatePlans($, list => list.map(p => (p.id === id && p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p))))
      } catch {
        // as above
      }
    }
    return ran
  })

  // The user's own prompt (typed, or sent from the phone over Remote Control) answers whatever a plan was waiting on.
  // It is also the user's message keep warm counts renewals from; an SDK host's turn (`sdk`) counts too, as a host may
  // send what the user typed that way.
  on('prompt.submit', async ($, e, next) => {
    prompted = true
    const kind = e.origin?.kind
    if ((kind === 'composer' || kind === 'bridge' || kind === 'sdk') && !e.isMeta) {
      const at = await $.clock.now().catch(() => 0)
      if (at) await updateKeepWarm($, k => userSpoke(k, at)).catch(() => {})
    }
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') {
      try {
        if ((await readPlans($)).some(p => p.state === 'needs_input')) {
          await savePlans($, await updatePlans($, list => list.map(p => (p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p))))
        }
      } catch {
        // A failing store costs the reset, not the prompt.
      }
    }
    return next(e)
  })

  // A worker launch with no open flow starts one, named after its description; every launch moves the faint layer even if
  // the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!isWorker(type)) return next(e)

    try {
      const shown = await readFlow($)
      if (!shown || shown.isFinished) await startFlow($, shown, String(e.description ?? '') || type)
      await updateFlow($, prev => {
        const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
        return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
      })
      await persistLive($)
    } catch {
      // A failing store or clock costs the flow's start, not the launch.
    }
    try {
      return await next(e)
    } finally {
      await updateFlow($, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await updateAgents($, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (isWorker(e.subagentType)) {
      const f = await readFlow($)
      await autoOpen($, f && !f.isFinished ? f.title : 'flowdeck')
    }
    return started
  })

  // A main turn starts: keep warm sends nothing until it ends (turn.complete).
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && (!renewing || prompted)) {
      prompted = false
      const at = await $.clock.now().catch(() => 0)
      if (at) await updateKeepWarm($, k => ({ ...k, turnAt: at })).catch(() => {})
    }
    return result
  })

  // Each model request of a subagent: live context, tokens and cost. A main request reads or writes the prompt cache.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && !(await isRenewalEcho($).catch(() => false))) await stampCache($, e.model).catch(() => {})
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await updateAgents($, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              archived: undefined, // a run going again is no longer archived
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      forgetFlights(agentId)
      const at = await $.clock.now()
      await updateAgents($, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          // The item still in progress ends with the run.
          const items = itemsOf(a.items)
          const closed = items.some(it => it.status === 'active') ? finishItems(items, e.reason === 'answer', at) : null
          const counts = closed ? derive(closed) : null
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            tool: undefined,
            isAsked: undefined,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
            ...(closed && counts ? { items: closed, stepDone: counts.done, stepTotal: counts.total, stepNote: counts.note } : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    if (!agentId && (await isRenewalEcho($).catch(() => false))) return next(e) // keep warm's own request, not a turn of the session
    if (!agentId) await updateKeepWarm($, k => (k.turnAt ? { ...k, turnAt: 0 } : k)).catch(() => {}) // no main turn runs now
    const result = await next(e)
    if (!agentId) {
      const context = await refreshContext($).catch(() => null) // a subagent's turn fills its own window, not this one
      const at = await $.clock.now().catch(() => null)
      if (at !== null) await updateCache($, c => measured(c, at, e.durationMs, context, e.usage?.model)).catch(() => {})
    }
    if (!agentId) await closeFinishedPlans($).catch(() => {})
    if (!agentId) await autoFinish($).catch(() => {}) // the main turn ended: a flow whose tasks are all done finishes
    return result
  })

  // The engine measured the main window again: the cache's size follows, once a request is known.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context') && e.context.tokens && (await readCache($).catch(() => null))) {
      await updateCache($, c => remeasured(c, e.context)).catch(() => {})
    }
    return result
  })

  // /clear and /compact start a new cache; a resumed or forked session knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const fresh = async (): Promise<CacheFacts | null> => {
      if (e.source === 'clear' || e.source === 'compact') return null
      const at = await $.clock.now()
      const window = await Promise.resolve().then(() => $.session.usage()).then(u => u.context.window || 0, () => 0)
      const model = typeof e.model === 'string' && e.model ? e.model : await Promise.resolve().then(() => $.session.model()).catch(() => '')
      return seeded(at, e.seconds_since_last_response ?? 0, typeof e.context_tokens === 'number' ? e.context_tokens : 0, window, model || null)
    }
    const isSeed = (e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number'
    if (isSeed || e.source === 'clear' || e.source === 'compact') {
      await fresh()
        .then(async c => {
          await updateCache($, () => c)
          await update($, cacheFold, () => null)
          await updateKeepWarm($, k => ({ ...KEEP_WARM_DEFAULT, turnAt: k.turnAt })) // a new cache: nothing renewed yet
        })
        .catch(() => {}) // the band never holds up a session's start
    }
    // A new session in this process (/clear, /resume, a fork) gets no session.start: its flow is sorted out here. A
    // /compact keeps the session; a startup is session.start's.
    if (typeof e.transcript_path === 'string' && e.transcript_path) transcript = e.transcript_path
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      const cur = typeof e.session_id === 'string' && e.session_id ? e.session_id : await currentSessionId($)
      await adoptLive($, cur)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && 'messages' in result) void refreshContext($).catch(() => {}) // a /compact empties the window without a turn ending
    return result
  })

  // The session ends: its record in flow-live.json is marked ended first (so the next session closes it at once), then a
  // flow still open is kept as open in the archive, dated by its last activity; the next session's close or a finish
  // later replaces the same entry.
  on('session.end', async ($, e, next) => {
    try {
      await persistLive($, true)
      endedSession = sessionId
      const f = await readFlow($)
      if (f && !f.isFinished) await recordFlow($, f, 'open', undefined, (await readLiveState($)).activityAt || undefined)
    } catch {
      // The session ends whatever fails here.
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const p = await readPanel($)
    // A part that throws draws this one dim line in its place; the rest of the panel still draws.
    const failed = (label: string, key?: string) => (
      <Text key={key} dimColor>
        {`${label} could not be drawn`}
      </Text>
    )
    const safe = async (label: string, draw: () => RenderChildren | Promise<RenderChildren>): Promise<RenderChildren> => {
      try {
        return await draw()
      } catch {
        return failed(label)
      }
    }
    const topToggles = topToggleRow($, { Box, Text, Button }, p)
    // Why the band above the prompt failed in this load, under the buttons (the Band button is among them).
    const fault: unknown = await read($, bandError).catch(() => '')
    const bandLine = typeof fault === 'string' && fault ? <Text dimColor>{`band error: ${fault} (v${VERSION})`}</Text> : null
    // What flow-live.json could not do in this load (an unreadable file is never written over).
    const liveFault: unknown = await read($, liveError).catch(() => '')
    const liveLine = typeof liveFault === 'string' && liveFault ? <Text dimColor>{liveFault}</Text> : null
    // An agent that reported its steps folds them out under its row; open only in this session.
    // `fp` prefixes an archive group's fold state (`<entryId>:<agentId>`), so folding a row there never folds the live one.
    const isUnfolded = (a: AgentRun, fp = '') => (p.openAgents ?? []).includes(fp + a.id)
    // `kp` prefixes the keys of an archive group's rows, so they never share a key with the live ones.
    // Every agent row folds; a row with no step list yet has a dim chevron and opens on its details.
    const foldButton = (a: AgentRun, kp = '', fp = '', hasItems = true) => (
      <Button
        key={`${kp}agent-fold-${a.id}`}
        label={foldGlyph(isUnfolded(a, fp))}
        plain
        dimColor={!hasItems}
        onPress={() =>
          updatePanel($, prev => {
            const open = prev.openAgents ?? []
            const id = fp + a.id
            return { ...prev, openAgents: open.includes(id) ? open.filter(x => x !== id) : [...open, id] }
          })
        }
      />
    )

    const Svg = e.surface === 'desktop' && 'Svg' in ui ? ui.Svg : null
    const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    // Today, as the rows' completion times are told against it (`HH:MM` today, the date before).
    const today = await clockOr($, 0)

    // One flow as the panel draws it, live or from the archive (FlowView in archive-view.tsx says what it takes).
    const flowView = (v: FlowView): FlowDrawing => {
      const { kp, fp, at } = v
      // The task each run belongs to: its number leads the row's name, its waits go on the model line.
      const tasks: TaskLike[] = v.tasks ?? []
      const accepted = v.accepted ?? []
      const { links, acceptedRows, running, finished, archivedCount } = rowsOf(tasks, v.list, accepted, v.acceptedAt, v.acceptedFallback)
      // When a finished row finished (an accepted one, when it was accepted), on its name line; running and queued rows show none.
      const doneOf = (a: AgentRun): string => (a.status !== 'running' && a.endedAt ? doneText(a.endedAt, today) : '')
      const acceptedDone = (pl: Planned): string => (pl.doneAt ? doneText(pl.doneAt, today) : '')
      // The finished rows and the accepted ones in one list, latest completion first.
      type Done = { a: AgentRun } | { pl: Planned }
      const byDone = (runs: AgentRun[]): Done[] =>
        sortNewest<Done>([...runs.map(a => ({ a })), ...acceptedRows.map(pl => ({ pl }))], r => ('a' in r ? runPlace(r.a) : acceptedPlace(r.pl)))
      const taskFor = (a: AgentRun) => taskOf(tasks, links, a)
      // A `#3 …` the description started with is not repeated after the number it gave.
      const nameOf = (a: AgentRun): string => {
        const t = taskFor(a)
        const d = a.description || a.type
        if (!t) return d
        const tag = taskTag(d)
        return `${t.n}. ${tag.n === t.n ? tag.rest : d}`
      }
      // Accepted tasks: a run of one that stays Incomplete says so; one no run belongs to is an Accepted row of its own.
      const isAccepted = (a: AgentRun): boolean => {
        const t = taskFor(a)
        return !!t && accepted.includes(t.n)
      }
      // An opened row with no step list: its model and effort, when it started, its tokens and cost, then that none came.
      const detailLines = (a: AgentRun): string[] => [
        [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model), `${s.started} ${doneText(a.startedAt, today)}`, `${fmtTokens(a.tokens)} ${s.tokensWord}`, `≈${fmtCost(a.costUsd)}`].join(' · '),
        s.noSteps,
      ]
      const archiveButton = (a: AgentRun) =>
        v.archive?.can(a) ? <Button key={`archive-item-${a.id}`} label={ARCHIVE_ICON} plain dimColor onPress={() => v.archive?.press(a)} /> : null
      // A row that throws draws one dim line in its place; the other rows still draw.
      const guard = (a: AgentRun, draw: () => RenderChildren): RenderChildren => {
        try {
          return draw()
        } catch {
          return failed('Agent row', `${kp}${a.id}`)
        }
      }
      // The one list `v.rows` names, drawn with the surface's own rows.
      type RowDraw = { agent: (a: AgentRun, word: string) => RenderChildren; accepted: (pl: Planned) => RenderChildren; planned: (pl: Planned) => RenderChildren }
      const listOf = (d: RowDraw): RenderChildren[] => {
        const note = (key: string, text: string) => (
          <Text key={`${kp}${key}`} dimColor>
            {text}
          </Text>
        )
        if (v.rows === 'active') {
          if (!running.length && !v.planned.length) return [note('empty', s.nothingQueued)]
          return [...running.map(a => guard(a, () => d.agent(a, s.isRunning))), ...v.planned.map(d.planned)]
        }
        if (v.rows === 'finished') {
          return [
            archivedCount > 0 && note('archived', `${archivedCount} archived`),
            !finished.length && !acceptedRows.length && note('empty', s.noFinished),
            ...byDone(finished).map(r => ('a' in r ? guard(r.a, () => d.agent(r.a, s.isFinished)) : d.accepted(r.pl))),
          ]
        }
        // The archive's list: every row, latest completion first.
        return [
          v.list.length === 0 && acceptedRows.length === 0 && note('empty', s.empty),
          ...byDone(v.list).map(r => ('a' in r ? guard(r.a, () => d.agent(r.a, r.a.status === 'running' ? s.isRunning : s.isFinished)) : d.accepted(r.pl))),
        ]
      }
      if (Svg) {
        const viewSummary = `≈${fmtCost(v.t.cost)}, ${fmtTokens(v.t.tokens)} ${s.tokensWord}, ${fmtTime(v.t.time)}`
        // Every row: line 1 is native (a Button cannot sit inside a drawing): the fold chevron at the far left, the indent
        // that puts the task name at the drawing's text column, the archive icon after the name and when it finished at
        // the far end; then the drawing at the full width without its title line.
        const agentRow = (a: AgentRun, word: string) => {
          const alt = `${a.description}: ${modelName(a.model)}, ${word}`
          const items = timedItems(itemsOf(a.items), a)
          const toArchive = archiveButton(a)
          const done = doneOf(a)
          return (
            <Box key={`${kp}${a.id}`} flexDirection="column">
              <Box flexDirection="row" alignItems="center">
                <Box flexShrink={0}>{foldButton(a, kp, fp, items.length > 0)}</Box>
                <Svg source={INDENT_SVG} alt="" width={INDENT_W} height={1} />
                <Box flexDirection="row" alignItems="center" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
                  <Box flexShrink={1} minWidth={0} overflow="hidden">
                    <Text bold wrap="truncate-end">
                      {nameOf(a)}
                    </Text>
                  </Box>
                  {toArchive && <Box flexShrink={0}>{toArchive}</Box>}
                  <Box flexGrow={1} />
                  {done && (
                    <Box flexShrink={0}>
                      <Text dimColor>{done}</Text>
                    </Box>
                  )}
                </Box>
              </Box>
              <Svg source={agentSvg(W, a, at, { titleOutside: true, after: taskFor(a)?.after, isAccepted: isAccepted(a) })} alt={alt} width={W} height={agentHeight(true)} />
              {isUnfolded(a, fp) &&
                items.map((it, i) => (
                  <Svg key={`${kp}agent-item-${a.id}-${i}`} source={svg(W, ITEM_H, itemSvg(W, it, at, fitText))} alt={itemAlt(it, at)} width={W} height={ITEM_H} />
                ))}
              {isUnfolded(a, fp) &&
                items.length === 0 &&
                detailLines(a).map((line, i) => (
                  <Svg key={`${kp}agent-detail-${a.id}-${i}`} source={svg(W, ITEM_H, noteSvg(W, line, fitText))} alt={line} width={W} height={ITEM_H} />
                ))}
            </Box>
          )
        }
        const acceptedRow = (pl: Planned) => (
          <Svg key={`${kp}accepted-${pl.n}`} source={acceptedSvg(W, pl, acceptedDone(pl))} alt={`${pl.n}. ${pl.title}: ${s.acceptedRow} · ${s.noRun}`} width={W} height={ACCEPTED_H} />
        )
        return {
          header: <Svg source={headerSvg(W, v.t)} alt={viewSummary} width={W} height={HEADER_H} />,
          body: () =>
            listOf({
              agent: agentRow,
              accepted: acceptedRow,
              planned: pl => <Svg key={`${kp}plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />,
            }),
        }
      }
      const row = (a: AgentRun) => {
        const tier = tierOf(a.type)
        const color = colorOf(tier)
        const ctx = ctxOf(a)
        const progress = progressOf(a)
        const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
        const steps = a.stepTotal ? `${stepCount(a)}${a.stepNote ? ' ' + a.stepNote : ''}` : ''
        const tierWord = tier === 'other' ? a.type : tier
        const round = a.round > 1 ? ` · ${s.round} ${a.round}` : ''
        const bareLine = `  ${tierWord} · ${model}${round}`
        // The stats end the model line when they fit there, else they are left out.
        const stats = fitStats(a, at, ' ', cols - bareLine.length - 3, t => t.length)
        // The task's waits follow the effort only when the stats keep their room.
        const waits = afterText(taskFor(a)?.after)
        const waitLine = `  ${tierWord} · ${model} · ${waits}${round}`
        const modelLine = waits && waitLine.length + 3 + stats.length <= cols ? waitLine : bareLine
        // The state leads the line in its colour, cut only at the row's width.
        const state = agentState(a)
        const head = headOf(a, isAccepted(a))
        const room = Math.max(state.name.length + 1, cols - 2 - barW - 1)
        const [lead, rest] = splitHead(clip(steps ? `${head} · ${steps}` : head, room), head)
        const items = timedItems(itemsOf(a.items), a)
        const done = doneOf(a)
        // The fold chevron right before the name (dim on a row with no step list yet), the archive icon and the state
        // glyph after it, when it finished at the far end.
        return (
          <Box key={`${kp}${a.id}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={color}>▣</Text>
              {foldButton(a, kp, fp, items.length > 0)}
              <Box flexShrink={1} minWidth={0}>
                <Text bold wrap="truncate-end">
                  {nameOf(a)}
                </Text>
              </Box>
              {archiveButton(a)}
              <Text color={glyphColor(a, color)}>{STATUS_GLYPH[markOf(a)]}</Text>
              {done ? <Box flexGrow={1} /> : null}
              {done ? <Text dimColor>{done}</Text> : null}
            </Box>
            <Text dimColor wrap="truncate-end">
              {modelLine}
              {stats ? ` · ${stats}` : ''}
            </Text>
            <Text wrap="truncate-end">
              {'  '}
              {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={state.color}>{ctxBar(progress * 100, barW)}</Text>}{' '}
              <Text color={state.color}>{lead}</Text>
              <Text dimColor>{rest}</Text>
            </Text>
            {isUnfolded(a, fp) &&
              items.map((it, i) => {
                const l = itemLine(it, at, cols)
                return (
                  <Text key={`${kp}agent-item-${a.id}-${i}`} wrap="truncate-end">
                    {'   '}
                    <Text color={l.color} dimColor={l.isDim}>
                      {l.mark}
                    </Text>{' '}
                    <Text dimColor={l.isDim}>{l.title}</Text>
                    {l.time ? <Text dimColor>{`  ${l.time}`}</Text> : null}
                  </Text>
                )
              })}
            {isUnfolded(a, fp) &&
              items.length === 0 &&
              detailLines(a).map((line, i) => (
                <Text key={`${kp}agent-detail-${a.id}-${i}`} dimColor wrap="truncate-end">
                  {'   '}
                  {line}
                </Text>
              ))}
          </Box>
        )
      }
      const acceptedLine = (pl: Planned) => {
        const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
        return (
          <Box key={`${kp}accepted-${pl.n}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">
                  <Text color="green">✓</Text>
                  {'   '}
                  {pl.n}. {pl.title}
                </Text>
              </Box>
              {acceptedDone(pl) ? <Box flexGrow={1} /> : null}
              {acceptedDone(pl) ? <Text dimColor>{acceptedDone(pl)}</Text> : null}
            </Box>
            <Text wrap="truncate-end">
              {'  '}
              <Text color={colorOf(tier)}>{tier}</Text>
              {' · '}
              <Text color={STATE_COLOR.done}>{`${s.acceptedRow} · ${s.noRun}`}</Text>
            </Text>
          </Box>
        )
      }
      const plannedLine = (pl: Planned) => {
        const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
        const ready = pl.ready ? ` · ${s.ready}` : ''
        const waits = pl.after.length ? ` · ${afterText(pl.after)}` : ''
        const head = `  ${tier} · ${TIER_MODEL[tier] ?? ''}`
        // The wait goes first when the line is short; `ready` stays.
        const shownWaits = (head + waits + ready).length <= cols ? waits : ''
        return (
          <Box key={`${kp}plan-${pl.n}`} flexDirection="column" marginBottom={1}>
            <Text dimColor wrap="truncate-end">
              <Text color={colorOf(tier)}>▢</Text>
              {'   '}
              {pl.n}. {pl.title} ◷
            </Text>
            <Text wrap="truncate-end">
              <Text dimColor>
                {head}
                {shownWaits}
              </Text>
              {ready ? <Text dimColor>{' · '}</Text> : null}
              {ready ? (
                <Text color={STATE_COLOR.running} bold>
                  {s.ready}
                </Text>
              ) : null}
            </Text>
          </Box>
        )
      }
      return {
        header: (
          <Text dimColor>
            ≈{fmtCost(v.t.cost)} · {fmtTokens(v.t.tokens)} {s.tokensWord} · {fmtTime(v.t.time)}
          </Text>
        ),
        body: () => listOf({ agent: a => row(a), accepted: acceptedLine, planned: plannedLine }),
      }
    }

    const setIn = (ids: string[] | undefined, id: string, isIn: boolean): string[] => [...(ids ?? []).filter(x => x !== id), ...(isIn ? [id] : [])]

    // Context, Usage and the Archive draw on their own, each from its own values, whatever the flow is doing.
    const contextSection = await safe('Context', async () => {
      const rd = await readReading($)
      if (Svg) {
        const dc = rd ? contextSvg(W, rd, !p.isContextShown) : null
        return dc && rd ? (
          <Svg source={svg(W, dc.height, dc.body)} alt={`context ${rd.percent}%`} width={W} height={dc.height} />
        ) : (
          <Text dimColor>no context data yet</Text>
        )
      }
      // Terminal: the same content in text rows.
      return rd && cols >= 20 ? (
        <Box flexDirection="column">
          {contextRows(rd, cols, !p.isContextShown).map((line, i) => (
            <Text key={`ctx-${i}`} dimColor={i > 1} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>no context data yet</Text>
      )
    })

    const usageSection = await safe('Usage', async () => {
      if (!p.isUsageShown) return null
      const us = await readUsage($)
      const clockNow = await $.clock.now()
      const remaining = p.isUsageRemaining
      // One switch per window, both flipping the one choice between the time left and the exact time.
      const resetSwitch = (kind: string) => (
        <Button
          key={resetKey(kind)}
          label={RESET_ICON}
          plain
          dimColor
          onPress={async () => {
            const next = !remaining
            await updatePanel($, prev => ({ ...prev, isUsageRemaining: next }))
            await $.store.set('usageRemaining', next).catch(() => {})
          }}
        />
      )
      if (Svg) {
        // Per window a native row (label, reset line and its switch: a Button cannot sit inside a drawing), then the drawing without its header.
        return us.windows.length ? (
          <Box flexDirection="column">
            {us.windows.map(win => {
              const reset = resets(live(win, clockNow), clockNow, undefined, remaining)
              const du = usageSvg(W, [win], us.samples, clockNow, undefined, { header: false })
              return (
                <Box key={`usage-${win.kind}`} flexDirection="column">
                  <Box flexDirection="row" alignItems="center" gap={1}>
                    <Box flexShrink={1} minWidth={0} overflow="hidden">
                      <Text bold wrap="truncate-end">
                        {win.label}
                      </Text>
                    </Box>
                    <Box flexGrow={1} />
                    {reset && (
                      <Box flexShrink={0}>
                        <Text dimColor>{reset}</Text>
                      </Box>
                    )}
                    {reset && <Box flexShrink={0}>{resetSwitch(win.kind)}</Box>}
                  </Box>
                  <Svg source={svg(W, du.height, du.body)} alt={`${win.label} ${Math.max(0, 100 - win.percent)}% left`} width={W} height={du.height} />
                </Box>
              )
            })}
          </Box>
        ) : (
          <Text dimColor>no usage data yet</Text>
        )
      }
      return us.windows.length ? (
        <Box flexDirection="column">
          {usageRows(us.windows, us.samples, clockNow, cols, undefined, { remaining }).map((r, i) => {
            const kind = us.windows[r.window]?.kind ?? ''
            const line = (
              <Text key={`use-${i}`} dimColor={r.kind !== 'bar'} color={r.kind === 'bar' ? (r.over ? 'red' : kind === 'seven_day' ? 'blue' : 'yellow') : undefined} wrap="truncate-end">
                {r.line}
              </Text>
            )
            return r.kind === 'head' && r.hasReset ? (
              <Box key={`use-${i}`} flexDirection="row" gap={1}>
                <Box flexShrink={1} minWidth={0} overflow="hidden">
                  {line}
                </Box>
                <Box flexShrink={0}>{resetSwitch(kind)}</Box>
              </Box>
            ) : (
              line
            )
          })}
        </Box>
      ) : (
        <Text dimColor>no usage data yet</Text>
      )
    })

    // One plan as the Plans section and an Archive plan group draw it: the svg on the desktop, the rows in the terminal.
    // `kp` keeps the Archive's keys apart from the section's.
    const planDrawing = (pl: TaskPlan, kp: string, at: number): RenderChildren => {
      if (Svg) {
        const d = planSvg(W, pl, at)
        return <Svg key={`${kp}plan-view-${keyOf(pl.id)}`} source={svg(W, d.height, d.body)} alt={`${pl.title}: ${stateLabel(pl)}, ${percent(pl, where(pl))}%`} width={W} height={d.height} />
      }
      return (
        <Box key={`${kp}plan-view-${keyOf(pl.id)}`} flexDirection="column">
          {planRows(pl, at, cols).map((r, i) => (
            <Text key={`${kp}plan-${keyOf(pl.id)}-${i}`} bold={r.kind === 'head'} dimColor={r.kind === 'note'} color={r.kind === 'bar' ? r.color : undefined} wrap="truncate-end">
              {r.line}
            </Text>
          ))}
        </Box>
      )
    }

    // The Plans tab's list.
    const plansSection = async (): Promise<RenderChildren> => {
      const planList = await readPlans($)
      if (!planList.length) return <Text dimColor>{s.noPlans}</Text>
      const clockNow = await $.clock.now()
      const clearPlans = planList.some(pl => pl.state === 'done') ? (
        <Button
          key="plans-clear"
          label="Clear finished"
          plain
          onPress={() => clearFinishedPlans($)}
        />
      ) : null
      if (Svg) {
        return (
          <Box key="plans-section" flexDirection="column" gap={1}>
            {planList.map(pl => planDrawing(pl, '', clockNow))}
            {clearPlans}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {planList.map(pl => planDrawing(pl, '', clockNow))}
          {clearPlans}
        </Box>
      )
    }

    const archiveWords: ArchiveWords = {
      tokensWord: s.tokensWord,
      untitled: s.untitled,
      noArchive: s.noArchive,
      trashEmpty: s.trashEmpty,
      loading: s.loading,
      couldNotRead: s.couldNotRead,
      fileMissing: s.fileMissing,
      showMore: s.showMore,
      trashAsk: s.trashAsk,
      trashTell: s.trashTell,
      moveToTrash: s.moveToTrash,
      restoreAsk: s.restoreAsk,
      restoreTell: s.restoreTell,
      restore: s.restore,
      cancel: s.cancel,
      emptyTrash: s.emptyTrash,
      emptyAsk: s.emptyAsk,
      emptyAskOne: s.emptyAskOne,
      erase: s.erase,
    }
    // The Archive or Trash tab: the list from its index; a group's file is read when it opens and let go when it folds.
    const archivePart = (list: 'archive' | 'trash') => async (): Promise<RenderChildren> => {
      const lists = await readLists($)
      return archiveSection({
        ui: { Box, Text, Button },
        Svg,
        W,
        cols,
        svg,
        fmt: { cost: fmtCost, tokens: fmtTokens, time: fmtTime },
        words: archiveWords,
        p,
        list,
        records: list === 'archive' ? lists.records : lists.trash,
        details: await readDetails($),
        warnings: lists.warnings,
        canMove: !!project,
        flowView,
        plan: planDrawing,
        on: {
          // A press records the user's choice, which wins over the default (the first group shown open).
          entry: async (rec, isOpen) => {
            const k = groupKey(list, rec.id)
            await updatePanel($, prev => ({ ...prev, openEntries: setIn(prev.openEntries, k, !isOpen), closedEntries: setIn(prev.closedEntries, k, isOpen) }))
            if (isOpen) await dropDetail($, list, rec.id)
            else await loadDetail($, list, rec)
          },
          ask: rec => updatePanel($, prev => ({ ...prev, confirm: { list, id: rec.id } })),
          confirm: rec => queueArchive(() => moveSession($, list === 'archive' ? 'trash' : 'archive', rec.id)),
          cancel: () => updatePanel($, prev => ({ ...prev, confirm: null })),
          askEmpty: () => updatePanel($, prev => ({ ...prev, confirm: { list: 'trash', id: '', all: true } })),
          empty: () => queueArchive(() => emptyTrashPress($)),
          more: async () => {
            await updatePanel($, prev => (list === 'archive' ? { ...prev, archiveLimit: prev.archiveLimit + ARCHIVE_PAGE } : { ...prev, trashLimit: prev.trashLimit + ARCHIVE_PAGE }))
            await loadOpenDetails($)
          },
        },
      })
    }

    // The Active or Finished tab: the flow's header (its totals; never its title), then its one list, always in full.
    // Without a flow or a run only the list's empty line.
    const drawFlow = async (rows: 'active' | 'finished'): Promise<RenderChildren> => {
      const list = await readAgents($)
      const f = await readFlow($)
      if (!f && list.length === 0) return <Text dimColor>{rows === 'active' ? s.nothingQueued : s.noFinished}</Text>
      const meta = await readMeta($)
      const at = Math.max(await readNow($), ...list.map(a => a.startedAt), 0)
      const planned = plannedOf(f, list)
      const t = totals(list, at)
      // Only an open flow's own finished rows.
      const archivableIds = new Set(f && !f.isFinished ? archivable(list, meta).map(a => a.id) : [])
      const view = flowView({
        kp: '',
        fp: '',
        list,
        tasks: f?.tasks ?? [],
        accepted: f ? acceptedOf(f) : [],
        acceptedAt: f?.acceptedAt,
        planned,
        at,
        t,
        rows,
        archive: { can: a => archivableIds.has(a.id), press: a => pressArchive($, a.id) },
      })
      if (Svg) return [view.header, view.body()]
      return [
        view.header,
        <Box flexDirection="column" marginTop={1}>
          {view.body()}
        </Box>,
      ]
    }
    // The flowdeck group: the tabs with their counts, then the selected tab's list alone. Each count is read on its own,
    // so one that fails only leaves its number out.
    const flowCount = await Promise.resolve()
      .then(async () => flowCounts(await readFlow($), await readAgents($)))
      .catch(() => null)
    const counts: Record<PanelTab, number | null> = {
      active: flowCount?.active ?? null,
      finished: flowCount?.finished ?? null,
      plans: await readPlans($).then(l => l.length, () => null),
      // The sessions each index lists in that tab (archive-index.ts `reconcile`).
      archive: await readLists($).then(l => l.records.length, () => null),
      trash: await readLists($).then(l => l.trash.length, () => null),
    }
    const tabs = await safe('Tabs', () => tabRow($, { Box, Text, Button }, p, counts, tabGap(e.surface)))
    const isFlowTab = p.tab === 'active' || p.tab === 'finished'
    const shown = isFlowTab
      ? await safe(TAB_LABEL[p.tab], () => drawFlow(p.tab === 'finished' ? 'finished' : 'active'))
      : await safe(TAB_LABEL[p.tab], p.tab === 'plans' ? plansSection : archivePart(p.tab === 'trash' ? 'trash' : 'archive'))
    const group = (
      <Box key="flowdeck-group" flexDirection="column" marginTop={1}>
        {tabs}
        {shown}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {topToggles}
        {bandLine}
        {liveLine}
        {contextSection}
        {usageSection}
        {group}
      </Box>
    )
  }).catch(async ($, e) => {
    // The worst case still draws the top buttons and the tabs (without counts) and says so: never a blank pane.
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await readPanel($).catch(() => asPanel(null))
    return (
      <Box flexDirection="column">
        {topToggleRow($, { Box, Text, Button }, p)}
        {tabRow($, { Box, Text, Button }, p, { active: null, finished: null, plans: null, archive: null, trash: null }, tabGap(e.surface))}
        <Text dimColor>flowdeck could not draw this panel</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await readFlow($)
    const hidden = (await readPanel($)).isBandHidden
    if (hidden || e.props.hasSurvey) return next(e)
    // the open plans, newest first, at most two rows below the flow row
    const open = [...(await readPlans($))].reverse().filter(pl => pl.state === 'running' || pl.state === 'needs_input' || pl.state === 'error').slice(0, 2)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const bandWidth = Math.max(180, Math.min(MAX_BAND_W, (e.props.bodyColumns || 100) * 9 - 180))
    // The prompt cache's chip, shown once the session made a request, with or without a flow (cache-view.tsx).
    const cache = await cacheBandPart($, { Box, Text, Button, Svg: e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null } as CacheUi, bandWidth)
    if (f === null && open.length === 0 && !cache) return next(e)

    // What other mods and Claude Code draw here stays, below this row; when that fails, the row is drawn without it.
    const theirs = await next(e).catch((): RenderChildren => null)
    const planNow = open.length ? await $.clock.now() : 0
    const planRowEls =
      e.surface !== 'terminal' && 'Svg' in ui
        ? open.map(pl => {
            const { Svg } = ui
            const d = planBandSvg(bandWidth, pl, planNow)
            return (
              <Box key={`flowdeck-plan-${keyOf(pl.id)}`} flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
                <Svg source={svg(bandWidth, d.height, d.body)} alt={planAlt(pl)} width={bandWidth} height={d.height} />
              </Box>
            )
          })
        : open.map(pl => (
            <Text key={`flowdeck-plan-${keyOf(pl.id)}`} color={STATE_COLOR[pl.state] ?? ACCENT} wrap="truncate-end">
              {planBandText(pl, e.props.bodyColumns)}
            </Text>
          ))
    if (f === null) {
      return (
        <Box flexDirection="column">
          {cache ? (
            <Box key="flowdeck-cache" flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
              {cache.row}
            </Box>
          ) : null}
          {cache?.card ?? null}
          {planRowEls}
          {theirs}
        </Box>
      )
    }
    const list = await readAgents($)
    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(isLive)
    // X/Y, the bar and the percent come from the rows the panel's tabs count (flowProgress).
    const g = shownFlow(f, list)
    const title = bandTitle(f, list)
    const crewButton = (
      <Button key="flowdeck-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(g) * 100)}%`
    const dismiss = (
      <Button
        key="flowdeck-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={async () => {
          await updatePanel($, p => ({ ...p, isBandHidden: true })) // hides the band only; the flow stays in the panel
        }}
      />
    )

    // The terminal's kit has an Svg too, drawn as an empty box: the terminal takes the text row, as the plan rows do.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 9 CSS px per reported column (measured in the desktop app; savvy-progress assumed 8 and stopped
      // short); the count, the dismiss and their gaps take the rest, so the row runs to the right edge like the other bars.
      // The cache chip, between the progress and the buttons, takes its own width from the progress.
      const width = Math.max(180, Math.min(MAX_BAND_W, (e.props.bodyColumns || 100) * 9 - 180) - (cache?.size ?? 0))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Svg source={rowSvg(g, width, isWorking, title)} alt={`${title}: ${label(g, true)}, ${percent}`} width={width} height={H} />
            {cache?.row ?? null}
            {crewButton}
            {dismiss}
          </Box>
          {cache?.card ?? null}
          {planRowEls}
          {theirs}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32 - (cache?.size ?? 0)))
    return (
      <Box flexDirection="column">
      <Box flexDirection="row" gap={2} flexShrink={1} minWidth={0} overflow="hidden">
        <Box width={titleW} flexShrink={0}>
          <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
          <Text wrap="truncate-end">{title}</Text>
        </Box>
        <Text color={f.isFinished ? DONE : ACCENT}>{barText(g, width)}</Text>
        <Text bold>{label(g, true)}</Text>
        <Text dimColor>{percent}</Text>
        {cache ? (
          <Box key="flowdeck-cache" flexDirection="row" gap={1} flexShrink={0}>
            {cache.row}
          </Box>
        ) : null}
        <Text color={CLAY}>▣</Text>
        {crewButton}
        {dismiss}
      </Box>
      {cache?.card ?? null}
      {planRowEls}
      {theirs}
      </Box>
    )
  }).catch(($, e, next) => {
    // A throw, a timeout or a tree the surface refused: never an error in the prompt area, but said once (noteFault).
    noteFault($, 'band', next.error?.message || next.error?.kind || '')
    return next(e)
  })
}
