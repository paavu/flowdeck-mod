import { describe, expect, test } from 'claude-code/testing'

import type { PlanState, StepStatus, TaskPlan } from '../hooks/plan'
import { planRows, planSvg, STATE_COLOR, stateLabel } from '../hooks/plan-view'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 26, 12, 40)
const TIER_COLORS = ['#7F77DD', '#D85A30', '#BA7517', '#378ADD', '#1D9E75', '#888780']

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

// `stages` x `steps`, the first `done` steps finished and the next one active (or failed for an error plan)
function plan(stages: number, steps: number, done: number, state: PlanState = 'running', extra: Partial<TaskPlan> = {}): TaskPlan {
  let k = 0
  return {
    id: 'p',
    title: 'Ship the plan drawings',
    kind: 'plan',
    state,
    note: null,
    startedAt: NOW - 3 * MIN - 5000,
    stages: Array.from({ length: stages }, (_, i) => ({
      name: `Stage ${i + 1}`,
      steps: Array.from({ length: steps }, (_, j) => {
        const n = k++
        const status: StepStatus = state === 'done' || n < done ? 'done' : n === done ? (state === 'error' ? 'error' : 'active') : 'pending'
        return { title: `Step ${i + 1}.${j + 1}`, status, substeps: [] }
      }),
    })),
    ...extra,
  }
}

const mid = () => plan(3, 4, 5) // 5 of 12 finished: 42%, stage 2 step 2/4

const numbers = (body: string) => [...body.matchAll(/\s(?:x|y|width|height|rx|cx|cy|r|opacity)="([^"]*)"/g)].map(m => m[1]!)

const visibleText = (body: string) => [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ''))

const PLAN_FOR_PILL = { id: 'p', title: 'T', kind: 'plan', stages: [{ name: 'S', steps: [{ title: 'a', status: 'active', substeps: [] }] }], state: 'running', note: null, startedAt: 0 }

describe('plan state', () => {
  test('each state has its name and colour', () => {
    const cases: [PlanState, string, string][] = [
      ['running', 'Running', '#8f8cf4'],
      ['needs_input', 'Needs input', '#e8b13c'],
      ['error', 'Error', '#e5534b'],
      ['done', 'Done', '#5fbf8f'],
    ]
    for (const [state, label, color] of cases) {
      expect(STATE_COLOR[state]).toBe(color)
      expect(stateLabel(plan(1, 2, 0, state))).toBe(label)
    }
  })
})

describe('planSvg', () => {
  for (const width of [240, 360, 900]) {
    test(`a mid-run plan at ${width}px is finite and complete`, () => {
      const { height, body } = planSvg(width, mid(), NOW)
      expect(height).toBeGreaterThan(0)
      expect(Number.isFinite(height)).toBe(true)
      expect(body).not.toContain('NaN')
      expect(body).not.toContain('Infinity')
      expect(body).not.toContain('<script')
      for (const n of numbers(body)) {
        expect(Number.isFinite(Number(n))).toBe(true)
      }
      for (const m of body.matchAll(/\s(?:width|height|rx|r)="([^"]*)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0)
      expect(body).toContain('Ship the plan')
      expect(body).toContain('Running')
      expect(body).toContain('42%')
      expect(body).toContain('Stage 2')
    })
  }

  test('the pill and the fill are drawn in the state colour, and no tier colour appears', () => {
    for (const state of ['running', 'needs_input', 'error', 'done'] as PlanState[]) {
      const { body } = planSvg(360, plan(3, 4, 5, state), NOW)
      expect(body).toMatch(new RegExp(`data-pill="${state}"[^>]*fill="${STATE_COLOR[state]}"`))
      expect(body).toMatch(new RegExp(`data-fill="${state}"[^>]*fill="${STATE_COLOR[state]}"`))
      const others = Object.entries(STATE_COLOR).filter(([s]) => s !== state)
      for (const [, c] of others) expect(body).not.toContain(c)
      for (const c of TIER_COLORS) expect(body.toLowerCase()).not.toContain(c.toLowerCase())
    }
  })

  test('the fill is the finished share of the track', () => {
    const at = (p: TaskPlan) => {
      const { body } = planSvg(900, p, NOW)
      const fill = body.match(/data-fill="[^"]*"[^>]*width="([^"]*)"/)
      const track = body.match(/data-track="1"[^>]*width="([^"]*)"/)
      return { fill: Number(fill?.[1] ?? -1), track: Number(track?.[1] ?? -1) }
    }
    const half = at(plan(2, 4, 4))
    expect(near(half.fill / half.track, 0.5, 0.01)).toBe(true)
    expect(at(plan(2, 4, 0)).fill).toBe(0)
    const full = at(plan(2, 4, 8, 'done'))
    expect(full.fill).toBe(full.track)
  })

  test('stage boundaries are ticks, step dots only from 360px', () => {
    const wide = planSvg(900, mid(), NOW).body
    expect(wide.match(/data-tick="stage"/g)?.length).toBe(2)
    expect(wide.match(/data-tick="step"/g)?.length).toBe(9)
    expect(planSvg(240, mid(), NOW).body).not.toContain('data-tick="step"')
    expect(planSvg(240, mid(), NOW).body.match(/data-tick="stage"/g)?.length).toBe(2)
  })

  test('the active step is marked, a finished plan has no mark', () => {
    expect(planSvg(360, mid(), NOW).body).toContain('data-active="1"')
    expect(planSvg(360, plan(3, 4, 12, 'done'), NOW).body).not.toContain('data-active')
  })

  test('the caption names the stage, the step and the time', () => {
    const texts = visibleText(planSvg(900, mid(), NOW).body)
    expect(texts).toContain('Stage 2 · step 2/4 · 3m 5s')
    const narrow = visibleText(planSvg(240, mid(), NOW).body)
    expect(narrow.some(t => t.startsWith('Stage 2 · 2/4'))).toBe(true)
  })

  test('a needs_input plan shows its question, an error plan its failure', () => {
    const asked = planSvg(900, plan(3, 4, 5, 'needs_input', { note: 'Which port?' }), NOW).body
    expect(asked).toContain('Needs input')
    expect(visibleText(asked)).toContain('Stage 2 · step 2/4 · 3m 5s · Which port?')
    const failed = planSvg(360, plan(3, 4, 5, 'error', { note: 'tests failed' }), NOW).body
    expect(failed).toContain('Error')
    expect(failed).toContain('tests failed')
  })

  test('a long title is cut with an ellipsis and no text runs past the width', () => {
    const long = plan(3, 4, 5, 'running', { title: 'A very long plan title that goes on and on about everything it wants to do '.repeat(4) })
    for (const width of [120, 240, 360, 900]) {
      const { body } = planSvg(width, long, NOW)
      expect(body).toContain('…')
      // an independent estimate: 0.3em for spaces and thin glyphs, 0.56em for the rest, bold 6% wider
      for (const m of body.matchAll(/<text[^>]*font-size="(\d+)"([^>]*)>([\s\S]*?)<\/text>/g)) {
        const size = Number(m[1])
        const bold = /font-weight="600"/.test(m[0]) ? 1.06 : 1
        const text = m[3]!.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '&')
        const est = [...text].reduce((n, ch) => n + (/[\s.,:;'|!il]/.test(ch) ? 0.3 : 0.56), 0) * size * bold
        expect(est).toBeLessThanOrEqual(width)
      }
    }
  })

  test('markup is escaped', () => {
    const { body } = planSvg(900, plan(1, 2, 0, 'running', { title: '<b>&"x"</b>', note: '<script>' }), NOW)
    expect(body).not.toContain('<b>')
    expect(body).not.toContain('<script')
    expect(body).toContain('&lt;b&gt;&amp;')
  })

  test('a 7 x 8 plan stays small', () => {
    for (const width of [240, 360, 900]) {
      expect(planSvg(width, plan(7, 8, 30), NOW).body.length).toBeLessThan(20000)
    }
  })

  test('edge plans: no stages, todo, 0%, 100%', () => {
    const empty = { ...plan(1, 1, 0), stages: [] }
    const e = planSvg(360, empty, NOW)
    expect(e.body).not.toContain('NaN')
    expect(e.body).toContain('0%')
    const todo = planSvg(360, { ...plan(1, 5, 2), kind: 'todo' }, NOW).body
    expect(visibleText(todo)).toContain('step 3/5 · 3m 5s')
    expect(planSvg(360, plan(2, 3, 0), NOW).body).toContain('>0%<')
    const done = planSvg(360, plan(2, 3, 6, 'done', { endedAt: NOW - MIN }), NOW).body
    expect(done).toContain('>100%<')
    expect(done).toContain('Done')
    expect(visibleText(done)).toContain('Stage 2 · step 3/3 · 2m 5s')
  })

  test('tiny and broken widths give a minimal drawing', () => {
    for (const width of [0, -5, 40, 119, NaN, Infinity]) {
      const { height, body } = planSvg(width, mid(), NOW)
      expect(height).toBeGreaterThan(0)
      expect(Number.isFinite(height)).toBe(true)
      expect(body).not.toContain('NaN')
      expect(body).not.toContain('Infinity')
      expect(body).not.toMatch(/(?:width|height)="-/)
    }
    const small = planSvg(100, mid(), NOW)
    expect(small.height).toBeLessThan(30)
    expect(small.body).toContain('42%')
  })

  test('a broken start time does not leak NaN', () => {
    const { body } = planSvg(360, { ...mid(), startedAt: NaN }, NOW)
    expect(body).not.toContain('NaN')
  })

  test('the same input draws the same output', () => {
    expect(planSvg(360, mid(), NOW)).toEqual(planSvg(360, mid(), NOW))
    expect(planRows(mid(), NOW, 40)).toEqual(planRows(mid(), NOW, 40))
  })
})

describe('planRows', () => {
  for (const columns of [12, 24, 40, 80]) {
    test(`rows fit ${columns} columns`, () => {
      const rows = planRows(mid(), NOW, columns)
      expect(rows.map(r => r.kind)).toEqual(['head', 'bar', 'note'])
      for (const r of rows) {
        expect(r.line.length).toBeLessThanOrEqual(columns)
        expect(r.color).toBe(STATE_COLOR.running)
      }
      const bar = rows[1]!.line
      expect(bar.length).toBe(columns)
      expect(bar.endsWith(' 42%')).toBe(true)
      const cells = bar.slice(0, -' 42%'.length)
      expect(/^█*░*$/.test(cells)).toBe(true)
      const filled = cells.split('█').length - 1
      expect(near(filled, (42 / 100) * cells.length, 1)).toBe(true)
    })
  }

  test('head and note carry the title, the state and the caption', () => {
    const rows = planRows(plan(3, 4, 5, 'needs_input', { note: 'Which port?' }), NOW, 80)
    expect(rows[0]!.line).toBe('Ship the plan drawings  Needs input')
    expect(rows[2]!.line).toBe('Stage 2 · step 2/4 · 3m 5s · Which port?')
    for (const r of rows) expect(r.color).toBe(STATE_COLOR.needs_input)
  })

  test('a long title is cut and keeps the state name', () => {
    const rows = planRows(plan(3, 4, 5, 'error', { title: 'x'.repeat(200) }), NOW, 40)
    expect(rows[0]!.line.length).toBeLessThanOrEqual(40)
    expect(rows[0]!.line.endsWith('…  Error')).toBe(true)
  })

  test('todo kind, 0% and 100%', () => {
    expect(planRows({ ...plan(1, 5, 2), kind: 'todo' }, NOW, 40)[2]!.line).toBe('step 3/5 · 3m 5s')
    const zero = planRows(plan(2, 3, 0), NOW, 40)[1]!.line
    expect(zero).toBe('░'.repeat(37) + ' 0%')
    const full = planRows(plan(2, 3, 6, 'done'), NOW, 40)[1]!.line
    expect(full).toBe('█'.repeat(35) + ' 100%')
  })

  test('no stages still gives three fitting rows', () => {
    const rows = planRows({ ...plan(1, 1, 0), stages: [] }, NOW, 30)
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.line.length).toBeLessThanOrEqual(30)
    expect(rows.map(r => r.line).join('')).not.toContain('NaN')
  })

  test('tiny columns give one short row', () => {
    for (const columns of [0, 3, 8, 11, -2, NaN]) {
      const rows = planRows(mid(), NOW, columns)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.line.length).toBeLessThanOrEqual(Math.max(0, Number.isFinite(columns) ? columns : 0))
    }
    expect(planRows(mid(), NOW, 8)[0]!.line).toBe('42%')
  })

  test('the pill text is dark on the light pills (amber, green) and white on violet and red', () => {
    const textFill = (state: string) => {
      const { body } = planSvg(400, { ...PLAN_FOR_PILL, state } as any, 0)
      return /<text[^>]*font-weight="600" fill="(#[0-9a-f]{6})">[A-Z]/.exec(body)![1]
    }
    expect(textFill('needs_input')).not.toBe('#ffffff')
    expect(textFill('done')).not.toBe('#ffffff')
    expect(textFill('running')).toBe('#ffffff')
    expect(textFill('error')).toBe('#ffffff')
  })
})
