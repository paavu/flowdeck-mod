// An archived task plan as drawings: the panel's svg track and the terminal rows; the state colours and text widths the
// panel shares. Trimmed, static port of plan-progress 0.8.2's track (MIT, Kirill Serditov).
import { elapsed, isFinished, percent, where } from './plan'
import type { PlanState, TaskPlan, Where } from './plan'

/** The mod's accent (blue-violet): the band, the running state, the selected tab, the note labels and an open note's icon. */
export const ACCENT = '#8f8cf4'
// the state is drawn by name and colour; these are the only colours on the bar and the pill
export const STATE_COLOR: Record<PlanState, string> = { running: ACCENT, needs_input: '#e8b13c', error: '#e5534b', done: '#5fbf8f' }
const PILL_TEXT: Record<PlanState, string> = { running: '#ffffff', needs_input: '#1f1f1f', error: '#ffffff', done: '#1f1f1f' } // dark text on the light pills
const STATE_NAME: Record<PlanState, string> = { running: 'Running', needs_input: 'Needs input', error: 'Error', done: 'Done' }
const STATES = Object.keys(STATE_COLOR) as PlanState[]

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const MIN_W = 120 // below this only a one-line drawing
const NARROW = 360 // below this no step dots and a shorter caption
const TRACK_Y = 26
const TRACK_H = 18
const CAPTION_Y = TRACK_Y + TRACK_H + 15
const PLAN_H = CAPTION_Y + 5
const PILL_H = 18

const stateOf = (p: TaskPlan): PlanState => (STATES.includes(p.state) ? p.state : 'running')
export const stateLabel = (p: TaskPlan): string => STATE_NAME[stateOf(p)]

// plan-progress's estimate: 6.2px a character at 11px, 3.4 for thin glyphs, 9.5 for m and w, 12 for CJK; scaled by size, bold a little wider
const pxAt11 = (ch: string) => (/[　-鿿]/.test(ch) ? 12 : /[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMW]/.test(ch) ? 9.5 : 6.2)
export const textWidth = (s: string, size: number, bold = false) => ([...s].reduce((n, ch) => n + pxAt11(ch), 0) * size * (bold ? 1.06 : 1)) / 11

export const fitText = (s: string, size: number, maxW: number, bold = false): string => {
  if (textWidth(s, size, bold) <= maxW) return s
  if (textWidth('…', size, bold) > maxW) return ''
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size, bold) > maxW) break
    out += ch
  }
  return out.trimEnd() + '…'
}

// cuts to `n` UTF-16 units (a terminal row's length), never leaving half an emoji
const cut = (s: string, n: number): string => {
  if (s.length <= n) return s
  if (n <= 0) return ''
  return s.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…'
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const n1 = (v: number) => String(Math.round((Number.isFinite(v) ? v : 0) * 10) / 10)

type Facts = { w: Where; pct: number; frac: number; time: string; current: number; title: string; note: string }

function factsOf(p: TaskPlan, now: number): Facts {
  const w = where(p)
  const steps = p.stages.flatMap(s => s.steps)
  const isDone = p.state === 'done'
  const end = isDone && typeof p.endedAt === 'number' ? p.endedAt : now
  const ms = end - p.startedAt
  // the step in progress, as where() picks it: the active one, else the first still open
  const active = steps.findIndex(st => st.status === 'active')
  const current = isDone ? -1 : active >= 0 ? active : steps.findIndex(st => !isFinished(st.status))
  return {
    w,
    pct: percent(p, w),
    frac: isDone ? 1 : w.total > 0 ? Math.min(1, Math.max(0, w.pos / w.total)) : 0,
    time: elapsed(Number.isFinite(ms) ? ms : 0),
    current,
    title: (typeof p.title === 'string' && p.title.trim()) || 'Plan',
    note: typeof p.note === 'string' ? p.note.trim() : '',
  }
}

// `<stage> · step x/y · <time>[ · note]`; a todo list is one flat list, `step x/y`; short drops the word "step"
function caption(p: TaskPlan, f: Facts, isShort: boolean): string {
  const parts: string[] = []
  if (f.w.total > 0) {
    if (p.kind === 'todo') parts.push(`step ${f.current >= 0 ? f.current + 1 : f.w.total}/${f.w.total}`)
    else {
      const stage = p.stages[f.w.stage]?.name || 'Stage'
      parts.push(`${stage} · ${isShort ? '' : 'step '}${f.w.step}/${f.w.stageSize}`)
    }
  }
  parts.push(f.time)
  if (f.note) parts.push(f.note)
  return parts.join(' · ')
}

// The desktop drawing, as the inside of the panel's svg: the title and the state pill, the track with its percent, and the caption.
export function planSvg(width: number, p: TaskPlan, now: number): { height: number; body: string } {
  const W = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const state = stateOf(p)
  const color = STATE_COLOR[state]
  const label = STATE_NAME[state]
  const f = factsOf(p, now)
  const pctText = `${f.pct}%`

  if (W < MIN_W) {
    const isFull = textWidth(`${pctText} ${label}`, 11, true) <= W
    const isPct = textWidth(pctText, 11) <= W
    const body = isPct
      ? `<text class="t" x="0" y="12" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${pctText}${isFull ? `<tspan fill="${color}" font-weight="600"> ${label}</tspan>` : ''}</text>`
      : ''
    return { height: 16, body }
  }

  const pillLabel = fitText(label, 11, W - 16, true)
  const pillW = Math.min(W, Math.ceil(textWidth(pillLabel, 11, true) + 16))
  const titleMax = W - pillW - 8
  const title = titleMax >= 24 ? fitText(f.title, 13, titleMax, true) : ''
  // the percent's slot is sized for 100% so the track keeps its length as the plan moves
  const trackW = Math.max(0, W - Math.ceil(textWidth('100%', 12, true)) - 8)
  const fx = f.frac * trackW
  const mid = TRACK_Y + TRACK_H / 2
  const total = f.w.total
  const unit = total > 0 ? trackW / total : 0
  const hasDots = W >= NARROW && unit >= 6

  let ticks = ''
  let k = 0
  p.stages.forEach(s => {
    s.steps.forEach((_, j) => {
      if (k > 0) {
        const x = k * unit
        const tone = x < fx - 1 ? 'fill="#ffffff" opacity="0.9"' : 'class="m" opacity="0.8"'
        if (j === 0) ticks += `<rect data-tick="stage" x="${n1(x - 1.5)}" y="${TRACK_Y + 4}" width="3" height="${TRACK_H - 8}" rx="1.5" ${tone}/>`
        else if (hasDots) ticks += `<circle data-tick="step" cx="${n1(x)}" cy="${mid}" r="1.4" ${tone}/>`
      }
      k++
    })
  })

  let mark = ''
  if (f.current >= 0 && unit > 0) {
    const markW = Math.min(trackW, Math.max(4, unit - 4))
    const markX = Math.max(0, Math.min(trackW - markW, f.current * unit + (unit - markW) / 2))
    const markH = TRACK_H - 6
    mark = `<rect data-active="1" x="${n1(markX)}" y="${TRACK_Y + 3}" width="${n1(markW)}" height="${markH}" rx="${n1(Math.min(markH, markW) / 2)}" fill="${color}" fill-opacity="0.6" stroke="#ffffff" stroke-width="1.2"/>`
  }

  const pillX = W - pillW
  const body = `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="13" font-weight="600">${esc(title)}</text>\n` : ''}<rect data-pill="${state}" x="${pillX}" y="1" width="${pillW}" height="${PILL_H}" rx="${PILL_H / 2}" fill="${color}"/>
<text x="${n1(pillX + pillW / 2)}" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${PILL_TEXT[state]}">${esc(pillLabel)}</text>
<rect data-track="1" class="k" x="0" y="${TRACK_Y}" width="${trackW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/>
<rect data-fill="${state}" x="0" y="${TRACK_Y}" width="${n1(fx)}" height="${TRACK_H}" rx="${n1(Math.min(TRACK_H, fx) / 2)}" fill="${color}"/>
${ticks}${mark}
<text class="t" x="${W}" y="${mid + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="600" font-variant-numeric="tabular-nums">${pctText}</text>
<text class="s" x="0" y="${CAPTION_Y}" font-family="${FONT}" font-size="11">${esc(fitText(caption(p, f, W < NARROW), 11, W))}</text>`
  return { height: PLAN_H, body }
}

export type PlanRow = { line: string; kind: 'head' | 'bar' | 'note'; color: string }

// The terminal rows: the title and state, a bar of exactly `columns` cells ending in the percent, and the caption; `color` is the state's hex for the caller to map.
export function planRows(p: TaskPlan, now: number, columns: number): PlanRow[] {
  const cols = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0
  const state = stateOf(p)
  const color = STATE_COLOR[state]
  const f = factsOf(p, now)
  const pctText = `${f.pct}%`
  if (cols < 12) return [{ line: pctText.length <= cols ? pctText : '', kind: 'bar', color }]

  const label = STATE_NAME[state]
  const room = cols - label.length - 2
  const head = room >= 2 ? `${cut(f.title, room)}  ${label}` : cut(label, cols)
  const cells = cols - pctText.length - 1
  const filled = Math.min(cells, Math.round(f.frac * cells))
  return [
    { line: head, kind: 'head', color },
    { line: `${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${pctText}`, kind: 'bar', color },
    { line: cut(caption(p, f, false), cols), kind: 'note', color },
  ]
}
