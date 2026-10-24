// A worker's own step list on its agent row: sent once through the `step` tool, moved by short ops, drawn as child rows.
import type { AgentItem, AgentItemStatus } from '../types'
import { elapsed as fmtElapsed, str } from './plan'
import { STATE_COLOR } from './plan-view'

export const MAX_ITEMS = 12
export const MAX_TITLE = 48
export const ITEM_H = 22
const INDENT = 42 // the agent row's text column

const STATUSES: readonly AgentItemStatus[] = ['pending', 'active', 'done', 'error']
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

export const ITEM_COLOR: Record<AgentItemStatus, string> = {
  pending: '#9a9a96',
  active: STATE_COLOR.running,
  done: STATE_COLOR.done,
  error: STATE_COLOR.error,
}
export const ITEM_GLYPH: Record<AgentItemStatus, string> = { pending: '●', active: '●', done: '✓', error: '✗' }
const ITEM_NAME: Record<AgentItemStatus, string> = { pending: 'Planned', active: 'Running', done: 'Done', error: 'Error' }

export type StepInput = Record<string, unknown>
type Fit = (s: string, size: number, maxW: number) => string

const isStatus = (v: unknown): v is AgentItemStatus => STATUSES.includes(v as AgentItemStatus)
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const titleOf = (x: unknown) => str(typeof x === 'string' ? x : (x as { title?: unknown } | null)?.title, MAX_TITLE)

const start = (it: AgentItem, now?: number) => {
  it.status = 'active'
  delete it.doneAt
  if (now === undefined) delete it.startedAt
  else it.startedAt = now
}
const finish = (it: AgentItem, now?: number) => {
  it.status = 'done'
  if (now !== undefined) it.doneAt = now
}

// The stored items, cleaned: anything that is not an item is dropped.
export const itemsOf = (v: unknown): AgentItem[] =>
  (Array.isArray(v) ? v : [])
    .flatMap(x => {
      const title = x && typeof x === 'object' ? titleOf(x) : ''
      if (!title) return []
      const item: AgentItem = { title, status: isStatus(x.status) ? x.status : 'pending' }
      const startedAt = time(x.startedAt)
      const doneAt = time(x.doneAt)
      if (startedAt !== undefined) item.startedAt = startedAt
      if (doneAt !== undefined) item.doneAt = doneAt
      return [item]
    })
    .slice(0, MAX_ITEMS)

// The sent `steps` list, or null when none was sent. An item sent without a status keeps what the
// same title had before; one item is in progress: the first active one, else the first pending one.
export function parseSteps(raw: unknown, prev: AgentItem[], now?: number): AgentItem[] | null {
  if (!Array.isArray(raw)) return null
  const left = [...prev]
  const items = raw
    .flatMap((x): AgentItem[] => {
      const title = titleOf(x)
      if (!title) return []
      const asked = x && typeof x === 'object' && isStatus(x.status) ? x.status : undefined
      const at = left.findIndex(o => same(o.title, title))
      const was = at >= 0 ? left.splice(at, 1)[0] : undefined
      if (was && (!asked || asked === was.status)) return [{ ...was, title }]
      const item: AgentItem = { title, status: asked ?? 'pending' }
      if (item.status === 'active' && now !== undefined) item.startedAt = now
      return [item]
    })
    .slice(0, MAX_ITEMS)
  let isSeen = false
  for (const it of items) {
    if (it.status !== 'active') continue
    if (isSeen) {
      it.status = 'pending'
      delete it.startedAt
    }
    isSeen = true
  }
  const first = isSeen ? undefined : items.find(it => it.status === 'pending')
  if (first) start(first, now)
  return items
}

// Short ops on the list: next, done (titles), active, failed. Titles not in the list come back in `unknown`.
export function applyItemOps(items: AgentItem[], input: StepInput, now?: number): { items: AgentItem[]; unknown: string[] } {
  const next = items.map(it => ({ ...it }))
  const unknown: string[] = []
  const find = (title: string) => {
    const found = next.find(it => same(it.title, title) && it.status !== 'done') ?? next.find(it => same(it.title, title))
    if (!found) unknown.push(title)
    return found
  }
  const activeAt = () => next.findIndex(it => it.status === 'active')
  // past the last item, work goes back to one left open earlier
  const advance = (from: number) => {
    const following = next.slice(from + 1).find(it => it.status === 'pending') ?? next.find(it => it.status === 'pending')
    if (following) start(following, now)
  }
  if (input.next === true) {
    const at = activeAt() >= 0 ? activeAt() : next.findIndex(it => it.status === 'pending')
    const cur = next[at]
    if (cur) {
      finish(cur, now)
      advance(at)
    }
  }
  let lastDone = -1
  for (const t of Array.isArray(input.done) ? input.done : []) {
    if (typeof t !== 'string' || !t.trim()) continue
    const it = find(t)
    if (!it) continue
    if (it.status === 'active') lastDone = next.indexOf(it)
    if (it.status !== 'done') finish(it, now)
  }
  // finishing the item in progress moves on, unless the call names the new one itself
  if (lastDone >= 0 && typeof input.active !== 'string' && activeAt() < 0) advance(lastDone)
  const active = typeof input.active === 'string' && input.active.trim() ? find(input.active) : undefined
  if (active) {
    const at = next.indexOf(active)
    next.forEach((it, i) => {
      if (it.status !== 'active' || i === at) return
      if (i < at) finish(it, now)
      else {
        it.status = 'pending'
        delete it.startedAt
      }
    })
    if (active.status !== 'active') start(active, now)
  }
  const failed = typeof input.failed === 'string' && input.failed.trim() ? find(input.failed) : undefined
  if (failed) {
    failed.status = 'error'
    if (now !== undefined) failed.doneAt = now
  }
  return { items: next, unknown }
}

export const hasItemOps = (input: StepInput): boolean =>
  Array.isArray(input.steps) || input.next === true || Array.isArray(input.done) || typeof input.active === 'string' || typeof input.failed === 'string'

// The agent's items after a `step` call, or null when the call carries no list and no op.
export function stepItems(prev: unknown, input: StepInput, now?: number): { items: AgentItem[]; unknown: string[] } | null {
  if (!hasItemOps(input)) return null
  const kept = itemsOf(prev)
  return applyItemOps(parseSteps(input.steps, kept, now) ?? kept, input, now)
}

// The row's `3/6 · note` from the items: done ones, all of them, the active one's title.
export const derive = (items: AgentItem[]): { done: number; total: number; note: string | undefined } => ({
  done: items.filter(it => it.status === 'done').length,
  total: items.length,
  note: items.find(it => it.status === 'active')?.title,
})

// At the run's end the item still in progress is done, or in error for a failed run.
export const finishItems = (items: AgentItem[], isOk: boolean, now?: number): AgentItem[] =>
  items.map(it => {
    if (it.status !== 'active') return it
    const out: AgentItem = { ...it, status: isOk ? 'done' : 'error' }
    if (now !== undefined) out.doneAt = now
    return out
  })

export const itemElapsed = (it: AgentItem, now: number): number | null => {
  if (it.startedAt === undefined) return null
  if (it.status === 'active') return Math.max(0, now - it.startedAt)
  if ((it.status === 'done' || it.status === 'error') && it.doneAt !== undefined) return Math.max(0, it.doneAt - it.startedAt)
  return null
}

const timeText = (it: AgentItem, now: number): string => {
  const ms = itemElapsed(it, now)
  return ms === null ? '' : fmtElapsed(ms)
}

export const itemAlt = (it: AgentItem, now: number): string => {
  const t = timeText(it, now)
  return `${it.title}: ${ITEM_NAME[it.status]}${t ? ' ' + t : ''}`
}

const mark = (x: number, y: number, status: AgentItemStatus): string => {
  const c = ITEM_COLOR[status]
  if (status === 'active') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${c}"/>`
  if (status === 'done') return `<path d="M${x - 4} ${y}l3 3 5.5-6" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'error') return `<path d="M${x - 3.5} ${y - 3.5}l7 7M${x + 3.5} ${y - 3.5}l-7 7" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`
  return `<circle class="m" cx="${x}" cy="${y}" r="3"/>`
}

// One child row's drawing, W wide and ITEM_H tall, indented to the agent row's text; `fit` is the panel's text cutter.
export function itemSvg(W: number, it: AgentItem, now: number, fit: Fit): string {
  const t = timeText(it, now)
  const right = W - 22 // where the agent row's stats end
  const titleX = INDENT + 16
  const room = Math.max(0, right - titleX - (t ? t.length * 6.5 + 8 : 0))
  const title = fit(it.title, 11, room)
  return `${mark(INDENT + 5, ITEM_H / 2, it.status)}
<text class="t" x="${titleX}" y="15" font-family="${FONT}" font-size="11">${esc(title)}</text>
${t ? `<text class="s" x="${right}" y="15" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${t}</text>` : ''}`
}

// One child row in the terminal: `   ● title  12s`, the title cut so the time keeps its room.
export function itemLine(it: AgentItem, now: number, cols: number): { mark: string; color: string | undefined; isDim: boolean; title: string; time: string } {
  const t = timeText(it, now)
  const room = Math.max(4, cols - 5 - (t ? t.length + 2 : 0))
  const isDim = it.status === 'pending'
  return { mark: ITEM_GLYPH[it.status], color: isDim ? undefined : ITEM_COLOR[it.status], isDim, title: clip(it.title, room), time: t }
}
