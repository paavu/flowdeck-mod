// The prompt cache as the band shows it: WARM for an hour after the main thread's last request, then COLD. The facts the
// hooks keep, what they mean at a given time, the texts the band and the card draw, and what the next message costs.
// The idea and the price/cost method come from ribbon (MIT, Jay E | RoboNuggets); see NOTICE.md. Pure: no `$` here.
import type { CacheFacts, CacheFold, CacheMode } from '../types'
import { idleText, minutesLeft } from './time'

export type { CacheFacts, CacheFold, CacheMode }

/** How long the prompt cache stays warm after the main thread's last request: Claude Code's 1-hour cache. */
export const TTL_MS = 60 * 60_000

// The chip's colours and words, shared by the desktop drawings and the terminal text.
export const CACHE_HUE: Record<CacheMode, string> = { warm: '#cc6363', cold: '#6aaabd' }
/** The chip's text, dark ink on the hue. */
export const CACHE_INK = '#1c1a16'
export const CACHE_WORD: Record<CacheMode, string> = { warm: 'WARM', cold: 'COLD' }

export type CacheModel = { id: string; name: string; input: number; read: number }

// ESTIMATED prompt-cache prices, USD per million tokens, by model family (`id`, matched as a substring of the model id):
// `input` is the base input price (a 1-hour cache write costs 2x input), `read` a cache hit. Edit this table, and only
// this table, when the prices change: the band, the card and the tests all read them from here.
export const MODELS: readonly CacheModel[] = [
  { id: 'fable', name: 'Fable', input: 10, read: 0.25 },
  { id: 'opus', name: 'Opus', input: 4, read: 0.2 },
  { id: 'sonnet', name: 'Sonnet', input: 2, read: 0.2 },
  { id: 'haiku', name: 'Haiku', input: 0.5, read: 0.05 },
]

/** The MODELS row a model id belongs to, or null for a model the table does not price. */
export const familyOf = (model: string | null | undefined): CacheModel | null => {
  const m = (model ?? '').toLowerCase()
  return (m && MODELS.find(x => m.includes(x.id))) || null
}

/** A cold cache: the next message writes the whole context again at the 1-hour write price. */
export const coldCost = (m: CacheModel, tokens: number): number => (tokens / 1e6) * m.input * 2
/** A warm cache: the next message reads the context from the cache. */
export const warmCost = (m: CacheModel, tokens: number): number => (tokens / 1e6) * m.read
export const nextCost = (m: CacheModel, mode: CacheMode, tokens: number): number => (mode === 'cold' ? coldCost(m, tokens) : warmCost(m, tokens))

export const usd = (n: number): string => `$${n.toFixed(2)}`

/** Tokens as the card writes them: `770k`, `1.2M`, `640` below a thousand. */
export const tokText = (n: number): string => {
  if (n < 1000) return `${Math.max(0, Math.round(n))}`
  const k = Math.round(n / 1000)
  return k < 1000 ? `${k}k` : `${Number((n / 1e6).toFixed(1))}M`
}

/** What every drawing of the cache reads. */
export type CacheView = {
  mode: CacheMode
  /** Since the main thread's last request. */
  idleMs: number
  /** The context the next request re-sends. */
  tokens: number
  /** The session's model's MODELS row, null when it is not priced (or not known yet). */
  model: CacheModel | null
}

/** Whether the facts know a request and a context size: only then is there a cache to show. */
export const isShowable = (c: CacheFacts | null): c is CacheFacts => !!c && c.lastAt > 0 && c.tokens > 0

/** The cache at `now`, or null until a request and a context size are known. */
export function viewOf(c: CacheFacts | null, now: number): CacheView | null {
  if (!isShowable(c)) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return { mode: idleMs >= TTL_MS ? 'cold' : 'warm', idleMs, tokens: c.tokens, model: familyOf(c.model) }
}

/** The band's text after the chip: `42m left` while warm; cold, the idle time and the next message's cost (`12h 45m · $4.78`). */
export function summaryText(v: CacheView): string {
  if (v.mode === 'warm') return `${minutesLeft(TTL_MS - v.idleMs)} left`
  return v.model ? `${idleText(v.idleMs)} · ${usd(coldCost(v.model, v.tokens))}` : idleText(v.idleMs)
}

/** The card's TTL line: `cold in 12m` while warm, `cold for 11h 45m` once cold. */
export const ttlText = (v: CacheView): string => (v.mode === 'warm' ? `cold in ${minutesLeft(TTL_MS - v.idleMs)}` : `cold for ${idleText(v.idleMs - TTL_MS)}`)

/** What the next message's prices are for, by mode. */
export const costLabel = (mode: CacheMode): string => (mode === 'warm' ? 'next message, cache read' : 'next message, re-cache (1-hour write)')

export const FOOTER = 'prices are estimates'

/** Every text the drawings show that moves with the clock: the band redraws when this changes. */
export const cacheKey = (v: CacheView | null): string => (v ? `${v.mode}|${summaryText(v)}|${ttlText(v)}|${idleText(v.idleMs)}` : '')

/** Whether the card is open: the choice made in this mode, else warm folded and cold open. */
export const isCardOpen = (f: CacheFold | null, mode: CacheMode): boolean => (f && f.mode === mode ? f.open : mode === 'cold')
export const toggledFold = (f: CacheFold | null, mode: CacheMode): CacheFold => ({ mode, open: !isCardOpen(f, mode) })

/** A main-thread request starts now: the hour starts again. */
export const stamped = (c: CacheFacts | null, now: number, model: string | null | undefined): CacheFacts => ({
  lastAt: now,
  tokens: c?.tokens ?? 0,
  window: c?.window ?? 0,
  model: model || c?.model || null,
})

/**
 * A main turn ended: its context size and model. The request time stays the one `turn.step` stamped during this turn;
 * with none stamped in it (older than the turn), the turn's end stands in.
 */
export function measured(c: CacheFacts | null, now: number, durationMs: number, context: { tokens?: number; window?: number } | null, model: string | null | undefined): CacheFacts {
  const lastAt = !c || !(c.lastAt > 0) || now - c.lastAt > Math.max(0, durationMs || 0) ? now : c.lastAt
  const tokens = context?.tokens && context.tokens > 0 ? context.tokens : (c?.tokens ?? 0)
  return { lastAt, tokens, window: context?.window || c?.window || 0, model: model || c?.model || null }
}

/** The engine measured the context again: only the size changes, and only once a request is known. */
export const remeasured = (c: CacheFacts | null, context: { tokens?: number; window?: number }): CacheFacts | null =>
  c && context.tokens && context.tokens > 0 ? { ...c, tokens: context.tokens, window: context.window || c.window } : c

/** A resumed or forked session: its last response was `seconds` ago, over `tokens` of context. */
export const seeded = (now: number, seconds: number, tokens: number, window: number, model: string | null): CacheFacts => ({
  lastAt: now - Math.max(0, seconds) * 1000,
  tokens: Math.max(0, tokens),
  window: Math.max(0, window),
  model: model || null,
})
