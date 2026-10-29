import { describe, expect, test } from 'claude-code/testing'

import { forecast, record, toWindows, usageRows, usageSvg, fmtReset, live, resets, untilText, resetKey } from '../hooks/usage'
import { hhmm } from '../hooks/time'
import { entryDate, groupLine } from '../hooks/archive'

const MIN = 60_000
const HOUR = 60 * MIN
// 2026-10-26 12:40 UTC, a Monday; the session resets at 14:40, so it started at 09:40.
const NOW = Date.UTC(2026, 9, 26, 12, 40)
const RESET_5H = Date.UTC(2026, 9, 26, 14, 40)
const RESET_7D = Date.UTC(2026, 9, 29, 11, 30)

const limits = (five: number, seven: number) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: new Date(RESET_5H).toISOString() },
  { kind: 'seven_day', percentUsed: seven, resetsAt: new Date(RESET_7D).toISOString() },
  { kind: 'spend_limit', percentUsed: 12 },
]

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

describe('usage windows', () => {
  test('toWindows keeps the session and the week, in that order, and skips other kinds', () => {
    const ws = toWindows(limits(76, 33))
    expect(ws.map(w => w.label)).toEqual(['Current session', 'This week'])
    expect(ws.map(w => w.percent)).toEqual([76, 33])
    expect(ws[0]!.resetsAt).toBe(RESET_5H)
  })

  test('toWindows is empty without readings and tolerates a missing reset time', () => {
    expect(toWindows([])).toEqual([])
    const ws = toWindows([{ kind: 'five_hour', percentUsed: 5 }])
    expect(ws[0]!.resetsAt).toBeNull()
  })

  test('fmtReset says the time today and the weekday for later days', () => {
    expect(fmtReset(RESET_5H, NOW, 'UTC')).toBe('14:40')
    expect(fmtReset(RESET_7D, NOW, 'UTC')).toBe('Thursday 11:30')
  })
})

describe('forecast', () => {
  test('the even-pace mark is the share of the window that has passed', () => {
    const w = toWindows(limits(76, 33))[0]!
    expect(near(forecast(w, [], NOW).expected, 60, 1e-6)).toBe(true) // 3h of 5h
  })

  test('the average projection extends percent over elapsed time and finds when 100% is hit', () => {
    const w = toWindows(limits(76, 33))[0]! // 76% in 3h: 126.7% by the reset
    const f = forecast(w, [], NOW)
    expect(near(f.average!.atReset, 126.67, 0.05)).toBe(true)
    // 100% is reached after 3h56m of the 5h window: 09:40 + 3.947h = 13:36:48
    expect(near(f.average!.hitsAt!, NOW + (24 / 76) * 3 * HOUR, 500)).toBe(true)
  })

  test('an on-pace window has no hit time', () => {
    const w = toWindows(limits(30, 10))[0]!
    const f = forecast(w, [], NOW)
    expect(near(f.average!.atReset, 50, 0.05)).toBe(true)
    expect(f.average!.hitsAt).toBeUndefined()
  })

  test('the recent projection uses the last 30 minutes of readings', () => {
    const w = toWindows(limits(76, 33))[0]!
    const samples = { five_hour: [{ at: NOW - 30 * MIN, pct: 70 }, { at: NOW, pct: 76 }] } // 12%/hour
    const f = forecast(w, samples, NOW)
    expect(near(f.recent!.atReset, 100, 0.05)).toBe(true) // 76 + 12*2h = 100
    expect(f.gathering).toBe(false)
  })

  test('with fewer than 5 minutes of readings the recent pace is still gathering', () => {
    const w = toWindows(limits(76, 33))[0]!
    const f = forecast(w, { five_hour: [{ at: NOW - 2 * MIN, pct: 75 }, { at: NOW, pct: 76 }] }, NOW)
    expect(f.recent).toBeNull()
    expect(f.gathering).toBe(true)
  })

  test('readings older than 30 minutes do not count toward the recent pace', () => {
    const w = toWindows(limits(76, 33))[0]!
    const f = forecast(w, { five_hour: [{ at: NOW - 3 * HOUR, pct: 0 }, { at: NOW - 40 * MIN, pct: 50 }] }, NOW)
    expect(f.recent).toBeNull()
  })

  test('right after a reset it is too early to tell', () => {
    const w = toWindows(limits(1, 5))[0]!
    const f = forecast(w, [], RESET_5H - 5 * HOUR + 2 * MIN)
    expect(f.tooEarly).toBe(true)
    expect(f.average).toBeNull()
  })

  test('a window without a reset time has no forecast', () => {
    const w = toWindows([{ kind: 'five_hour', percentUsed: 5 }])[0]!
    const f = forecast(w, [], NOW)
    expect(f.average).toBeNull()
    expect(f.recent).toBeNull()
  })
})

describe('record', () => {
  test('keeps a reading, drops those older than 3 hours, and starts over after a reset', () => {
    const w = toWindows(limits(50, 10))
    let s = record({}, w, NOW - 4 * HOUR)
    s = record(s, w, NOW)
    expect(s.five_hour!.length).toBe(1) // the 4-hour-old reading is gone
    const after = toWindows(limits(2, 10)) // the percent fell: the window reset
    expect(record(s, after, NOW + MIN).five_hour!.map(x => x.pct)).toEqual([2])
  })

  test('does not store the same reading twice within a minute', () => {
    const w = toWindows(limits(50, 10))
    let s = record({}, w, NOW)
    s = record(s, w, NOW + 10_000)
    expect(s.five_hour!.length).toBe(1)
  })
})

describe('drawings', () => {
  test('terminal rows show the label, reset time, percent and the verdict', () => {
    const ws = toWindows(limits(76, 33))
    const rows = usageRows(ws, {}, NOW, 60, 'UTC').map(r => r.line)
    const text = rows.join('\n')
    expect(text).toContain('Current session')
    expect(text).toContain('Resets at 14:40')
    expect(text).toContain('24% left')
    expect(text).toContain('This week')
    expect(text).toContain('Resets Thursday 11:30')
    expect(text).toContain('average: 100% at 13:36')
    expect(text).toContain('early')
    expect(rows.every(r => r.length <= 60)).toBe(true)
  })

  test('an on-pace row says so', () => {
    const rows = usageRows(toWindows(limits(30, 10)), {}, NOW, 80, 'UTC').map(r => r.line).join('\n')
    expect(rows).toContain('on pace')
  })

  test('a full window says the limit is reached', () => {
    const rows = usageRows(toWindows(limits(100, 10)), {}, NOW, 80, 'UTC').map(r => r.line).join('\n')
    expect(rows).toContain('limit reached')
  })

  test('the svg has a bar per window and an even-pace mark', () => {
    const { height, body } = usageSvg(400, toWindows(limits(76, 33)), {}, NOW, 'UTC')
    expect((body.match(/data-bar=/g) ?? []).length).toBe(2)
    expect((body.match(/data-mark=/g) ?? []).length).toBe(2)
    expect(body).toContain('24% left')
    expect(height).toBeGreaterThan(100)
  })

  test('a bar turns red when the forecast passes 100%', () => {
    const { body } = usageSvg(400, toWindows(limits(76, 33)), {}, NOW, 'UTC')
    expect(body).toContain('data-bar="five_hour" data-state="over"')
    expect(body).toContain('data-bar="seven_day" data-state="ok"')
  })
})

describe('review fixes', () => {
  test('a window whose reset time has passed is treated as reset, not as the old window', () => {
    const w = toWindows(limits(76, 33))[0]!
    const stale = live(w, RESET_5H + 20 * MIN)
    expect(stale.percent).toBe(0)
    expect(stale.resetsAt).toBeNull()
    const rows = usageRows([w], {}, RESET_5H + 20 * MIN, 80, 'UTC').map(r => r.line).join('\n')
    expect(rows).toContain('window reset')
    expect(rows).not.toContain('24% left')
    expect(rows).toContain('100% left')
  })

  test('the week has no recent projection and a busy hour does not make it red', () => {
    const week = toWindows(limits(10, 20))[1]!
    // 20% used 4 days into the week is on pace; a recent burst must not matter
    const samples = { seven_day: [{ at: NOW - 30 * MIN, pct: 15 }, { at: NOW, pct: 20 }] }
    const f = forecast(week, samples, NOW)
    expect(f.recent).toBeNull()
    expect(f.gathering).toBe(false)
    const rows = usageRows([week], samples, NOW, 80, 'UTC')
    expect(rows.every(r => !r.over)).toBe(true)
    expect(rows.map(r => r.line).join('\n')).not.toContain('recent')
  })

  test('a hit time on another day names the day and long spans are in days', () => {
    const day1 = Date.UTC(2026, 9, 23, 11, 30) // one day into the week
    const week = toWindows(limits(10, 40))[1]! // 40% in a day: 100% after 2.5 days, 4d 12h before the reset
    const text = usageRows([week], {}, day1, 100, 'UTC').map(r => r.line).join('\n')
    expect(text).toContain('100% at Saturday 23:30')
    expect(text).toContain('4d 12h early')
  })

  test('the verdict is split over two rows so the average is not cut off', () => {
    const ws = toWindows(limits(76, 33))
    const rows = usageRows(ws, {}, NOW, 40, 'UTC')
    const joined = rows.map(r => r.line).join('\n')
    expect(joined).toContain('average: 100% at 13:36')
    expect(rows.every(r => r.line.length <= 40)).toBe(true)
  })

  test('rows say which are over so the terminal can colour them', () => {
    const rows = usageRows(toWindows(limits(76, 33)), {}, NOW, 80, 'UTC')
    const session = rows.filter(r => r.window === 0)
    expect(session.some(r => r.kind === 'bar' && r.over)).toBe(true)
    expect(rows.filter(r => r.window === 1).every(r => !r.over)).toBe(true)
  })

  test('a reset a week away names the date, not just the weekday', () => {
    expect(fmtReset(NOW + 7 * 24 * HOUR - 30 * MIN, NOW, 'UTC')).toBe('Nov 2, 12:10')
  })

  test('the even-pace mark at zero is not drawn off the bar', () => {
    const w = toWindows(limits(0, 0))[0]!
    const { body } = usageSvg(400, [w], {}, w.resetsAt! - 5 * HOUR, 'UTC')
    const x = Number(/data-mark="five_hour" x="(-?[\d.]+)"/.exec(body)![1])
    expect(x).toBeGreaterThanOrEqual(0)
  })
})

describe('bars show what is left', () => {
  test('the svg bar is as wide as the share that is left, and drains as usage grows', () => {
    const width = (pctUsed: number) => {
      const { body } = usageSvg(400, toWindows(limits(pctUsed, 10)), {}, NOW, 'UTC')
      return Number(/data-bar="five_hour"[^>]*width="([\d.]+)"/.exec(body)![1])
    }
    const track = 400 - 74
    expect(Math.abs(width(0) - track)).toBeLessThan(0.2) // nothing used: full
    expect(Math.abs(width(76) - track * 0.24)).toBeLessThan(0.2)
    expect(width(100)).toBe(0)
    expect(width(76)).toBeLessThan(width(30))
  })

  test('the terminal bar is filled by what is left', () => {
    const bar = (pctUsed: number) => usageRows(toWindows(limits(pctUsed, 10)), {}, NOW, 50, 'UTC').find(r => r.kind === 'bar' && r.window === 0)!.line
    const filled = (line: string) => (line.match(/█/g) ?? []).length
    expect(filled(bar(0))).toBeGreaterThan(filled(bar(76)))
    const b = bar(76)
    const cells = b.slice(0, b.indexOf(' ')).length
    expect(Math.abs(filled(b) - Math.round(cells * 0.24))).toBeLessThanOrEqual(1) // the tick may take one cell
    expect(b).toContain('24% left')
  })

  test('the projected burn is shown as the part of the bar that will be used up, ahead of the fill', () => {
    const { body } = usageSvg(400, toWindows(limits(30, 10)), {}, NOW, 'UTC') // 30% used, average ends at 50%
    const proj = /<rect x="([\d.]+)" y="\d+" width="([\d.]+)" height="3"/.exec(body)!
    const track = 400 - 74
    expect(Math.abs(Number(proj[1]) - track * 0.5)).toBeLessThan(0.3) // remaining at reset is 50%
    expect(Math.abs(Number(proj[1]) + Number(proj[2]) - track * 0.7)).toBeLessThan(0.3) // up to what is left now
  })

  test('the even-pace mark sits where the remaining share would be on an even pace', () => {
    const { body } = usageSvg(400, toWindows(limits(30, 10)), {}, NOW, 'UTC') // 60% of the window passed: 40% left
    const x = Number(/data-mark="five_hour" x="(-?[\d.]+)"/.exec(body)![1])
    expect(Math.abs(x + 1 - (400 - 74) * 0.4)).toBeLessThan(0.3)
  })
})

describe('24-hour times', () => {
  test('hhmm pads the hour and uses the given time zone', () => {
    expect(hhmm(Date.UTC(2026, 9, 26, 9, 5), 'UTC')).toBe('09:05')
    expect(hhmm(Date.UTC(2026, 9, 26, 0, 30), 'UTC')).toBe('00:30')
    expect(hhmm(Date.UTC(2026, 9, 26, 23, 59), 'UTC')).toBe('23:59')
    expect(hhmm(Date.UTC(2026, 9, 26, 5, 0), 'Asia/Kolkata')).toBe('10:30')
    expect(hhmm(Date.UTC(2026, 9, 26, 14, 40))).toMatch(/^\d\d:\d\d$/)
  })

  test('fmtReset is 24-hour today, on another day and a week away', () => {
    expect(fmtReset(RESET_5H, NOW, 'UTC')).toBe('14:40')
    expect(fmtReset(Date.UTC(2026, 9, 26, 21, 5), NOW, 'UTC')).toBe('21:05')
    expect(fmtReset(Date.UTC(2026, 9, 27, 9, 5), NOW, 'UTC')).toBe('Tuesday 09:05')
    expect(fmtReset(NOW + 7 * 24 * HOUR - 30 * MIN, NOW, 'UTC')).toBe('Nov 2, 12:10')
  })

  test('no AM or PM anywhere in the usage text, the svg, the verdicts or the archive dates', () => {
    const texts: string[] = []
    for (const [five, seven] of [[76, 33], [30, 10], [100, 10], [10, 40]] as const) {
      const ws = toWindows(limits(five, seven))
      for (const now of [NOW, Date.UTC(2026, 9, 23, 11, 30), RESET_5H - 4 * HOUR]) {
        texts.push(usageRows(ws, {}, now, 120, 'UTC').map(r => r.line).join('\n'))
        texts.push(usageRows(ws, {}, now, 120, 'UTC', { remaining: true }).map(r => r.line).join('\n'))
        texts.push(usageSvg(400, ws, {}, now, 'UTC').body)
      }
    }
    const entry = { id: 'x', project: '/p', title: 't', startedAt: Date.UTC(2026, 9, 25, 23), endedAt: Date.UTC(2026, 9, 26, 22, 5), status: 'finished', done: 1, total: 1, tasks: [], cost: 0, tokens: 0, time: 0 } as any
    texts.push(entryDate(entry, 'UTC'), groupLine(entry, 90, 'UTC'))
    for (const t of texts) expect(/\b(AM|PM)\b/.test(t)).toBe(false)
    expect(texts.join('\n')).toContain('22:05')
  })
})

describe('remaining time to the reset', () => {
  test('untilText counts down in days, hours and minutes', () => {
    expect(untilText((2 * 24 * 60 + 13 * 60 + 20) * MIN)).toBe('2d 13h 20m')
    expect(untilText((13 * 60 + 20) * MIN)).toBe('13h 20m')
    expect(untilText(20 * MIN)).toBe('20m')
    expect(untilText(24 * HOUR)).toBe('1d 0h 0m')
    expect(untilText(1000)).toBe('1m') // a part of a minute still to go counts as a minute
    expect(untilText(20 * MIN - 1000)).toBe('20m')
    expect(untilText(0)).toBe('now')
    expect(untilText(-5 * MIN)).toBe('now')
  })

  test('the reset line says either the exact time or the time left', () => {
    const [five, seven] = toWindows(limits(76, 33))
    expect(resets(five!, NOW, 'UTC')).toBe('Resets at 14:40')
    expect(resets(seven!, NOW, 'UTC')).toBe('Resets Thursday 11:30')
    expect(resets(five!, NOW, 'UTC', true)).toBe('Resets in 2h 0m')
    expect(resets(seven!, NOW, 'UTC', true)).toBe('Resets in 2d 22h 50m')
    expect(resets(five!, RESET_5H, 'UTC', true)).toBe('Resets now')
    expect(resets(five!, RESET_5H + MIN, 'UTC', true)).toBe('Resets now')
    expect(resets({ ...five!, resetsAt: null }, NOW, 'UTC', true)).toBe('')
  })

  test('the terminal rows switch to the time left', () => {
    const text = usageRows(toWindows(limits(76, 33)), {}, NOW, 80, 'UTC', { remaining: true }).map(r => r.line).join('\n')
    expect(text).toContain('Resets in 2h 0m')
    expect(text).toContain('Resets in 2d 22h 50m')
    expect(text).not.toContain('Resets at')
  })

  test('the button keys name the window and are safe', () => {
    expect(resetKey('five_hour')).toBe('usage-reset-session')
    expect(resetKey('seven_day')).toBe('usage-reset-week')
    for (const k of [resetKey('five_hour'), resetKey('seven_day')]) expect(k).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('the drawing without its header', () => {
  test('has no label or reset text and is shorter, the rest is the same', () => {
    const ws = toWindows(limits(76, 33))
    const full = usageSvg(400, ws, {}, NOW, 'UTC')
    const bare = usageSvg(400, ws, {}, NOW, 'UTC', { header: false })
    expect(bare.height).toBeLessThan(full.height)
    expect(bare.body).not.toContain('Current session')
    expect(bare.body).not.toContain('Resets')
    expect(bare.body).not.toContain('class="t"')
    expect((bare.body.match(/data-bar=/g) ?? []).length).toBe(2)
    expect((bare.body.match(/data-mark=/g) ?? []).length).toBe(2)
    expect(bare.body).toContain('24% left')
    expect(bare.body).toContain('average: 100% at 13:36')
    const width = (b: string) => /data-bar="five_hour"[^>]*width="([\d.]+)"/.exec(b)![1]
    expect(width(bare.body)).toBe(width(full.body))
    const markY = /data-mark="five_hour" x="[\d.]+" y="(-?[\d.]+)"/.exec(bare.body)![1]
    expect(Number(markY)).toBeGreaterThanOrEqual(0)
  })

  test('no NaN at any width or column count', () => {
    const ws = toWindows(limits(76, 33))
    for (const w of [240, 360, 900]) {
      for (const header of [true, false]) {
        const d = usageSvg(w, ws, {}, NOW, 'UTC', { header })
        expect(d.body).not.toContain('NaN')
        expect(Number.isFinite(d.height)).toBe(true)
      }
    }
    for (let c = 24; c <= 80; c++) {
      for (const remaining of [false, true]) {
        const rows = usageRows(ws, {}, NOW, c, 'UTC', { remaining })
        expect(rows.some(r => r.line.includes('NaN'))).toBe(false)
        expect(rows.every(r => r.line.length <= c)).toBe(true)
      }
    }
  })
})
