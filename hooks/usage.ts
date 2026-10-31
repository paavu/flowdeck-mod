import type { Sample, Samples, UsageWindow } from '../types'
export type { Sample, Samples, UsageWindow }
import { hhmm } from './time'
import { fitText, textWidth } from './plan-view'
import { SMALL_SIZE, TITLE_SIZE, TITLE_WEIGHT } from './sizes'

// Rate-limit usage for the flowdeck panel: the session and weekly windows, and a forecast of whether the pace burns them before the reset.

export type Rate = { kind: string; percentUsed: number; resetsAt?: string }
export type Projection = { atReset: number; hitsAt?: number }
export type Forecast = {
  expected: number // percent used if the pace were perfectly even
  tooEarly: boolean
  gathering: boolean // not enough readings for the recent pace yet
  average: Projection | null
  recent: Projection | null
}

const MIN = 60_000
const HOUR = 60 * MIN
const SPEC = [
  { kind: 'five_hour', label: 'Current session', length: 5 * HOUR },
  { kind: 'seven_day', label: 'This week', length: 7 * 24 * HOUR },
] as const
const RECENT = 30 * MIN
const NEEDS = 5 * MIN // the least span of readings, and of a window's age, to project from
const KEEP = 3 * HOUR
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const COLOR = { five_hour: '#e8b13c', seven_day: '#4a7fe0', over: '#e5534b' } as const

export function toWindows(limits: Rate[]): UsageWindow[] {
  return SPEC.flatMap(spec => {
    const r = limits.find(l => l.kind === spec.kind)
    if (!r || !Number.isFinite(r.percentUsed)) return []
    const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    return [{ ...spec, percent: r.percentUsed, resetsAt: Number.isFinite(at) ? at : null }]
  })
}

// Keeps the readings of the last 3 hours; a falling percent means the window reset, so the older readings go.
export function record(samples: Samples, windows: UsageWindow[], now: number): Samples {
  const next: Samples = { ...samples }
  for (const w of windows) {
    let list = [...(samples[w.kind] ?? [])]
    const last = list.at(-1)
    if (last && w.percent < last.pct - 0.5) list = []
    const prev = list.at(-1)
    if (!prev || w.percent !== prev.pct || now - prev.at >= MIN) list.push({ at: now, pct: w.percent })
    next[w.kind] = list.filter(s => s.at >= now - KEEP).slice(-240)
  }
  return next
}

const project = (pct: number, ratePerMs: number, now: number, resetsAt: number): Projection => {
  const atReset = pct + ratePerMs * (resetsAt - now)
  return { atReset, hitsAt: ratePerMs > 0 && atReset > 100 && pct < 100 ? now + (100 - pct) / ratePerMs : undefined }
}

// A window whose reset time has passed is over: show it as reset until a new reading arrives.
export function live(w: UsageWindow, now: number): UsageWindow {
  return w.resetsAt !== null && w.resetsAt <= now ? { ...w, percent: 0, resetsAt: null, expired: true } : w
}

export function forecast(w: UsageWindow, samples: Samples, now: number): Forecast {
  if (w.resetsAt === null) return { expected: 0, tooEarly: false, gathering: false, average: null, recent: null }
  const elapsed = Math.min(w.length, Math.max(0, now - (w.resetsAt - w.length)))
  const expected = (elapsed / w.length) * 100
  const tooEarly = elapsed < NEEDS
  const average = tooEarly ? null : project(w.percent, w.percent / elapsed, now, w.resetsAt)
  const recent = (samples[w.kind] ?? []).filter(s => s.at >= now - RECENT)
  const span = recent.length >= 2 ? recent.at(-1)!.at - recent[0]!.at : 0
  const hasRecent = w.kind === 'five_hour' && !tooEarly && span >= NEEDS // a 30-minute pace over days assumes round-the-clock work
  const rate = hasRecent ? Math.max(0, recent.at(-1)!.pct - recent[0]!.pct) / span : 0
  return {
    expected,
    tooEarly,
    gathering: w.kind === 'five_hour' && !tooEarly && !hasRecent,
    average,
    recent: hasRecent ? project(w.percent, rate, now, w.resetsAt) : null,
  }
}

const clock = hhmm

// "14:40" when the reset is today, "Thursday 11:30" on a later day.
export function fmtReset(at: number, now: number, tz?: string): string {
  if (at - now > 6.5 * 24 * HOUR) return `${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}, ${clock(at, tz)}`
  const day = (t: number) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: tz })
  if (day(at) === day(now)) return clock(at, tz)
  return `${new Date(at).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })} ${clock(at, tz)}`
}

const span = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / MIN))
  if (m >= 24 * 60) {
    const h = Math.round((m % (24 * 60)) / 60)
    return h ? `${Math.floor(m / (24 * 60))}d ${h}h` : `${Math.floor(m / (24 * 60))}d`
  }
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`
}

const proj = (p: Projection, w: UsageWindow, now: number, tz?: string): string =>
  p.hitsAt !== undefined ? `100% at ${fmtReset(p.hitsAt, now, tz)}, ${span(w.resetsAt! - p.hitsAt)} early` : `${Math.round(p.atReset)}% at reset`

const willBurn = (f: Forecast): boolean => [f.average, f.recent].some(p => p && (p.hitsAt !== undefined || p.atReset > 100))

// One or two lines: a single status, or the recent and the average projection (the week only has the average).
export function verdictLines(w: UsageWindow, f: Forecast, now: number, tz?: string): string[] {
  if (w.expired) return ['window reset, waiting for a new reading']
  if (w.percent >= 100) return [`limit reached${w.resetsAt ? `, resets ${fmtReset(w.resetsAt, now, tz)}` : ''}`]
  if (w.resetsAt === null) return ['no reset time']
  if (f.tooEarly) return ['too early to tell']
  const lead = willBurn(f) ? '' : 'on pace · '
  const average = `average: ${f.average ? proj(f.average, w, now, tz) : '—'}`
  if (w.kind === 'seven_day') return [`${lead}${average}`]
  return [`${lead}recent: ${f.recent ? proj(f.recent, w, now, tz) : 'gathering…'}`, average]
}

export const isOver = (w: UsageWindow, f: Forecast): boolean => w.percent >= 90 || willBurn(f)

const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)
// The time left until a reset, counted down in whole minutes: `2d 13h 20m`, `13h 20m`, `20m`; `now` at or past it.
export function untilText(ms: number): string {
  if (!(ms > 0)) return 'now'
  const m = Math.ceil(ms / MIN)
  const d = Math.floor(m / (24 * 60))
  const h = Math.floor((m % (24 * 60)) / 60)
  if (d) return `${d}d ${h}h ${m % 60}m`
  return h ? `${h}h ${m % 60}m` : `${m % 60}m`
}

// The reset line: the exact time (`Resets at 14:40`, `Resets Thursday 11:30`) or, with `remaining`, the time left (`Resets in 2h 0m`).
export function resets(w: UsageWindow, now: number, tz?: string, remaining = false): string {
  if (w.resetsAt === null) return ''
  if (remaining) return w.resetsAt <= now ? 'Resets now' : `Resets in ${untilText(w.resetsAt - now)}`
  const at = fmtReset(w.resetsAt, now, tz)
  return `Resets ${at === clock(w.resetsAt, tz) ? 'at ' : ''}${at}`
}

// The key of a window's reset switch.
export const resetKey = (kind: string): string => `usage-reset-${kind === 'seven_day' ? 'week' : kind === 'five_hour' ? 'session' : kind.replace(/[^A-Za-z0-9_-]/g, '_')}`

const pct = (n: number) => `${+n.toFixed(1)}%`

export type UsageRow = { line: string; kind: 'head' | 'bar' | 'note'; window: number; over: boolean; hasReset?: boolean }
// The room a head row leaves at its end for the reset switch.
export const SWITCH_COLS = 4

// The terminal rows: per window the label and reset, a bar with the percent, and the verdict lines.
// A head row with a reset time leaves `SWITCH_COLS` for its switch.
export function usageRows(windows: UsageWindow[], samples: Samples, now: number, columns: number, tz?: string, opts: { remaining?: boolean } = {}): UsageRow[] {
  const rows: UsageRow[] = []
  windows.forEach((win, window) => {
    const w = live(win, now)
    const f = forecast(w, samples, now)
    const over = isOver(w, f)
    const reset = resets(w, now, tz, opts.remaining)
    const label = `${w.label}  ${reset}`.trimEnd()
    const left = Math.max(0, 100 - w.percent)
    const used = `${pct(left)} left`
    const bar = Math.max(6, columns - used.length - 1)
    const filled = Math.min(bar, Math.round((left / 100) * bar))
    const tick = w.resetsAt === null ? -1 : Math.min(bar - 1, Math.max(0, Math.round(((100 - f.expected) / 100) * bar)))
    const cells = Array.from({ length: bar }, (_, i) => (i === tick ? '│' : i < filled ? '█' : '░')).join('')
    rows.push({ line: fit(label, reset ? columns - SWITCH_COLS : columns), kind: 'head', window, over, hasReset: !!reset })
    rows.push({ line: `${cells} ${used}`, kind: 'bar', window, over })
    for (const note of verdictLines(w, f, now, tz)) rows.push({ line: fit(note, columns), kind: 'note', window, over })
  })
  return rows
}

// A window's title at the left and its reset line at the right of `width`, the reset line cut to what the title leaves.
const headText = (width: number, label: string, reset: string, top: number): string => {
  const room = Math.max(0, width - textWidth(label, TITLE_SIZE, true) - 12)
  return `<text class="t" x="0" y="${top + 14}" font-family="${FONT}" font-size="${TITLE_SIZE}" font-weight="${TITLE_WEIGHT}">${esc(label)}</text>
<text class="s" x="${width}" y="${top + 14}" text-anchor="end" font-family="${FONT}" font-size="${SMALL_SIZE}">${esc(fitText(reset, SMALL_SIZE, room))}</text>`
}

// The header alone, for the panel to put the reset switch beside.
export function usageHeadSvg(width: number, label: string, reset: string): { height: number; body: string } {
  return { height: 18, body: headText(width, label, reset, 0) }
}

// The desktop drawing, as the inside of the panel's svg: per window a label and reset line, the bar with projections and the even-pace mark, the percent, and the verdict.
// `header: false` leaves out the label and reset line (the panel draws them natively above, beside the reset switch) and the room they took.
export function usageSvg(width: number, windows: UsageWindow[], samples: Samples, now: number, tz?: string, opts: { header?: boolean } = {}): { height: number; body: string } {
  const header = opts.header !== false
  const HEAD = header ? 18 : 0
  const ROW = 64 + HEAD
  const used = 74
  const barW = Math.max(40, width - used)
  let top = 0
  const body = windows
    .map(win => {
      const w = live(win, now)
      const f = forecast(w, samples, now)
      const over = isOver(w, f)
      const color = over ? COLOR.over : COLOR[w.kind]
      const x = (p: number) => (Math.min(100, Math.max(0, p)) / 100) * barW // percent of the bar's width
      const left = Math.max(0, 100 - w.percent)
      const y = top + 8 + HEAD
      // The part that will be used up by the reset at that pace: from what would remain back to what is left now.
      const ext = (p: Projection | null, dy: number, h: number, opacity: number) =>
        p && left > 0 ? `<rect x="${x(100 - p.atReset).toFixed(1)}" y="${y + dy}" width="${Math.max(0, x(left) - x(100 - p.atReset)).toFixed(1)}" height="${h}" fill="${color}" opacity="${opacity}"/>` : ''
      const markX = Math.min(barW - 2, Math.max(0, x(100 - f.expected) - 1))
      const mark = w.resetsAt === null ? '' : `<rect data-mark="${w.kind}" x="${markX.toFixed(1)}" y="${y - 3}" width="2" height="16" fill="#6b6b6b" opacity="0.9"/>`
      const notes = verdictLines(w, f, now, tz)
        .map((note, i) => `<text class="s" x="0" y="${y + 30 + i * 14}" font-family="${FONT}" font-size="${SMALL_SIZE}">${esc(fit(note, Math.floor(width / 5.5)))}</text>`)
        .join('\n')
      const head = header
        ? `${headText(barW, w.label, resets(w, now, tz), top)}\n`
        : ''
      const out = `${head}<rect x="0" y="${y}" width="${barW}" height="10" rx="5" fill="${color}" opacity="0.18"/>
<rect data-bar="${w.kind}" data-state="${over ? 'over' : 'ok'}" x="0" y="${y}" width="${x(left).toFixed(1)}" height="10" rx="5" fill="${color}"/>
${ext(f.recent, 0, 10, 0.45)}${ext(f.average, 10, 3, 0.6)}${mark}
<text class="s" x="${width}" y="${y + 9}" text-anchor="end" font-family="${FONT}" font-size="${SMALL_SIZE}" font-variant-numeric="tabular-nums">${pct(left)} left</text>
${notes}`
      top += ROW
      return out
    })
    .join('\n')
  return { height: Math.max(1, windows.length) * ROW, body }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
