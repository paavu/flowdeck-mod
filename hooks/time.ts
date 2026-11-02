// A time of day as the owner reads it everywhere in the panel: 24-hour `HH:MM`, in the given time zone (the local one when none is given).
export function hhmm(at: number, tz?: string): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))) p[x.type] = x.value
  const h = Number(p.hour) % 24 // some engines say 24 for midnight
  return `${String(h).padStart(2, '0')}:${String(p.minute ?? '0').padStart(2, '0')}`
}

// A time's day (`Oct 26`), year and clock in the given time zone (the local one when none is given).
export function dayParts(at: number, tz?: string): { day: string; year: string; time: string } {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' }).formatToParts(new Date(at))) p[x.type] = x.value
  return { day: `${p.month} ${p.day}`, year: p.year ?? '', time: hhmm(at, tz) }
}

// A time's local calendar date, `2026-11-02`: the day a finished flow belongs to (the Finished tab keeps a day's flows).
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const isDayKey = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

// When a row finished, as every list shows it: `HH:MM` on the day of `now`, `Oct 29 · HH:MM` earlier that year, and
// `Oct 29, 2025 · HH:MM` in an earlier year.
export function doneText(at: number, now: number, tz?: string): string {
  const a = dayParts(at, tz)
  const b = dayParts(now, tz)
  if (a.day === b.day && a.year === b.year) return a.time
  return a.year === b.year ? `${a.day} · ${a.time}` : `${a.day}, ${a.year} · ${a.time}`
}

const MINUTE = 60_000

// How long something has been idle, in whole minutes: `18m`, `2h 5m`, then `3d 9h` from a day on.
export function idleText(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / MINUTE))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// Time left of a span of at most an hour, in whole minutes and never hours: `42m`, `60m`, and `<1m` below a minute.
export function minutesLeft(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / MINUTE)
  return mins < 1 ? '<1m' : `${mins}m`
}
