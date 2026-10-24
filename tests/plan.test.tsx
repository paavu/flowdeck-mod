import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_PLANS,
  PLAN_ID,
  applyOps,
  carryDone,
  elapsed,
  importPlan,
  normalize,
  parsePlan,
  percent,
  placeBar,
  planId,
  pointAt,
  slug,
  stepTimes,
  where,
} from '../hooks/plan'
import type { TaskPlan } from '../hooks/plan'

// Cases ported from plan-progress 0.8.2 tests/regress.mjs keep its ids (T01, T13, ...) in their names.

const NOW = 1_000_000
type Raw = Record<string, unknown>
const S = (name: string, ...steps: (string | Raw)[]) => ({ name, steps: steps.map(s => (typeof s === 'string' ? { title: s, status: 'pending' } : s)) })
const st = (title: string, status: string) => ({ title, status })
const three = () => [S('One', st('A', 'active'), 'B'), S('Two', 'C')]

const steps = (p: TaskPlan) =>
  p.stages
    .flatMap(s => s.steps)
    .map(x => `${x.title}:${x.status}`)
    .join(' ')
const plan = (made: TaskPlan | string): TaskPlan => {
  if (typeof made === 'string') throw new Error(`refused: ${made}`)
  return made
}
// One plan worked through calls, as the tool will: each call builds on the plan the last one returned.
const session = (first: Raw, at = NOW) => {
  let cur = plan(normalize(first, null, at))
  return {
    get p() {
      return cur
    },
    call(input: Raw, now = NOW) {
      const made = normalize({ id: cur.id, ...input }, cur, now)
      if (typeof made !== 'string') cur = made
      return made
    },
  }
}
const create = (id = 't', stages: unknown = three(), title = 'Task') => session({ id, title, stages })

describe('creating a plan', () => {
  test('the first open step becomes active and the position starts at zero', () => {
    const { p } = create()
    expect(steps(p)).toBe('A:active B:pending C:pending')
    expect(p.id).toBe('t')
    expect(p.title).toBe('Task')
    expect(p.kind).toBe('plan')
    expect(p.state).toBe('running')
    expect(p.note).toBeNull()
    expect(p.startedAt).toBe(NOW)
    expect(p.endedAt).toBeNull()
    const w = where(p)
    expect(w).toEqual({ pos: 0, total: 3, stage: 0, step: 1, stageSize: 2 })
    expect(percent(p, w)).toBe(0)
  })

  test('T06 steps sent without a status start pending, the first one active', () => {
    const { p } = session({ id: 't', title: 'Task', stages: [{ name: 'One', steps: [{ title: 'A' }, { title: 'B' }] }] })
    expect(steps(p)).toBe('A:active B:pending')
  })

  test('T12 steps sent out of order: the active one is current, done ones count wherever they are', () => {
    const { p } = session({ id: 't', title: 'Task', stages: [S('First', st('A', 'pending')), S('Second', st('B', 'active'), st('C', 'done'))] })
    const w = where(p)
    expect(w.pos).toBe(1)
    expect(w.total).toBe(3)
    expect(p.stages[w.stage]!.name).toBe('Second')
    expect(percent(p, w)).toBe(33)
  })

  test('kind todo makes a flat list, and short ops keep it a todo', () => {
    const s = session({ id: 'list', title: 'Errands', kind: 'todo', stages: [S('Tasks', 'Milk', 'Bread')] })
    expect(s.p.kind).toBe('todo')
    s.call({ next: true })
    expect(s.p.kind).toBe('todo')
    expect(steps(s.p)).toBe('Milk:done Bread:active')
  })

  test('stages with no steps are dropped and empty names and titles get defaults', () => {
    const { p } = session({ id: 't', title: '', stages: [{ name: '', steps: [{ title: '' }] }, { name: 'Empty', steps: [] }] })
    expect(p.stages.map(s => s.name)).toEqual(['Stage'])
    expect(p.stages[0]!.steps[0]!.title).toBe('Step')
    expect(p.title).toBe('Plan')
  })

  test('titles, stage names and notes are capped, and a cut never leaves half an emoji', () => {
    const { p } = session({ id: 't', title: 'a'.repeat(79) + '😀 tail', note: 'n'.repeat(300), stages: [S('s'.repeat(100), 'x'.repeat(200))] })
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p.title)).toBe(false)
    expect(p.title.length).toBeLessThanOrEqual(80)
    expect(p.stages[0]!.name.length).toBe(80)
    expect(p.stages[0]!.steps[0]!.title.length).toBe(120)
    expect(p.note!.length).toBe(160)
  })

  test('whitespace in titles is collapsed', () => {
    const { p } = session({ id: 't', title: '  Fix \n the   login ', stages: [S('One', 'A')] })
    expect(p.title).toBe('Fix the login')
  })
})

describe('ids', () => {
  test('ids are slugged, and a plan without an id takes its title', () => {
    expect(slug('My Big Task!')).toBe('my-big-task')
    expect(slug('Проверка тестов')).toBe('проверка-тестов')
    expect(slug('!!!')).toBe('plan')
    expect(slug('x'.repeat(60)).length).toBe(40)
    expect(planId({ id: 'Release v2' })).toBe('release-v2')
    expect(planId({ title: 'Fix the login' })).toBe('fix-the-login')
    expect(planId({})).toBe('plan')
  })

  test('normalize slugs the id it is given in the input', () => {
    const made = plan(normalize({ id: 'Deploy API', title: 'Deploy', stages: [S('One', 'A')] }, null, NOW))
    expect(made.id).toBe('deploy-api')
  })
})

describe('short ops', () => {
  test('T01 next finishes the active step and opens the following one', () => {
    const s = create()
    s.call({ next: true }, NOW + 5000)
    s.call({ next: true }, NOW + 9000)
    expect(steps(s.p)).toBe('A:done B:done C:active')
    expect(s.p.stages[0]!.steps.map(x => x.doneAt)).toEqual([NOW + 5000, NOW + 9000])
    expect(percent(s.p, where(s.p))).toBe(67)
  })

  test('done on the active step moves on as next does', () => {
    const s = create()
    s.call({ done: ['A'] })
    expect(steps(s.p)).toBe('A:done B:active C:pending')
  })

  test('done on several steps, the last one active, ends at the following open step', () => {
    const s = create()
    s.call({ done: ['A', 'B'] })
    expect(steps(s.p)).toBe('A:done B:done C:active')
  })

  test('titles match regardless of case and surrounding space', () => {
    const s = create()
    s.call({ done: ['  a '] })
    expect(steps(s.p)).toBe('A:done B:active C:pending')
  })

  test('T11 active forward finishes the earlier active step and leaves the skipped one open', () => {
    const s = create()
    s.call({ active: 'C' })
    expect(steps(s.p)).toBe('A:done B:pending C:active')
  })

  test('active backward puts the later active step back to pending', () => {
    const s = create()
    s.call({ active: 'C' })
    s.call({ active: 'B' })
    expect(steps(s.p)).toBe('A:done B:active C:pending')
  })

  test('reopened step forgets its finish time', () => {
    const s = create()
    s.call({ next: true }, NOW + 5000)
    s.call({ active: 'A' }, NOW + 10_000)
    const a = s.p.stages[0]!.steps[0]!
    expect(a.status).toBe('active')
    expect(a.doneAt).toBeUndefined()
  })

  test('failed marks the step error, the plan error, and keeps the note', () => {
    const s = create()
    s.call({ failed: 'A', note: 'tests failed' })
    expect(steps(s.p)).toBe('A:error B:pending C:pending')
    expect(s.p.state).toBe('error')
    expect(s.p.note).toBe('tests failed')
  })

  test('state needs_input with a note, then running again', () => {
    const s = create()
    s.call({ state: 'needs_input', note: 'Pick one' })
    expect(s.p.state).toBe('needs_input')
    expect(s.p.note).toBe('Pick one')
    expect(steps(s.p)).toBe('A:active B:pending C:pending')
    s.call({ state: 'running' })
    expect(s.p.state).toBe('running')
    expect(s.p.note).toBeNull()
  })

  test('a note alone keeps the steps', () => {
    const s = create()
    s.call({ next: true })
    s.call({ note: 'checking' })
    expect(s.p.note).toBe('checking')
    expect(steps(s.p)).toBe('A:done B:active C:pending')
  })

  test('T22 state done reads all steps and records when it ended', () => {
    const s = create()
    s.call({ state: 'done' }, NOW + 125_000)
    const w = where(s.p)
    expect(s.p.state).toBe('done')
    expect(w.pos).toBe(3)
    expect(w.total).toBe(3)
    expect(percent(s.p, w)).toBe(100)
    expect(s.p.endedAt).toBe(NOW + 125_000)
    expect(elapsed(s.p.endedAt! - s.p.startedAt)).toBe('2m 5s')
    // a later call keeps the first end time
    s.call({ state: 'done' }, NOW + 200_000)
    expect(s.p.endedAt).toBe(NOW + 125_000)
  })

  test('finishing every step makes the plan done by itself', () => {
    const s = create()
    s.call({ done: ['A', 'B', 'C'] }, NOW + 1000)
    expect(s.p.state).toBe('done')
    expect(s.p.endedAt).toBe(NOW + 1000)
  })

  test('T32 next past the last step goes back to one left open earlier, then the plan is done', () => {
    const s = session({ id: 't', title: 'Task', stages: [S('One', 'A', st('B', 'active'), 'C')] })
    s.call({ next: true })
    s.call({ next: true })
    expect(steps(s.p)).toBe('A:active B:done C:done')
    s.call({ next: true })
    expect(s.p.state).toBe('done')
  })

  test('T13 a title used twice means the one still open', () => {
    const s = session({ id: 't', title: 'Task', stages: [S('Backend', st('API', 'active'), 'Tests'), S('Frontend', 'UI', 'Tests')] })
    s.call({ done: ['Tests'] })
    expect(steps(s.p)).toBe('API:active Tests:done UI:pending Tests:pending')
    s.call({ done: ['Tests'] })
    expect(steps(s.p)).toBe('API:active Tests:done UI:pending Tests:done')
  })

  test('T15 ops sent along with stages apply on top of them', () => {
    const s = create()
    s.call({ stages: three(), next: true })
    expect(steps(s.p)).toBe('A:done B:active C:pending')
  })

  test('applyOps does not change the stages it is given', () => {
    const base = plan(normalize({ id: 't', title: 'Task', stages: three() }, null, NOW)).stages
    const { stages, missing } = applyOps(base, { next: true }, NOW)
    expect(missing).toEqual([])
    expect(base[0]!.steps.map(x => x.status)).toEqual(['active', 'pending'])
    expect(stages[0]!.steps.map(x => x.status)).toEqual(['done', 'active'])
  })

  test('applyOps returns the titles it cannot find', () => {
    const base = plan(normalize({ id: 't', title: 'Task', stages: three() }, null, NOW)).stages
    expect(applyOps(base, { done: ['A', 'Nope'], failed: 'Gone' }, NOW).missing).toEqual(['Nope', 'Gone'])
  })

  test('unfinished plan never reads 100%', () => {
    const many = Array.from({ length: 200 }, (_, i) => st(`S${i}`, i < 199 ? 'done' : 'active'))
    const { p } = session({ id: 't', title: 'Big', stages: [S('N', ...many)] })
    expect(p.state).toBe('running')
    expect(percent(p, where(p))).toBe(99)
  })
})

describe('refusals', () => {
  test('T14 an unknown title is refused with the plan steps listed, and the plan is unchanged', () => {
    const s = create()
    const r = s.call({ done: ['Nonexistent'] })
    expect(r).toBe('"t" has no step "Nonexistent". Its steps: A, B, C')
    expect(steps(s.p)).toBe('A:active B:pending C:pending')
  })

  test('T21 an unknown failed step is refused and the state stays running', () => {
    const s = create()
    const r = s.call({ failed: 'Nope' })
    expect(typeof r).toBe('string')
    expect(r as string).toContain('"Nope"')
    expect(s.p.state).toBe('running')
  })

  test('several unknown titles are all named', () => {
    const s = create()
    expect(s.call({ done: ['X', 'A'], active: 'Y' })).toBe('"t" has no step "X", "Y". Its steps: A, B, C')
  })

  test('short ops on a plan that does not exist are refused', () => {
    expect(normalize({ id: 'x', next: true }, null, NOW)).toBe('no plan "x" yet; create it with title and stages.')
    expect(normalize({ id: 'x', done: ['A'] }, null, NOW)).toBe('no plan "x" yet; create it with title and stages.')
    expect(normalize({ title: 'Ghost', stages: [] }, null, NOW)).toBe('no plan "ghost" yet; create it with title and stages.')
  })
})

describe('resending the plan', () => {
  test('T05 resent stages without status keep done by title', () => {
    const s = create()
    s.call({ next: true })
    s.call({ next: true })
    s.call({ stages: [S('One', 'A', 'B'), S('Two', 'C', 'D')] })
    expect(steps(s.p)).toBe('A:done B:done C:active D:pending')
  })

  test('T03 a step appended after two of three moves the percent from 67 to 50', () => {
    const s = create()
    s.call({ next: true })
    s.call({ next: true })
    expect(percent(s.p, where(s.p))).toBe(67)
    s.call({ stages: [S('One', st('A', 'done'), st('B', 'done')), S('Two', st('C', 'active'), 'D')] })
    expect(percent(s.p, where(s.p))).toBe(50)
  })

  test('T02 a changed plan replaces the steps and keeps the done ones it names', () => {
    const s = create()
    s.call({ next: true })
    s.call({ stages: [S('New', st('C', 'active'), st('A', 'done'), st('B2', 'pending'))] })
    expect(steps(s.p)).toBe('C:active A:done B2:pending')
  })

  test('T05b a step resent as active is worked again', () => {
    const s = create()
    s.call({ next: true })
    s.call({ stages: three() })
    expect(steps(s.p)).toBe('A:active B:pending C:pending')
  })

  test('a resent plan keeps the start time and takes a new title', () => {
    const s = create()
    s.call({ title: 'Task, revised', stages: three() }, NOW + 60_000)
    expect(s.p.startedAt).toBe(NOW)
    expect(s.p.title).toBe('Task, revised')
  })

  test('a resent repeated title carries over only as many done steps as there were', () => {
    const s = session({ id: 't', title: 'Task', stages: [S('One', 'Test', 'B'), S('Two', 'Test', 'C')] })
    s.call({ next: true })
    s.call({ stages: [S('One', 'Test', 'B'), S('Two', 'Test', 'C')] })
    expect(steps(s.p)).toBe('Test:done B:active Test:pending C:pending')
  })

  test('carryDone keeps the finish time and pointAt leaves an active step alone', () => {
    const before = [{ name: 'One', steps: [{ title: 'A', status: 'done' as const, substeps: [], doneAt: 42 }] }]
    const sent = [{ name: 'One', steps: [{ title: 'a', status: 'pending' as const, substeps: [] }, { title: 'B', status: 'pending' as const, substeps: [] }] }]
    const carried = carryDone(sent, before)
    expect(carried[0]!.steps[0]!.status).toBe('done')
    expect(carried[0]!.steps[0]!.doneAt).toBe(42)
    expect(pointAt(carried)[0]!.steps.map(x => x.status)).toEqual(['done', 'active'])
    const busy = [{ name: 'One', steps: [{ title: 'A', status: 'error' as const, substeps: [] }, { title: 'B', status: 'pending' as const, substeps: [] }] }]
    expect(pointAt(busy)).toBe(busy)
  })
})

describe('placeBar', () => {
  const made = (id: string, state?: string) => {
    const p = plan(normalize({ id, title: id, stages: three() }, null, NOW))
    return state ? plan(normalize({ id, state }, p, NOW)) : p
  }

  test('keeps at most three plans', () => {
    expect(MAX_PLANS).toBe(3)
  })

  test('a fourth plan evicts a finished one first', () => {
    let list: TaskPlan[] = []
    for (const p of [made('a'), made('b', 'done'), made('c')]) list = placeBar(list, p)
    list = placeBar(list, made('d'))
    expect(list.map(p => p.id).join(',')).toBe('a,c,d')
  })

  test('with none finished the oldest running one goes, never the plan just placed', () => {
    let list: TaskPlan[] = []
    for (const id of ['a', 'b', 'c']) list = placeBar(list, made(id))
    list = placeBar(list, plan(normalize({ id: 'd', title: 'd', stages: [S('One', st('A', 'done'), st('B', 'done'))] }, null, NOW)))
    expect(list.map(p => p.id).join(',')).toBe('b,c,d')
  })

  test('plans waiting on the person or in error stay while a running one can go', () => {
    let list: TaskPlan[] = []
    for (const p of [made('a', 'needs_input'), made('b', 'error'), made('c')]) list = placeBar(list, p)
    list = placeBar(list, made('d'))
    expect(list.map(p => p.id).join(',')).toBe('a,b,d')
  })

  test('when only waiting plans are left, the oldest of them goes', () => {
    let list: TaskPlan[] = []
    for (const id of ['a', 'b', 'c']) list = placeBar(list, made(id, 'needs_input'))
    list = placeBar(list, made('d'))
    expect(list.map(p => p.id).join(',')).toBe('b,c,d')
  })

  test('an update replaces the plan in its place', () => {
    let list: TaskPlan[] = []
    for (const id of ['a', 'b', 'c']) list = placeBar(list, made(id))
    const before = list
    list = placeBar(list, made('b', 'done'))
    expect(list.map(p => `${p.id}:${p.state}`).join(',')).toBe('a:running,b:done,c:running')
    expect(before.length).toBe(3)
    expect(before[1]!.state).toBe('running')
  })
})

describe('parsePlan', () => {
  const md = '# Fix login\n\n## Analyse\n- [x] Read code\n- [ ] Find **the** bug\n## Fix\n1. Patch [auth](src/auth.ts)\n2) Test\n   - unit\n'

  test('# is the title, ## the stages, list items the steps, ticked boxes start done', () => {
    const p = parsePlan(md, NOW)!
    expect(p.id).toBe(PLAN_ID)
    expect(p.title).toBe('Fix login')
    expect(p.kind).toBe('plan')
    expect(p.state).toBe('running')
    expect(p.startedAt).toBe(NOW)
    expect(p.stages.map(s => s.name)).toEqual(['Analyse', 'Fix'])
    expect(steps(p)).toBe('Read code:done Find the bug:pending Patch auth:pending Test:pending')
    expect(p.stages[1]!.steps[1]!.substeps).toEqual([{ title: 'unit', status: 'pending' }])
  })

  test('without headings a flat list is one todo stage', () => {
    const p = parsePlan('- one\n- two\n* three', NOW)!
    expect(p.title).toBe('Plan')
    expect(p.kind).toBe('todo')
    expect(p.stages).toEqual([{ name: 'Tasks', steps: ['one', 'two', 'three'].map(title => ({ title, status: 'pending', substeps: [] })) }])
  })

  test('without headings a nested list makes the top items stages', () => {
    const p = parsePlan('# T\n1. Setup\n   - Install\n   - Configure\n2. Ship', NOW)!
    expect(p.stages.map(s => s.name)).toEqual(['Setup', 'Ship'])
    expect(steps(p)).toBe('Install:pending Configure:pending Ship:pending')
  })

  test('text without list items is no plan', () => {
    expect(parsePlan('# Title\n\nJust prose.', NOW)).toBeNull()
  })

  test('T10 an imported plan with ticked boxes points at the first open step', () => {
    const p = importPlan('# Ship\n- [x] Read code\n- [x] Find bug\n- [ ] Patch', null, NOW)!
    expect(steps(p)).toBe('Read code:done Find bug:done Patch:active')
  })

  test('T08 a revised plan imported again keeps what was done and the start time', () => {
    const text = '# Fix login\n\n## Analyse\n- Read code\n- Find bug\n## Fix\n- Patch\n- Test'
    let p = importPlan(text, null, NOW)!
    p = plan(normalize({ id: PLAN_ID, next: true }, p, NOW + 1000))
    p = plan(normalize({ id: PLAN_ID, next: true }, p, NOW + 2000))
    const again = importPlan(text + '\n- Deploy', p, NOW + 3000)!
    expect(steps(again)).toBe('Read code:done Find bug:done Patch:active Test:pending Deploy:pending')
    expect(again.startedAt).toBe(NOW)
  })

  test('T09 a new title lands on the same plan', () => {
    const first = importPlan('# Fix login\n## A\n- One\n- Two\n## B\n- Three', null, NOW)!
    const second = importPlan('# Fix login flow\n## A\n- One\n- Two\n## B\n- Three', first, NOW)!
    const list = placeBar(placeBar([], first), second)
    expect(list.length).toBe(1)
    expect(list[0]!.title).toBe('Fix login flow')
  })

  test('importPlan of text with no plan is null', () => {
    expect(importPlan('nothing here', null, NOW)).toBeNull()
  })
})

describe('times', () => {
  test('elapsed reads seconds, minutes and hours', () => {
    expect(elapsed(-5)).toBe('0s')
    expect(elapsed(45_000)).toBe('45s')
    expect(elapsed(125_000)).toBe('2m 5s')
    expect(elapsed(3_900_000)).toBe('1h 5m')
  })

  test('stepTimes measures each finished step from the previous finish and each finished stage', () => {
    const s = create()
    s.call({ next: true }, NOW + 5000)
    s.call({ next: true }, NOW + 12_000)
    const t = stepTimes(s.p)
    const [a, b] = s.p.stages[0]!.steps
    expect(t.steps.get(a!)).toBe(5000)
    expect(t.steps.get(b!)).toBe(7000)
    expect(t.steps.size).toBe(2)
    expect(t.stages).toEqual([12_000, undefined])
  })

  test('where on a finished plan sits at the end of the last stage', () => {
    const s = create()
    s.call({ state: 'done' })
    expect(where(s.p)).toEqual({ pos: 3, total: 3, stage: 1, step: 1, stageSize: 1 })
  })
})
