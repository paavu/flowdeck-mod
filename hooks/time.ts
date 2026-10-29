// A time of day as the owner reads it everywhere in the panel: 24-hour `HH:MM`, in the given time zone (the local one when none is given).
export function hhmm(at: number, tz?: string): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))) p[x.type] = x.value
  const h = Number(p.hour) % 24 // some engines say 24 for midnight
  return `${String(h).padStart(2, '0')}:${String(p.minute ?? '0').padStart(2, '0')}`
}
