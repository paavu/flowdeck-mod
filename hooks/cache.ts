// The prompt cache as the band shows it: WARM for an hour after the main thread's last request (or a later keep warm
// renewal), then COLD. The facts the
// hooks keep, what they mean at a given time, the texts the band and the card draw, and what the next message costs.
// Keep warm: when a renewal is due and what the card says of it. The idea and the price/cost method come from ribbon
// (MIT, Jay E | RoboNuggets; see NOTICE.md), the renewal method from Cache Bell (claude-mods.com/cache-bell). Pure: no `$` here.
import type { CacheFacts, CacheFold, CacheMode, KeepWarm } from '../types'
import { hhmm, idleText, minutesLeft } from './time'

export type { CacheFacts, CacheFold, CacheMode, KeepWarm }

/** How long the prompt cache stays warm after it was last read or written: Claude Code's 1-hour cache. */
export const TTL_MS = 60 * 60_000

/** Keep warm renews the cache this long after it was last read or written: 10 minutes before it would go cold. */
export const RENEW_AT_MS = TTL_MS - 10 * 60_000
/** Keep warm leaves a smaller context alone: writing it again costs little. */
export const KEEP_WARM_MIN_TOKENS = 80_000
/** Renewals at most between two of the user's messages; only a user message starts the count again. */
export const KEEP_WARM_MAX_RENEWALS = 2
/** Failed renewals at most between two of the user's messages; then keep warm waits for the next one. */
export const KEEP_WARM_MAX_FAILURES = 2
/** How long the next try waits after a failed renewal. */
export const KEEP_WARM_BACKOFF_MS = 2 * 60_000
/** No renewal in the hour's last minute: it could reach the API after the cache went cold and write it all again. */
const LAST_CALL_MS = TTL_MS - 60_000
const MINUTE = 60_000

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

/** Keep warm's bookkeeping before anything happened: no turn running, no renewal, no failure. */
export const KEEP_WARM_DEFAULT: KeepWarm = { turnAt: 0, userAt: 0, renewals: 0, renewedAt: 0, failures: 0, triedAt: 0 }

/** When the cache was last read or written: the main thread's last request, or a later renewal. */
export const touchedAt = (c: CacheFacts, k: KeepWarm): number => Math.max(c.lastAt, k.renewedAt)

/**
 * What keep warm does next, with the renewals since the user's last message: `due` at `at`; `failed` with the time it
 * tries again (`retryAt`), or null once it stopped; `limit` after KEEP_WARM_MAX_RENEWALS; `small` below
 * KEEP_WARM_MIN_TOKENS; `missed` when the cache went cold (or is in its last minute) with no renewal left to send; `off`.
 */
export type KeepStatus =
  | { kind: 'due'; renewals: number; at: number }
  | { kind: 'failed'; renewals: number; retryAt: number | null }
  | { kind: 'limit' | 'small' | 'missed' | 'off'; renewals: number }

export function keepStatus(c: CacheFacts, k: KeepWarm, isOn: boolean, now: number): KeepStatus {
  const { renewals } = k
  if (!isOn) return { kind: 'off', renewals }
  if (k.failures >= KEEP_WARM_MAX_FAILURES) return { kind: 'failed', renewals, retryAt: null }
  if (renewals >= KEEP_WARM_MAX_RENEWALS) return { kind: 'limit', renewals }
  if (c.tokens < KEEP_WARM_MIN_TOKENS) return { kind: 'small', renewals }
  const touched = touchedAt(c, k)
  // The last try failed when it was sent after the last renewal; then the next waits for the back-off. Never twice in a minute.
  const isRetry = k.failures > 0 && k.triedAt > k.renewedAt
  const at = Math.max(touched + RENEW_AT_MS, k.triedAt + MINUTE, isRetry ? k.triedAt + KEEP_WARM_BACKOFF_MS : 0)
  if (now >= touched + LAST_CALL_MS || at > touched + LAST_CALL_MS) return isRetry ? { kind: 'failed', renewals, retryAt: null } : { kind: 'missed', renewals }
  return isRetry ? { kind: 'failed', renewals, retryAt: at } : { kind: 'due', renewals, at }
}

/** Whether keep warm sends a renewal now: one is due (a first one or a retry) and no main turn runs. */
export function isRenewDue(c: CacheFacts | null, k: KeepWarm, isOn: boolean, now: number): boolean {
  if (!isShowable(c) || k.turnAt > 0) return false
  const s = keepStatus(c, k, isOn, now)
  const at = s.kind === 'due' ? s.at : s.kind === 'failed' ? s.retryAt : null
  return at !== null && now >= at
}

/**
 * The card's keep-warm line: `keep warm: renews at 14:32`, `kept warm ×1 · renews at 15:22`, `kept warm ×2 · limit
 * reached`, `keep warm: off`, `keep warm: failed` (`failed · retry at 14:52` while a retry is due), `keep warm: below
 * 80k tokens`, and once cold `kept warm ×1` or `keep warm: not renewed`. Times of day are 24-hour, in `tz` (local when none).
 */
export function keepText(s: KeepStatus, tz?: string): string {
  const kept = `kept warm ×${s.renewals}`
  const say = (rest: string) => (s.renewals > 0 ? `${kept} · ${rest}` : `keep warm: ${rest}`)
  switch (s.kind) {
    case 'due':
      return say(`renews at ${hhmm(s.at, tz)}`)
    case 'failed':
      return say(s.retryAt === null ? 'failed' : `failed · retry at ${hhmm(s.retryAt, tz)}`)
    case 'limit':
      return say('limit reached')
    case 'small':
      return say(`below ${tokText(KEEP_WARM_MIN_TOKENS)} tokens`)
    case 'missed':
      return s.renewals > 0 ? kept : 'keep warm: not renewed'
    case 'off':
      return say('off')
  }
}

/** What every drawing of the cache reads. */
export type CacheView = {
  mode: CacheMode
  /** Since the main thread's last request: the real idle time, which a renewal does not reset. */
  idleMs: number
  /** Since the cache was last read or written (the last request or a later renewal): its hour runs from there. */
  warmMs: number
  /** The context the next request re-sends. */
  tokens: number
  /** The session's model's MODELS row, null when it is not priced (or not known yet). */
  model: CacheModel | null
  /** What keep warm does next. */
  keep: KeepStatus
}

/** Whether the facts know a request and a context size: only then is there a cache to show. */
export const isShowable = (c: CacheFacts | null): c is CacheFacts => !!c && c.lastAt > 0 && c.tokens > 0

/** The cache at `now`, with keep warm's bookkeeping and switch, or null until a request and a context size are known. */
export function viewOf(c: CacheFacts | null, now: number, k: KeepWarm = KEEP_WARM_DEFAULT, isKeepWarm = true): CacheView | null {
  if (!isShowable(c)) return null
  const idleMs = Math.max(0, now - c.lastAt)
  const warmMs = Math.max(0, now - touchedAt(c, k))
  return { mode: warmMs >= TTL_MS ? 'cold' : 'warm', idleMs, warmMs, tokens: c.tokens, model: familyOf(c.model), keep: keepStatus(c, k, isKeepWarm, now) }
}

/** The band's text after the chip: `42m left` while warm; cold, the idle time and the next message's cost (`12h 45m · $4.78`). */
export function summaryText(v: CacheView): string {
  if (v.mode === 'warm') return `${minutesLeft(TTL_MS - v.warmMs)} left`
  return v.model ? `${idleText(v.idleMs)} · ${usd(coldCost(v.model, v.tokens))}` : idleText(v.idleMs)
}

/** The card's TTL line: `cold in 12m` while warm, `cold for 11h 45m` once cold. */
export const ttlText = (v: CacheView): string => (v.mode === 'warm' ? `cold in ${minutesLeft(TTL_MS - v.warmMs)}` : `cold for ${idleText(v.warmMs - TTL_MS)}`)

/** What one renewal costs (a cache read of the context) beside a cold restart (the 1-hour write), on the session's model: `renewal ≈ $0.15 · cold ≈ $6.16`; null for a model the table does not price. */
export const renewalText = (v: CacheView): string | null => (v.model ? `renewal ≈ ${usd(warmCost(v.model, v.tokens))} · cold ≈ ${usd(coldCost(v.model, v.tokens))}` : null)

/** What the next message's prices are for, by mode. */
export const costLabel = (mode: CacheMode): string => (mode === 'warm' ? 'next message, cache read' : 'next message, re-cache (1-hour write)')

export const FOOTER = 'prices are estimates'

/** Every text the drawings show that moves with the clock: the band redraws when this changes. */
export const cacheKey = (v: CacheView | null): string => (v ? `${v.mode}|${summaryText(v)}|${ttlText(v)}|${idleText(v.idleMs)}|${keepText(v.keep)}` : '')

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

/** The user's own message: a new idle period, its renewals and failures counted from none. */
export const userSpoke = (k: KeepWarm, now: number): KeepWarm => ({ ...k, userAt: now, renewals: 0, failures: 0 })

/**
 * A renewal sent at `sentAt` came back: answered, the cache was read then and its hour runs from there; else one more
 * failure. Either counts in the idle period it was sent in; a user message meanwhile started a new one, which it leaves alone.
 */
export function renewalEnded(k: KeepWarm, sentAt: number, userAt: number, isRenewed: boolean): KeepWarm {
  const same = k.userAt === userAt
  if (isRenewed) return { ...k, renewedAt: Math.max(k.renewedAt, sentAt), renewals: same ? k.renewals + 1 : k.renewals }
  return same ? { ...k, failures: k.failures + 1 } : k
}

/** A resumed or forked session: its last response was `seconds` ago, over `tokens` of context. */
export const seeded = (now: number, seconds: number, tokens: number, window: number, model: string | null): CacheFacts => ({
  lastAt: now - Math.max(0, seconds) * 1000,
  tokens: Math.max(0, tokens),
  window: Math.max(0, window),
  model: model || null,
})
