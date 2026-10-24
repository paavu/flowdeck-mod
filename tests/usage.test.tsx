import { describe, expect, test } from 'claude-code/testing'

import { forecast, record, toWindows, usageRows, usageSvg, fmtReset } from '../hooks/usage'

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
    expect(fmtReset(RESET_5H, NOW, 'UTC')).toBe('2:40 PM')
    expect(fmtReset(RESET_7D, NOW, 'UTC')).toBe('Thursday 11:30 AM')
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
    const rows = usageRows(ws, {}, NOW, 60, 'UTC')
    const text = rows.join('\n')
    expect(text).toContain('Current session')
    expect(text).toContain('Resets at 2:40 PM')
    expect(text).toContain('76% used')
    expect(text).toContain('This week')
    expect(text).toContain('Resets Thursday 11:30 AM')
    expect(text).toContain('average: 100% at 1:36 PM')
    expect(text).toContain('early')
    expect(rows.every(r => r.length <= 60)).toBe(true)
  })

  test('an on-pace row says so', () => {
    const rows = usageRows(toWindows(limits(30, 10)), {}, NOW, 80, 'UTC').join('\n')
    expect(rows).toContain('on pace')
  })

  test('a full window says the limit is reached', () => {
    const rows = usageRows(toWindows(limits(100, 10)), {}, NOW, 80, 'UTC').join('\n')
    expect(rows).toContain('limit reached')
  })

  test('the svg has a bar per window and an even-pace mark', () => {
    const { height, body } = usageSvg(400, toWindows(limits(76, 33)), {}, NOW, 'UTC')
    expect((body.match(/data-bar=/g) ?? []).length).toBe(2)
    expect((body.match(/data-mark=/g) ?? []).length).toBe(2)
    expect(body).toContain('76% used')
    expect(height).toBeGreaterThan(100)
  })

  test('a bar turns red when the forecast passes 100%', () => {
    const { body } = usageSvg(400, toWindows(limits(76, 33)), {}, NOW, 'UTC')
    expect(body).toContain('data-bar="five_hour" data-state="over"')
    expect(body).toContain('data-bar="seven_day" data-state="ok"')
  })
})
