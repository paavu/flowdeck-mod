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

// When a row finished, as every list shows it: `HH:MM` on the day of `now`, `Oct 29 · HH:MM` earlier that year, and
// `Oct 29, 2025 · HH:MM` in an earlier year.
export function doneText(at: number, now: number, tz?: string): string {
  const a = dayParts(at, tz)
  const b = dayParts(now, tz)
  if (a.day === b.day && a.year === b.year) return a.time
  return a.year === b.year ? `${a.day} · ${a.time}` : `${a.day}, ${a.year} · ${a.time}`
}
