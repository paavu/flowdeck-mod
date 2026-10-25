import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, ArchiveEntry, ArchiveVolume, Flow, Panel, Phase, PlannedTask, PlanStage, Reading, Samples, StepStatus, TaskPlan, UsageWindow } from '../types'
import { derive, finishItems, hasItemOps, ITEM_H, itemAlt, itemLine, itemsOf, itemSvg, stepItems } from './agent-items'
import type { StepInput } from './agent-items'
import { agentState, HOUSEKEEPING, splitHead, stateText } from './agent-state'
import { contextRows, contextSvg, toReading } from './context'
import { isWorthKeeping, snapshot, VOLUME_MAX } from './archive'
import { dataDir, getFile, loadLatest, parseJson, readVolume, saveToProject, saveToStore, writeData } from './archive-store'
import type { Io, Latest } from './archive-store'
import { ARCHIVE_PAGE, archiveSection, UNREADABLE } from './archive-view'
import type { FlowDrawing, FlowView, Planned } from './archive-view'
import { importPlan, isFinished, normalize, percent, PLAN_ID, placeBar, planId, STATUSES, str, where } from './plan'
import { planBandSvg, planBandText, planRows, planSvg, STATE_COLOR, stateLabel } from './plan-view'
import { record, toWindows, usageRows, usageSvg } from './usage'

const flow = atom({ plugin: 'flowdeck', key: 'flow' } as const, null)
const agents = atom({ plugin: 'flowdeck', key: 'agents' } as const, [])
const panel = atom({ plugin: 'flowdeck', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  isContextShown: true,
  isUsageShown: true,
  isPlansShown: true,
  isBandHidden: false,
  isArchiveShown: false,
  openEntries: [] as string[],
  openAgents: [] as string[],
  openFinished: [] as string[],
  archiveLimit: 10,
  archiveListOpen: false,
  archiveVolume: null as string | null,
  archiveError: '',
  archiveWarning: '',
  autoOpenedFor: '',
})
const usageState = atom({ plugin: 'flowdeck', key: 'usage' } as const, { windows: [] as UsageWindow[], samples: {} as Samples })
const reading = atom({ plugin: 'flowdeck', key: 'reading' } as const, null as Reading | null)
const now = atom({ plugin: 'flowdeck', key: 'now' } as const, 0)
const archive = atom({ plugin: 'flowdeck', key: 'archive' } as const, [] as ArchiveEntry[])
// The archive volumes of this project, newest first.
const volumes = atom({ plugin: 'flowdeck', key: 'volumes' } as const, [] as ArchiveVolume[])
const flowMeta = atom({ plugin: 'flowdeck', key: 'flowMeta' } as const, null as { startedAt: number; project: string } | null)
const plans = atom({ plugin: 'flowdeck', key: 'plans' } as const, [] as TaskPlan[])

const TOOL = 'mcp__flowdeck__progress'
const STEP_TOOL = 'mcp__flowdeck__step'
const PLAN_TOOL = 'mcp__flowdeck__plan'
const PLAN_RULE = `# Progress plans
A task needing more than ~3 edits or commands gets a plan via ${PLAN_TOOL}: create it once with the full breakdown (2-7 stages of steps {title}, or kind: "todo" for one flat list; titles of at most 4 words, in the user's language; one id per task; the first open step becomes active). Move it with short calls: {id, next:true}, {id, done:["A"], active:"B"}, {id, failed:"B", note}, {id, state:"needs_input", note} before asking the user, {id, state:"done"} to finish. When the plan changes, resend stages under the same id. During a /flowdeck flow, report the flow's tasks with ${TOOL}, not a second plan for the same work. No edit is ever blocked for lack of a plan.`
const PANE = 'flowdeck-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
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
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
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
  },
  ru: {
    pane: 'flowdeck',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
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
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]
// The session's working folder, the project an archive entry names; set the same way.
let project = ''
// The session the task plans are saved under; empty when the engine names none.
let sessionId = ''
// What one archive file stays under, in UTF-8 bytes (history.json rotates past it); FLOWDECK_ARCHIVE_VOLUME_MAX (or its old
// name FLOWDECK_HISTORY_SEGMENT_MAX) can only lower it (the tests use a small one).
let volumeMax = VOLUME_MAX

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

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const incoming = cleanTasks(input.tasks)
  // A linked flow never loses a task: a re-plan updates the tasks it names and adds the new ones.
  const planned = !incoming ? base.tasks : base.isLinked ? unionTasks(base.tasks, incoming) : incoming
  const known = new Set(planned.map(t => t.title.toLowerCase()))
  const fresh = (cleanTasks(input.add) ?? []).filter(t => !known.has(t.title.toLowerCase()) && known.add(t.title.toLowerCase()))
  const tasks = [...planned, ...fresh]
  const asked = Math.max(0, Math.round(input.total ?? (fresh.length && !input.tasks ? base.total + fresh.length : input.tasks ? tasks.length : base.total)))
  const total = base.isLinked ? Math.max(asked, tasks.length) : asked
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    isLinked: true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
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

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
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

  const text = label(f)
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
const isWorker = (type: string): boolean => /^(?:[^:]*:)?flowdeck-/.test(type)

const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^flowdeck-/, '').toLowerCase()
  return t in TIER_COLOR && bare.startsWith('flowdeck-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

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

// The tasks no run was started for, numbered in plan order.
const unstarted = (tasks: PlannedTask[], list: AgentRun[]): Planned[] => {
  const started = new Set(list.map(a => norm(a.description)))
  return tasks.map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => (!f || f.isFinished ? [] : unstarted(f.tasks ?? [], list))

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
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// A plan row's alt text in the band; the band's handler has its own `percent`.
const planAlt = (pl: TaskPlan): string => `${pl.title}: ${stateLabel(pl)}, ${percent(pl, where(pl))}%`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="${top + 16}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="${top + 33}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// The longest form of the stats that fits `room`: the time goes first, then the tokens, then the cost; ctx stays last.
const fitStats = (a: AgentRun, at: number, gap: string, room: number, width: (s: string) => number): string => {
  const ctx = `ctx ${ctxOf(a)}%`
  const tokens = `${ctx} · ${fmtTokens(a.contextTokens)}`
  const cost = `≈${fmtCost(a.costUsd)}`
  const forms = [`${tokens}${gap}${cost}${gap}${fmtTime(elapsed(a, at))}`, `${tokens}${gap}${cost}`, `${ctx}${gap}${cost}`, ctx]
  return forms.find(f => width(f) <= room) ?? ''
}

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const tierWord = tier === 'other' ? a.type : tier
  // The stats share the model line, right-aligned; the meta keeps its room first.
  const stats = fitStats(a, at, '  ', barW - textWidth(`${tierWord}  ${meta.join('  ·  ')}`, 11) - 12, t => textWidth(t, 11))
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = barW
  // The state leads the line in its colour; the reported steps follow it.
  const state = agentState(a)
  const head = stateText(a)
  const [lead, rest] = splitHead(fitText(steps ? `${head} · ${steps}` : head, 11, stepsW), head)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, costumeOf(a.type), false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tierWord)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${stats ? `<text class="s" x="${42 + barW}" y="34" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>` : ''}
${stepsW > 30 ? `<text x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums"><tspan fill="${state.color}">${xml(lead)}</tspan>${rest ? `<tspan class="t">${xml(rest)}</tspan>` : ''}</text>` : ''}
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${state.color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [TIER_MODEL[tier] ?? '']
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, tier, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: 'running', dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: a.status, dim: false })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.dim, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Asks the engine for /context's breakdown (estimated locally, no token-count calls) and the rate-limit windows, in one call.
async function refreshContext($: EngineInterface): Promise<void> {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  if (b && b.rawMaxTokens > 0) await update($, reading, () => toReading(b)) // otherwise there is no window to measure against
  const windows = toWindows(Array.isArray(u.rateLimits) ? u.rateLimits : [])
  const at = await $.clock.now()
  await update($, usageState, prev => ({ windows, samples: record(prev.samples, windows, at) }))
}

type TodoItem = { title: string; completed: boolean }

// A linked flow takes the session task list's items as planned tasks (medium tier, display only) and counts one done when the list completes it.
async function mirrorTasks($: EngineInterface, items: TodoItem[]): Promise<void> {
  if (!items.length) return
  await update($, flow, prev => {
    if (!prev || !prev.isLinked || prev.isFinished) return prev
    const tasks = [...prev.tasks]
    let total = prev.total
    let done = prev.done
    for (const item of items) {
      const at = tasks.findIndex(t => t.title.toLowerCase() === item.title.toLowerCase())
      if (at < 0) {
        tasks.push({ title: item.title, tier: 'medium', after: [], mirrored: true, counted: item.completed })
        total++
        if (item.completed) done++
      } else if (tasks[at]!.mirrored && item.completed && !tasks[at]!.counted) {
        tasks[at] = { ...tasks[at]!, counted: true }
        done++
      }
    }
    return { ...prev, tasks, total, done: Math.min(total, done) }
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
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
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
})

// Without a project folder, or when the project files cannot take it, the save goes to the shared store as before.
// Only the latest part's view takes the entry; a volume being shown stays as it is.
async function saveArchive($: EngineInterface, entry: ArchiveEntry): Promise<void> {
  if (!isWorthKeeping(entry)) return
  const isLatest = async (): Promise<boolean> => (await read($, panel)).archiveVolume == null
  let view: ArchiveEntry[] | null = null
  if (project) {
    const saved = await saveToProject(io($), project, volumeMax, entry).catch(() => null)
    const vols = saved?.volumes
    if (vols) await update($, volumes, () => vols)
    if (saved) await update($, panel, prev => ({ ...prev, archiveWarning: saved.isUnreadable ? UNREADABLE : '' }))
    if (saved?.isSaved) {
      if (await isLatest()) await update($, archive, () => saved.latest)
      return
    }
    view = saved?.latest ?? null
  }
  const next = await saveToStore(io($), entry, () => read($, archive))
  if (await isLatest()) await update($, archive, () => view ?? next)
}

type Meta = { startedAt: number; project: string }
const isSameMeta = (a: Meta | null, b: Meta | null): boolean => !!a && !!b && a.startedAt === b.startedAt && a.project === b.project

// Saves the flow as it stands, or as `at` captured it (its record's meta and agents); returns the meta the record used, null
// when it could not be saved. Never throws into the tool call or the turn that asked.
async function recordFlow($: EngineInterface, f: Flow, status: 'finished' | 'open', at?: { meta: Meta | null; agents: AgentRun[] }): Promise<Meta | null> {
  try {
    const endedAt = await $.clock.now()
    let meta = at ? at.meta : await read($, flowMeta)
    const isFresh = !meta
    if (!meta) {
      // A flow no progress call created (a worker launch): it starts its record now, under one id from here on.
      const fresh = { startedAt: endedAt, project }
      meta = fresh
      await update($, flowMeta, m => m ?? fresh)
    }
    const start = meta.startedAt
    // Only the agents that began during this flow: one still running from the flow before is counted there.
    const list = (at ? at.agents : await read($, agents)).filter(a => isFresh || a.startedAt >= start)
    await saveArchive($, snapshot({ flow: f, agents: list, project: meta.project, startedAt: meta.startedAt, endedAt, status }))
    return meta
  } catch {
    // A failing store or clock costs the record, not the call.
    return null
  }
}

// Ends the flow with the input's last fields: one finished record, then whatever comes next starts a new one. The flow's
// meta and agents are taken first, so a restart meanwhile neither renames this record nor loses the new flow's meta; a
// second finish (the button and the tool at once) finds the flow finished and records nothing.
async function finishFlow($: EngineInterface, input: ProgressInput = {}): Promise<Flow | null> {
  const meta = await read($, flowMeta)
  const list = await read($, agents)
  let isEnding = false
  const next = await update($, flow, p => {
    isEnding = !p?.isFinished
    return isEnding ? merge(p, { ...input, finished: true }) : p
  })
  if (next && isEnding) {
    const used = (await recordFlow($, next, 'finished', { meta, agents: list })) ?? meta
    await update($, flowMeta, m => (isSameMeta(m, used) ? null : m))
  }
  return next
}

// The Finish buttons: only an open flow is ended, so a press on a stale row does nothing.
async function finishOpenFlow($: EngineInterface): Promise<void> {
  const f = await read($, flow)
  if (f && !f.isFinished) await finishFlow($)
}

type SavedPlans = Record<string, TaskPlan[]>

const isStoredStep = (st: unknown): boolean =>
  !!st && typeof st === 'object' && typeof (st as { title?: unknown }).title === 'string' && STATUSES.includes((st as { status?: unknown }).status as StepStatus)

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
  const list = await read($, plans)
  const isOpen = (p: TaskPlan) => p.state === 'running' && p.stages.some(s => s.steps.length) && p.stages.every(s => s.steps.every(st => isFinished(st.status)))
  if (!list.some(isOpen)) return
  const at = await $.clock.now()
  const next = await update($, plans, prev => prev.map(p => (isOpen(p) ? { ...p, state: 'done' as const, endedAt: at } : p)))
  await savePlans($, next)
}

const planLine = (p: TaskPlan): string => {
  const w = where(p)
  const active = p.stages.flatMap(s => s.steps).find(st => st.status === 'active')
  return `${p.id}: ${w.pos}/${w.total}, ${p.state}${active ? `, active "${active.title}"` : ''}`
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
  await update($, agents, list => {
    const at = list.findIndex(a => a.agentId === agentId && a.status === 'running')
    const run = list[at]
    if (!run || (run.tool === tool && !!run.isAsked === isAsked)) return list
    const next = [...list]
    next[at] = { ...run, tool, isAsked }
    return next
  })
  shown.set(agentId, { tool, isAsked }) // an agent the panel does not list is skipped the same way
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language).catch((): Lang => 'en')
    project = typeof e.cwd === 'string' ? e.cwd : ''
    // The new name wins when both are set; the old one keeps working.
    const named: unknown = await Promise.resolve()
      .then(() => $.env.get('FLOWDECK_ARCHIVE_VOLUME_MAX'))
      .catch(() => undefined)
    const old: unknown =
      named != null && named !== ''
        ? undefined
        : await Promise.resolve()
            .then(() => $.env.get('FLOWDECK_HISTORY_SEGMENT_MAX'))
            .catch(() => undefined)
    const max = Number(named != null && named !== '' ? named : old)
    volumeMax = max > 0 && max < VOLUME_MAX ? max : VOLUME_MAX
    const stored = await $.store.get('contextShown').catch(() => undefined)
    if (typeof stored === 'boolean') await update($, panel, prev => ({ ...prev, isContextShown: stored }))
    const storedUsage = await $.store.get('usageShown').catch(() => undefined)
    if (typeof storedUsage === 'boolean') await update($, panel, prev => ({ ...prev, isUsageShown: storedUsage }))
    const storedPlansShown = await $.store.get('plansShown').catch(() => undefined)
    if (typeof storedPlansShown === 'boolean') await update($, panel, prev => ({ ...prev, isPlansShown: storedPlansShown }))
    const storedArchiveShown = await $.store.get('historyShown').catch(() => undefined)
    if (typeof storedArchiveShown === 'boolean') await update($, panel, prev => ({ ...prev, isArchiveShown: storedArchiveShown }))
    // The project's latest part, with this project's entries from the shared store merged in.
    const loaded = await loadLatest(io($), project).catch((): Latest => ({ entries: [], volumes: [], isUnreadable: false }))
    await update($, archive, () => loaded.entries)
    await update($, volumes, () => loaded.volumes)
    await update($, panel, prev => ({ ...prev, archiveListOpen: false, archiveVolume: null, archiveError: '', archiveWarning: loaded.isUnreadable ? UNREADABLE : '' }))
    const sid = (started as { sessionId?: unknown }).sessionId
    sessionId = (await currentSessionId($)) || (typeof sid === 'string' ? sid : '')
    if (sessionId) {
      const mine = await loadPlans($).catch((): TaskPlan[] => [])
      await update($, plans, () => mine)
    }
    void refreshContext($).catch(() => {})
    await $.tool.register({
      name: 'progress',
      description:
        'Report /flowdeck progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), phase "close" when the current work is done, and finished: true only when the user ends the flow. ' +
        'For a new /flowdeck <task> while a flow is linked, send the new plan with restart: true: the open flow is finished first and the new one starts. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
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
              },
              required: ['title'],
            },
          },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
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

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  // The rule is added to whatever the engine and other mods composed; a failure below is not masked (that would replace the real prompt with ours alone).
  on('prompt.compose', async ($, e, next) => {
    const rule = { id: 'flowdeck:plan-rule', text: PLAN_RULE, scope: 'session' as const }
    const result = await next(e)
    return { sections: [...result.sections, rule] }
  })

  on('command.run', { command: 'flowdeck-agents' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    let prev = await read($, flow)
    // Finishing a flow that is already finished changes nothing; it would otherwise open a blank one.
    if (prev?.isFinished && input.finished === true) return { result: `ok: ${label(prev)}` }
    // A restart ends the open flow as Finish does; the rest of the input then starts the new one.
    if (input.restart === true && prev && !prev.isFinished) prev = await finishFlow($)
    if (isNewFlow(prev, input)) {
      // The flow being replaced goes to the archive first, with its own agents; a finished one is there already.
      if (prev && !prev.isFinished) await recordFlow($, prev, 'finished')
      // Without a clock the record starts when the flow is saved, as for a flow no progress call created.
      const startedAt: number | null = await Promise.resolve()
        .then(() => $.clock.now())
        .catch(() => null)
      await update($, flowMeta, () => (startedAt === null ? null : { startedAt, project }))
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = input.finished === true ? await finishFlow($, input) : await update($, flow, p => merge(p, input))
    if (isNewFlow(prev, input)) {
      await update($, panel, p => ({ ...p, isBandHidden: false })) // a new flow brings the band back
    }
    if (next && (input.tasks?.length || input.add?.length)) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A linked flow takes every task the session adds: the model's task list items are mirrored as planned tasks.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await mirrorTasks($, todoItems((e as unknown as { todos?: unknown }).todos)).catch(() => {}) // a worker's own steps are not session tasks
    return result
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    const input = e as unknown as { subject?: unknown; title?: unknown }
    const title = typeof input.subject === 'string' ? input.subject.trim() : typeof input.title === 'string' ? input.title.trim() : ''
    if (!e.agentId && title) await mirrorTasks($, [{ title, completed: false }]).catch(() => {})
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
      await update($, agents, list =>
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
      const list = await read($, plans)
      const made = normalize(input, list.find(p => p.id === id) ?? null, await $.clock.now(), id)
      if (typeof made === 'string') return { result: 'flowdeck plan: ' + made }
      const placed = await update($, plans, prev => placeBar(prev, made))
      await savePlans($, placed)
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
      const list = await read($, plans)
      const made = importPlan(text, list.find(p => p.id === PLAN_ID) ?? null, await $.clock.now())
      if (!made) return ran
      const placed = await update($, plans, prev => placeBar(prev, made))
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
      const live = (await read($, plans)).filter(p => p.state === 'running').pop()
      if (live) {
        waiting = live.id
        await savePlans($, await update($, plans, list => list.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const, note } : p))))
      }
    } catch {
      // A failing store costs the waiting mark, not the question.
    }
    const ran = await next(e)
    if (waiting) {
      try {
        const id = waiting
        await savePlans($, await update($, plans, list => list.map(p => (p.id === id && p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p))))
      } catch {
        // as above
      }
    }
    return ran
  })

  // The user's own prompt (typed, or sent from the phone over Remote Control) answers whatever a plan was waiting on.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') {
      try {
        if ((await read($, plans)).some(p => p.state === 'needs_input')) {
          await savePlans($, await update($, plans, list => list.map(p => (p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p))))
        }
      } catch {
        // A failing store costs the reset, not the prompt.
      }
    }
    return next(e)
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!isWorker(type)) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
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
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'flowdeck')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
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
      await update($, agents, list =>
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
    const result = await next(e)
    if (!agentId) await refreshContext($).catch(() => {}) // a subagent's turn fills its own window, not this one
    if (!agentId) await closeFinishedPlans($).catch(() => {})
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && 'messages' in result) void refreshContext($).catch(() => {}) // a /compact empties the window without a turn ending
    return result
  })

  // A flow still open when the session ends is kept as open; finishing it later updates the same entry.
  on('session.end', async ($, e, next) => {
    const f = await read($, flow).catch(() => null)
    if (f && !f.isFinished) await recordFlow($, f, 'open')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const rd = await read($, reading)
    const us = await read($, usageState)
    const archiveList = await read($, archive)
    const volumeList = await read($, volumes)
    const planList = await read($, plans)
    const clockNow = await $.clock.now()
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleContext = (
      <Button
        key="context"
        label={`${p.isContextShown ? '▾' : '▸'} Context`}
        plain
        onPress={async () => {
          const shown = !p.isContextShown
          await update($, panel, prev => ({ ...prev, isContextShown: shown }))
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
          await update($, panel, prev => ({ ...prev, isUsageShown: shown }))
          await $.store.set('usageShown', shown).catch(() => {})
        }}
      />
    )
    const togglePlans = (
      <Button
        key="plans"
        label={`${p.isPlansShown ? '▾' : '▸'} Plans`}
        plain
        onPress={async () => {
          const shown = !p.isPlansShown
          await update($, panel, prev => ({ ...prev, isPlansShown: shown }))
          await $.store.set('plansShown', shown).catch(() => {})
        }}
      />
    )
    const clearPlans = planList.some(pl => pl.state === 'done') ? (
      <Button
        key="plans-clear"
        label="Clear finished"
        plain
        onPress={async () => {
          const next = await update($, plans, prev => prev.filter(pl => pl.state !== 'done'))
          await savePlans($, next)
        }}
      />
    ) : null
    const toggleBand = (
      <Button
        key="band"
        label={`${p.isBandHidden ? '▸' : '▾'} Band`}
        plain
        onPress={async () => {
          const hidden = !p.isBandHidden
          await update($, panel, prev => ({ ...prev, isBandHidden: hidden }))
        }}
      />
    )
    const toggleArchive = (
      <Button
        key="archive"
        label={`${p.isArchiveShown ? '▾' : '▸'} Archive`}
        plain
        onPress={async () => {
          const shown = !p.isArchiveShown
          await update($, panel, prev => ({ ...prev, isArchiveShown: shown }))
          await $.store.set('historyShown', shown).catch(() => {}) // the store key keeps its name from before the rename
        }}
      />
    )
    const topToggles = (
      <Box key="top-toggles" flexDirection="row" gap={1}>
        {toggleContext}
        {toggleUsage}
        {togglePlans}
        {toggleBand}
        {toggleArchive}
      </Box>
    )
    const finishFlowButton = f && !f.isFinished ? <Button key="flow-finish" label="Finish flow" plain onPress={() => finishOpenFlow($)} /> : null
    const toggles = finishFlowButton ? (
      <Box key="title-controls" flexDirection="row" gap={1}>
        {finishFlowButton}
        {toggleCompact}
      </Box>
    ) : (
      toggleCompact
    )
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`
    // An agent that reported its steps folds them out under its row; open only in this session.
    // `fp` prefixes an archive group's fold state (`<entryId>:<agentId>`), so folding a row there never folds the live one.
    const isUnfolded = (a: AgentRun, fp = '') => (p.openAgents ?? []).includes(fp + a.id)
    // `kp` prefixes the keys of an archive group's rows, so they never share a key with the live ones.
    const foldButton = (a: AgentRun, kp = '', fp = '') => (
      <Button
        key={`${kp}agent-fold-${a.id}`}
        label={isUnfolded(a, fp) ? '▾' : '▸'}
        plain
        onPress={() =>
          update($, panel, prev => {
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

    // One flow as the panel draws it, live or from the archive (FlowView in archive-view.tsx says what it takes).
    const flowView = (v: FlowView): FlowDrawing => {
      const { kp, fp, at } = v
      const running = v.list.filter(a => a.status === 'running').reverse()
      const finished = v.list.filter(a => a.status !== 'running').reverse()
      const isEmpty = v.list.length === 0 && v.planned.length === 0
      const toggleDone = (
        <Button key={v.doneKey} label={`${v.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`} plain onPress={v.onDone} />
      )
      if (Svg) {
        const viewSummary = `≈${fmtCost(v.t.cost)}, ${fmtTokens(v.t.tokens)} ${s.tokensWord}, ${fmtTime(v.t.time)}`
        const section = (key: string, text: string) => (
          <Text key={key} dimColor>
            {text}
          </Text>
        )
        // With items the row leaves room for its chevron on the right; its children are drawn as wide as it.
        const agentRow = (a: AgentRun, word: string) => {
          const alt = `${a.description}: ${modelName(a.model)}, ${word}`
          const items = itemsOf(a.items)
          if (!items.length) return <Svg key={`${kp}${a.id}`} source={agentSvg(W, a, at)} alt={alt} width={W} height={66} />
          const rowW = W - 28
          return (
            <Box key={`${kp}${a.id}`} flexDirection="column">
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Svg source={agentSvg(rowW, a, at)} alt={alt} width={rowW} height={66} />
                {foldButton(a, kp, fp)}
              </Box>
              {isUnfolded(a, fp) &&
                items.map((it, i) => (
                  <Svg key={`${kp}agent-item-${a.id}-${i}`} source={svg(rowW, ITEM_H, itemSvg(rowW, it, at, fitText))} alt={itemAlt(it, at)} width={rowW} height={ITEM_H} />
                ))}
            </Box>
          )
        }
        return {
          header: [
            <Svg source={headerSvg(W, v.title, v.t)} alt={v.title ? `${v.title}: ${viewSummary}` : viewSummary} width={W} height={headerHeight(v.title)} />,
            v.controls,
          ],
          body: () => [
            isEmpty && <Text dimColor>{s.empty}</Text>,
            running.length > 0 && section(`${kp}h-run`, `${s.running} · ${running.length}`),
            running.map(a => agentRow(a, s.isRunning)),
            finished.length > 0 && toggleDone,
            !v.isDoneCollapsed && finished.map(a => agentRow(a, s.isFinished)),
            v.planned.length > 0 && section(`${kp}h-plan`, `${s.planned} · ${v.planned.length}`),
            v.planned.map(pl => (
              <Svg key={`${kp}plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
            )),
          ],
        }
      }
      const row = (a: AgentRun) => {
        const tier = tierOf(a.type)
        const color = colorOf(tier)
        const ctx = ctxOf(a)
        const progress = progressOf(a)
        const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
        const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''}` : ''
        const modelLine = `  ${tier === 'other' ? a.type : tier} · ${model}${a.round > 1 ? ` · ${s.round} ${a.round}` : ''}`
        // The stats end the model line when they fit there, else they are left out.
        const stats = fitStats(a, at, ' ', cols - modelLine.length - 3, t => t.length)
        // The state leads the line in its colour, cut only at the row's width.
        const state = agentState(a)
        const head = stateText(a)
        const room = Math.max(state.name.length + 1, cols - 2 - barW - 1)
        const [lead, rest] = splitHead(clip(steps ? `${head} · ${steps}` : head, room), head)
        const items = itemsOf(a.items)
        return (
          <Box key={`${kp}${a.id}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={color}>▣</Text>
              <Text bold wrap="truncate-end">
                {a.description || a.type}
              </Text>
              <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
              {items.length > 0 && foldButton(a, kp, fp)}
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
          </Box>
        )
      }
      return {
        header: [
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold wrap="truncate-end">
              {v.title}
            </Text>
            {v.controls}
          </Box>,
          <Text dimColor>
            ≈{fmtCost(v.t.cost)} · {fmtTokens(v.t.tokens)} {s.tokensWord} · {fmtTime(v.t.time)}
          </Text>,
        ],
        body: () => [
          isEmpty && <Text dimColor>{s.empty}</Text>,
          running.length > 0 && (
            <Text dimColor>
              {s.running} · {running.length}
            </Text>
          ),
          running.map(row),
          finished.length > 0 && toggleDone,
          !v.isDoneCollapsed && finished.map(row),
          v.planned.length > 0 && (
            <Text dimColor>
              {s.planned} · {v.planned.length}
            </Text>
          ),
          v.planned.map(pl => {
            const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
            return (
              <Box key={`${kp}plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                <Text dimColor wrap="truncate-end">
                  <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                </Text>
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {tier} · {TIER_MODEL[tier] ?? ''}
                  {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                </Text>
              </Box>
            )
          }),
        ],
      }
    }

    const toggleIn = (ids: string[] | undefined, id: string): string[] => {
      const open = ids ?? []
      return open.includes(id) ? open.filter(x => x !== id) : [...open, id]
    }
    // Browsing only reads: a volume's entries replace the shown ones, Back to latest reads history.json again.
    const openVolume = async (file: string) => {
      const a = project ? await readVolume(io($), dataDir(project), file) : null
      if (!a) {
        await update($, panel, prev => ({ ...prev, archiveError: file }))
        return
      }
      await update($, archive, () => a.entries)
      await update($, panel, prev => ({ ...prev, archiveVolume: file, archiveListOpen: false, archiveError: '', archiveLimit: ARCHIVE_PAGE }))
    }
    const backToLatest = async () => {
      const loaded = await loadLatest(io($), project).catch(() => null)
      if (!loaded) return
      await update($, archive, () => loaded.entries)
      await update($, volumes, () => loaded.volumes)
      await update($, panel, prev => ({ ...prev, archiveVolume: null, archiveError: '', archiveWarning: loaded.isUnreadable ? UNREADABLE : '', archiveLimit: ARCHIVE_PAGE }))
    }
    const archivePart = archiveSection({
      ui: { Box, Text, Button },
      Svg,
      W,
      svg,
      fmt: { cost: fmtCost, tokens: fmtTokens, time: fmtTime },
      tokensWord: s.tokensWord,
      p,
      entries: archiveList,
      volumes: volumeList,
      flowView,
      unstarted,
      on: {
        entry: id => update($, panel, prev => ({ ...prev, openEntries: toggleIn(prev.openEntries, id) })),
        finished: id => update($, panel, prev => ({ ...prev, openFinished: toggleIn(prev.openFinished, id) })),
        list: () => update($, panel, prev => ({ ...prev, archiveListOpen: !prev.archiveListOpen, archiveError: '' })),
        volume: openVolume,
        latest: backToLatest,
        more: () => update($, panel, prev => ({ ...prev, archiveLimit: (prev.archiveLimit ?? ARCHIVE_PAGE) + ARCHIVE_PAGE })),
      },
    })
    const live = (): ReturnType<typeof flowView> =>
      flowView({
        kp: '',
        fp: '',
        title,
        list,
        planned,
        at,
        t,
        isDoneCollapsed: p.isDoneCollapsed,
        doneKey: 'done',
        onDone: () => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed })),
        controls: toggles,
      })

    if (Svg) {
      const dc = rd ? contextSvg(W, rd, !p.isContextShown) : null
      const contextSection = dc && rd ? (
        <Svg source={svg(W, dc.height, dc.body)} alt={`context ${rd.percent}%`} width={W} height={dc.height} />
      ) : (
        <Text dimColor>no context data yet</Text>
      )

      const du = us.windows.length ? usageSvg(W, us.windows, us.samples, clockNow) : null
      const usageSection = !p.isUsageShown ? null : du ? (
        <Svg source={svg(W, du.height, du.body)} alt={us.windows.map(w => `${w.label} ${Math.max(0, 100 - w.percent)}% left`).join(', ')} width={W} height={du.height} />
      ) : (
        <Text dimColor>no usage data yet</Text>
      )

      const plansSection = !p.isPlansShown ? null : planList.length ? (
        <Box key="plans-section" flexDirection="column" gap={1}>
          {planList.map(pl => {
            const d = planSvg(W, pl, clockNow)
            return <Svg key={`plan-view-${pl.id}`} source={svg(W, d.height, d.body)} alt={`${pl.title}: ${stateLabel(pl)}, ${percent(pl, where(pl))}%`} width={W} height={d.height} />
          })}
          {clearPlans}
        </Box>
      ) : (
        <Text dimColor>no plans yet</Text>
      )

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, planned, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {topToggles}
            {contextSection}
            {usageSection}
            {plansSection}
            {toggles}
            {archivePart}
          </Box>
        )
      }
      const view = live()
      return (
        <Box flexDirection="column">
          {topToggles}
          {contextSection}
          {usageSection}
          {plansSection}
          {view.header}
          {view.body()}
          {archivePart}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const contextSection = rd && cols >= 20 ? (
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
    const usageSection = !p.isUsageShown ? null : us.windows.length ? (
      <Box flexDirection="column">
        {usageRows(us.windows, us.samples, clockNow, cols).map((r, i) => (
          <Text key={`use-${i}`} dimColor={r.kind !== 'bar'} color={r.kind === 'bar' ? (r.over ? 'red' : us.windows[r.window]?.kind === 'seven_day' ? 'blue' : 'yellow') : undefined} wrap="truncate-end">
            {r.line}
          </Text>
        ))}
      </Box>
    ) : (
      <Text dimColor>no usage data yet</Text>
    )
    const plansSection = !p.isPlansShown ? null : planList.length ? (
      <Box flexDirection="column">
        {planList.map(pl => (
          <Box key={`plan-view-${pl.id}`} flexDirection="column">
            {planRows(pl, clockNow, cols).map((r, i) => (
              <Text key={`plan-${pl.id}-${i}`} bold={r.kind === 'head'} dimColor={r.kind === 'note'} color={r.kind === 'bar' ? r.color : undefined} wrap="truncate-end">
                {r.line}
              </Text>
            ))}
          </Box>
        ))}
        {clearPlans}
      </Box>
    ) : (
      <Text dimColor>no plans yet</Text>
    )
    const view = live()
    return (
      <Box flexDirection="column">
        {topToggles}
        {contextSection}
        {usageSection}
        {plansSection}
        {view.header}
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {view.body()}
          </Box>
        )}
        {archivePart}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    const hidden = (await read($, panel)).isBandHidden
    if (hidden || e.props.hasSurvey) return next(e)
    // the open plans, newest first, at most two rows below the flow row
    const open = [...(await read($, plans))].reverse().filter(pl => pl.state === 'running' || pl.state === 'needs_input' || pl.state === 'error').slice(0, 2)
    if (f === null && open.length === 0) return next(e)

    const theirs = await next(e) // what other mods and Claude Code draw here stays, below this row
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const planNow = open.length ? await $.clock.now() : 0
    const bandWidth = Math.max(180, Math.min(MAX_BAND_W, (e.props.bodyColumns || 100) * 9 - 180))
    const planRowEls =
      e.surface !== 'terminal' && 'Svg' in ui
        ? open.map(pl => {
            const { Svg } = ui
            const d = planBandSvg(bandWidth, pl, planNow)
            return (
              <Box key={`flowdeck-plan-${pl.id}`} flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
                <Svg source={svg(bandWidth, d.height, d.body)} alt={planAlt(pl)} width={bandWidth} height={d.height} />
              </Box>
            )
          })
        : open.map(pl => (
            <Text key={`flowdeck-plan-${pl.id}`} color={STATE_COLOR[pl.state] ?? ACCENT} wrap="truncate-end">
              {planBandText(pl, e.props.bodyColumns)}
            </Text>
          ))
    if (f === null) {
      return (
        <Box flexDirection="column">
          {planRowEls}
          {theirs}
        </Box>
      )
    }
    const list = await read($, agents)
    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="flowdeck-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const finish = f.isFinished ? null : <Button key="flowdeck-finish" label="Finish" plain onPress={() => finishOpenFlow($)} />
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="flowdeck-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={async () => {
          await update($, panel, p => ({ ...p, isBandHidden: true })) // hides the band only; the flow stays in the panel
        }}
      />
    )

    if ('Svg' in ui) {
      const { Svg } = ui
      // About 9 CSS px per reported column (measured in the desktop app; savvy-progress assumed 8 and stopped
      // short); the count, the dismiss and their gaps take the rest, so the row runs to the right edge like the other bars.
      const width = Math.max(180, Math.min(MAX_BAND_W, (e.props.bodyColumns || 100) * 9 - 180))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
            {crewButton}
            {finish}
            {dismiss}
          </Box>
          {planRowEls}
          {theirs}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="column">
      <Box flexDirection="row" gap={2} flexShrink={1} minWidth={0} overflow="hidden">
        <Box width={titleW} flexShrink={0}>
          <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
          <Text wrap="truncate-end">{f.title}</Text>
        </Box>
        <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
        <Text bold>{label(f)}</Text>
        <Text dimColor>{percent}</Text>
        <Text color={CLAY}>▣</Text>
        {crewButton}
        {finish}
        {dismiss}
      </Box>
      {planRowEls}
      {theirs}
      </Box>
    )
  })
}
