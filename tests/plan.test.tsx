import { describe, expect, test } from 'claude-code/testing'

import { elapsed, isFinished, isStoredStep, percent, str, where } from '../hooks/plan'
import type { StepStatus, TaskPlan } from '../hooks/plan'

// What is left of the plan model (1.0.0035): the helpers an archived plan's drawing and the panel share.

const st = (title: string, status: StepStatus) => ({ title, status, substeps: [] })
const planOf = (stages: TaskPlan['stages'], state: TaskPlan['state'] = 'running'): TaskPlan => ({ id: 't', title: 'Task', kind: 'plan', stages, state, note: null, startedAt: 0 })
const three = (a: StepStatus, b: StepStatus, c: StepStatus) => [
  { name: 'One', steps: [st('A', a), st('B', b)] },
  { name: 'Two', steps: [st('C', c)] },
]

describe('where and percent', () => {
  test('pos counts the finished steps wherever they are; the current step is the active one, else the first open', () => {
    expect(where(planOf(three('done', 'active', 'pending')))).toEqual({ pos: 1, total: 3, stage: 0, step: 2, stageSize: 2 })
    expect(where(planOf(three('pending', 'done', 'pending')))).toEqual({ pos: 1, total: 3, stage: 0, step: 1, stageSize: 2 })
    expect(where(planOf(three('done', 'skipped', 'pending')))).toEqual({ pos: 2, total: 3, stage: 1, step: 1, stageSize: 1 })
  })

  test('where on a finished plan sits at the end of the last stage', () => {
    expect(where(planOf(three('done', 'done', 'pending'), 'done'))).toEqual({ pos: 3, total: 3, stage: 1, step: 1, stageSize: 1 })
  })

  test('unfinished plan never reads 100%; a done one always does', () => {
    const many = Array.from({ length: 200 }, (_, i) => st(`S${i}`, i < 199 ? 'done' : 'active'))
    const p = planOf([{ name: 'N', steps: many }])
    expect(percent(p, where(p))).toBe(99)
    const done = planOf(three('pending', 'pending', 'pending'), 'done')
    expect(percent(done, where(done))).toBe(100)
    expect(percent(planOf([]), where(planOf([])))).toBe(0)
  })
})

describe('small helpers', () => {
  test('elapsed reads seconds, minutes and hours', () => {
    expect(elapsed(-5)).toBe('0s')
    expect(elapsed(45_000)).toBe('45s')
    expect(elapsed(125_000)).toBe('2m 5s')
    expect(elapsed(3_900_000)).toBe('1h 5m')
  })

  test('str collapses whitespace, caps the length and never leaves half an emoji', () => {
    expect(str('  Fix \n the   login ')).toBe('Fix the login')
    expect(str(5)).toBe('')
    const cut = str('a'.repeat(79) + '😀 tail', 80)
    expect(cut.length).toBeLessThanOrEqual(80)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false)
  })

  test('isFinished: done and skipped; isStoredStep: a title and a known status', () => {
    expect((['pending', 'active', 'done', 'error', 'skipped'] as StepStatus[]).filter(isFinished)).toEqual(['done', 'skipped'])
    expect(isStoredStep({ title: 'a', status: 'done' })).toBe(true)
    expect(isStoredStep({ title: 'a', status: 'weird' })).toBe(false)
    expect(isStoredStep({ status: 'done' })).toBe(false)
    expect(isStoredStep(null)).toBe(false)
  })
})
