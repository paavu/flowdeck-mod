import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, HistoryEntry, Panel, Phase, PlannedTask, Reading, Samples, TaskPlan, UsageWindow } from '../types'
import { agentState, HOUSEKEEPING, splitHead, stateText } from './agent-state'
import { contextRows, contextSvg, toReading } from './context'
import { addEntry, formatEntry, parseHistory, snapshot } from './history'
import { importPlan, isFinished, normalize, percent, PLAN_ID, placeBar, planId, str, where } from './plan'
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
  isHistoryShown: false,
  openEntries: [] as string[],
  autoOpenedFor: '',
})
const usageState = atom({ plugin: 'flowdeck', key: 'usage' } as const, { windows: [] as UsageWindow[], samples: {} as Samples })
const reading = atom({ plugin: 'flowdeck', key: 'reading' } as const, null as Reading | null)
const now = atom({ plugin: 'flowdeck', key: 'now' } as const, 0)
const history = atom({ plugin: 'flowdeck', key: 'history' } as const, [] as HistoryEntry[])
const flowMeta = atom({ plugin: 'flowdeck', key: 'flowMeta' } as const, null as { startedAt: number; project: string } | null)
const plans = atom({ plugin: 'flowdeck', key: 'plans' } as const, [] as TaskPlan[])

const TOOL = 'mcp__flowdeck__progress'
const STEP_TOOL = 'mcp__flowdeck__step'
const PLAN_TOOL = 'mcp__flowdeck__plan'
const PLAN_SESSIONS = 20
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
// The session's working folder, the project a history entry names; set the same way.
let project = ''
// The session the task plans are saved under; empty when session.start named none.
let sessionId = ''

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

// `flowdeck-careful`, or `flowdeck:flowdeck-careful` when the agents ship in a plugin.
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

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
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
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
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
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tier)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${stepsW > 30 ? `<text x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums"><tspan fill="${state.color}">${xml(lead)}</tspan>${rest ? `<tspan class="t">${xml(rest)}</tspan>` : ''}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
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

// Re-reads the stored history first: another session may have saved since. When the read
// fails, only this session's view is updated, so a passing outage never overwrites the store.
async function saveHistory($: EngineInterface, entry: HistoryEntry): Promise<void> {
  let base: HistoryEntry[]
  let isRead = true
  try {
    base = parseHistory(await $.store.get('history'))
  } catch {
    base = await read($, history)
    isRead = false
  }
  const next = addEntry(base, entry)
  if (next === base) return
  if (isRead) await $.store.set('history', next).catch(() => {})
  await update($, history, () => next)
}

// Saves the flow as it stands; never throws into the tool call or the turn that asked.
async function recordFlow($: EngineInterface, f: Flow, status: 'finished' | 'open'): Promise<void> {
  try {
    const endedAt = await $.clock.now()
    let meta = await read($, flowMeta)
    if (!meta) {
      // A flow no progress call created (a worker launch): it starts its record now, under one id from here on.
      const fresh = { startedAt: endedAt, project }
      meta = fresh
      await update($, flowMeta, () => fresh)
    }
    const list = await read($, agents)
    await saveHistory($, snapshot({ flow: f, agents: list, project: meta.project, startedAt: meta.startedAt, endedAt, status }))
  } catch {
    // A failing store or clock costs the record, not the call.
  }
}

type SavedPlans = Record<string, TaskPlan[]>

// The stored plans by session; anything that is not an object of plan arrays reads as empty.
function parsePlans(v: unknown): SavedPlans {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: SavedPlans = {}
  for (const [sid, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const valid = list.filter(
      (p): p is TaskPlan => !!p && typeof p === 'object' && typeof p.id === 'string' && Array.isArray(p.stages) && typeof p.startedAt === 'number',
    )
    if (valid.length) out[sid] = valid
  }
  return out
}

const newest = (list: TaskPlan[]) => Math.max(...list.map(p => p.startedAt))

// Re-reads the store first so other sessions' plans stay; a failed read skips the write rather than overwrite them.
async function savePlans($: EngineInterface, list: TaskPlan[]): Promise<void> {
  if (!sessionId) return
  try {
    const all = parsePlans(await $.store.get('plans'))
    if (list.length) all[sessionId] = list
    else delete all[sessionId]
    const kept = Object.entries(all)
      .sort((a, b) => newest(b[1]) - newest(a[1]))
      .slice(0, PLAN_SESSIONS)
    await $.store.set('plans', Object.fromEntries(kept)).catch(() => {})
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
    lang = await detectLang($, options.language)
    project = typeof e.cwd === 'string' ? e.cwd : ''
    const stored = await $.store.get('contextShown').catch(() => undefined)
    if (typeof stored === 'boolean') await update($, panel, prev => ({ ...prev, isContextShown: stored }))
    const storedUsage = await $.store.get('usageShown').catch(() => undefined)
    if (typeof storedUsage === 'boolean') await update($, panel, prev => ({ ...prev, isUsageShown: storedUsage }))
    const storedPlansShown = await $.store.get('plansShown').catch(() => undefined)
    if (typeof storedPlansShown === 'boolean') await update($, panel, prev => ({ ...prev, isPlansShown: storedPlansShown }))
    const storedHistoryShown = await $.store.get('historyShown').catch(() => undefined)
    if (typeof storedHistoryShown === 'boolean') await update($, panel, prev => ({ ...prev, isHistoryShown: storedHistoryShown }))
    const storedHistory = await $.store.get('history').catch(() => undefined)
    await update($, history, () => parseHistory(storedHistory))
    const sid = (started as { sessionId?: unknown }).sessionId
    sessionId = typeof sid === 'string' ? sid : ''
    if (sessionId) {
      const storedPlans = await $.store.get('plans').catch(() => undefined)
      await update($, plans, () => parsePlans(storedPlans)[sessionId] ?? [])
    }
    void refreshContext($).catch(() => {})
    await $.tool.register({
      name: 'progress',
      description:
        'Report /flowdeck progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), phase "close" when the current work is done, and finished: true only when the user ends the flow. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
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
    })
    await $.tool.register({
      name: 'step',
      description:
        'For flowdeck workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
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
    })
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
    const prev = await read($, flow)
    if (isNewFlow(prev, input)) {
      // The flow being replaced goes to the history first, with its own agents; a finished one is there already.
      if (prev && !prev.isFinished) await recordFlow($, prev, 'finished')
      const startedAt = await $.clock.now()
      await update($, flowMeta, () => ({ startedAt, project }))
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (isNewFlow(prev, input)) {
      await update($, panel, p => ({ ...p, isBandHidden: false })) // a new flow brings the band back
    }
    if (next?.isFinished) {
      await recordFlow($, next, 'finished')
      await update($, flowMeta, () => null) // whatever comes next is a new record
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
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
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
    const hist = await read($, history)
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
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
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
    const toggleHistory = (
      <Button
        key="history"
        label={`${p.isHistoryShown ? '▾' : '▸'} History`}
        plain
        onPress={async () => {
          const shown = !p.isHistoryShown
          await update($, panel, prev => ({ ...prev, isHistoryShown: shown }))
          await $.store.set('historyShown', shown).catch(() => {})
        }}
      />
    )
    const topToggles = (
      <Box key="top-toggles" flexDirection="row" gap={1}>
        {toggleContext}
        {toggleUsage}
        {togglePlans}
        {toggleBand}
        {toggleHistory}
      </Box>
    )
    // Plain rows on both surfaces: one button per past flow, its summary lines under it when opened.
    const historySection = !p.isHistoryShown ? null : (
      <Box key="history-section" flexDirection="column">
        {hist.length === 0 ? (
          <Text dimColor>no history yet</Text>
        ) : (
          hist.map(entry => {
            const { head, lines } = formatEntry(entry, clockNow)
            const isOpen = p.openEntries.includes(entry.id)
            return (
              <Box key={`history-row-${entry.id}`} flexDirection="column">
                <Button
                  key={`history-${entry.id}`}
                  label={`${isOpen ? '▾' : '▸'} ${head}`}
                  plain
                  onPress={() =>
                    update($, panel, prev => ({
                      ...prev,
                      openEntries: prev.openEntries.includes(entry.id) ? prev.openEntries.filter(id => id !== entry.id) : [...prev.openEntries, entry.id],
                    }))
                  }
                />
                {isOpen &&
                  lines.map((line, i) => (
                    <Text key={`history-${entry.id}-${i}`} dimColor wrap="truncate-end">
                      {line}
                    </Text>
                  ))}
              </Box>
            )
          })
        )}
      </Box>
    )
    const toggles = toggleCompact
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

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
            {historySection}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {topToggles}
          {contextSection}
          {usageSection}
          {plansSection}
          <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
          {toggles}
          {isEmpty && <Text dimColor>{s.empty}</Text>}
          {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
          {running.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={66} />
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />
            ))}
          {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
          ))}
          {historySection}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
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
    const row = (a: AgentRun) => {
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''}` : ''
      const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)} ≈${fmtCost(a.costUsd)} ${fmtTime(elapsed(a, at))}`
      // The state leads the line in its colour, cut so the stats keep their room.
      const state = agentState(a)
      const head = stateText(a)
      const room = Math.max(state.name.length + 1, cols - 2 - barW - 1 - stats.length - 3)
      const [lead, rest] = splitHead(clip(steps ? `${head} · ${steps}` : head, room), head)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {tier === 'other' ? a.type : tier} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={state.color}>{ctxBar(progress * 100, barW)}</Text>}{' '}
            <Text color={state.color}>{lead}</Text>
            <Text dimColor>
              {rest} · {stats}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {topToggles}
        {contextSection}
        {usageSection}
        {plansSection}
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggles}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
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
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
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
            })}
          </Box>
        )}
        {historySection}
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
    const bandWidth = Math.max(180, Math.min(MAX_BAND_W, (e.props.bodyColumns || 100) * 9 - 110))
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
      const width = Math.max(180, Math.min(MAX_BAND_W, (e.props.bodyColumns || 100) * 9 - 110))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
            {crewButton}
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
        {dismiss}
      </Box>
      {planRowEls}
      {theirs}
      </Box>
    )
  })
}
