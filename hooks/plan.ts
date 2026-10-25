// The task plan: stages of steps moved by short ops, ported from plan-progress 0.8.2 (MIT, Kirill Serditov).
import type { PlanStage, PlanState, PlanStep, PlanSubstep, StepStatus, TaskPlan } from '../types'
export type { PlanStage, PlanState, PlanStep, PlanSubstep, StepStatus, TaskPlan }

export type PlanInput = Record<string, unknown>
export type Where = { pos: number; total: number; stage: number; step: number; stageSize: number }

export const MAX_PLANS = 3
// the plan an approved plan-mode plan lands on; a revised plan updates it instead of opening a second one
export const PLAN_ID = 'plan'
export const STATUSES: StepStatus[] = ['pending', 'active', 'done', 'error', 'skipped']
const STATES: PlanState[] = ['running', 'needs_input', 'error', 'done']

// the cut drops half a character left at the edge (an emoji is two UTF-16 units)
export const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd() : '')
const status = (v: unknown): StepStatus => (STATUSES.includes(v as StepStatus) ? (v as StepStatus) : 'pending')
const list = (v: unknown): PlanInput[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []) as PlanInput[]
export const isFinished = (s: StepStatus) => s === 'done' || s === 'skipped'
// a saved step or substep: a title and a known status
export const isStoredStep = (st: unknown): st is { title: string; status: StepStatus } =>
  !!st && typeof st === 'object' && typeof (st as { title?: unknown }).title === 'string' && STATUSES.includes((st as { status?: unknown }).status as StepStatus)
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'plan'

export const planId = (input: PlanInput) => slug(str(input.id, 60) || str(input.title, 80))

// short updates: {next:true}, {done:[titles]}, {active:title}, {failed:title} against the stored plan;
// titles it cannot find come back in missing, so the call is refused instead of passing as a success
export function applyOps(stages: PlanStage[], input: PlanInput, now: number): { stages: PlanStage[]; missing: string[] } {
  const next = stages.map(s => ({ ...s, steps: s.steps.map(st => ({ ...st })) }))
  const steps = next.flatMap(s => s.steps)
  const missing: string[] = []
  const finish = (st: PlanStep) => {
    if (!isFinished(st.status)) Object.assign(st, { status: 'done', doneAt: now })
  }
  // a step opened again forgets when it was finished
  const reopen = (st: PlanStep, to: StepStatus) => {
    st.status = to
    delete st.doneAt
  }
  // a title used twice means the one still open
  const find = (title: string) => {
    const found = steps.find(st => same(st.title, title) && !isFinished(st.status)) ?? steps.find(st => same(st.title, title))
    if (!found) missing.push(title)
    return found
  }
  if (input.next === true) {
    const at = steps.findIndex(st => st.status === 'active') >= 0 ? steps.findIndex(st => st.status === 'active') : steps.findIndex(st => !isFinished(st.status))
    const cur = steps[at]
    if (cur) finish(cur)
    // past the last step, work goes back to one left open earlier
    const following = steps.slice(at + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following) following.status = 'active'
  }
  let lastDone = -1
  for (const t of Array.isArray(input.done) ? input.done : []) {
    const st = typeof t === 'string' ? find(t) : undefined
    if (st?.status === 'active') lastDone = steps.indexOf(st)
    if (st) finish(st)
  }
  // finishing the step in progress moves on, as next does, unless the call names the new one itself
  if (lastDone >= 0 && typeof input.active !== 'string' && !steps.some(st => st.status === 'active')) {
    const following = steps.slice(lastDone + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following) following.status = 'active'
  }
  const active = typeof input.active === 'string' ? find(input.active) : undefined
  if (active) {
    const at = steps.indexOf(active)
    steps.forEach((st, i) => {
      if (st.status === 'active' && i !== at) {
        if (i < at) finish(st)
        else st.status = 'pending'
      }
    })
    reopen(active, 'active')
  }
  const failed = typeof input.failed === 'string' ? find(input.failed) : undefined
  if (failed) reopen(failed, 'error')

  return { stages: next, missing }
}

// the new plan from the stored one and a tool call, or the refusal text for a call it cannot apply
export function normalize(input: PlanInput, prev: TaskPlan | null, now: number, id = planId(input)): TaskPlan | string {
  const sent = list(input.stages)
    .map(s => ({
      name: str(s.name, 80) || 'Stage',
      steps: list(s.steps).map(st => ({
        title: str(st.title) || 'Step',
        status: status(st.status),
        substeps: list(st.substeps).map(sub => ({ title: str(sub.title) || '…', status: status(sub.status) })),
      })),
    }))
    .filter(s => s.steps.length > 0) as PlanStage[]
  const isPartial = sent.length === 0 && prev !== null
  // a resent plan keeps what was finished; short ops sent along with it apply on top
  const base = isPartial ? prev.stages : pointAt(prev ? carryDone(sent, prev.stages) : sent)
  const { stages, missing } = applyOps(base, input, now)
  if (missing.length > 0 && base.length > 0) {
    const titles = stages.flatMap(s => s.steps.map(st => st.title)).join(', ')
    return `"${id}" has no step ${missing.map(t => `"${str(t, 60)}"`).join(', ')}. Its steps: ${titles.slice(0, 400)}`
  }
  if (stages.length === 0) return `no plan "${id}" yet; create it with title and stages.`
  const title = str(input.title, 80) || prev?.title || 'Plan'
  const steps = stages.flatMap(s => s.steps)
  const isAllDone = steps.length > 0 && steps.every(s => isFinished(s.status))
  const asked = input.state as PlanState
  const failedNow = typeof input.failed === 'string'
  const state: PlanState = STATES.includes(asked) ? asked : isAllDone ? 'done' : failedNow ? 'error' : 'running'

  return {
    id,
    title,
    kind: input.kind === 'todo' || (isPartial && prev?.kind === 'todo') ? 'todo' : 'plan',
    stages,
    state,
    note: str(input.note, 160) || null,
    startedAt: prev ? prev.startedAt : now,
    endedAt: state === 'done' ? (prev?.endedAt ?? now) : null,
  }
}

// a resent plan keeps what is finished: a step sent as pending under a title that was done stays done
// a title used twice: each finished step carries over to one resent step of that title, in order
export function carryDone(stages: PlanStage[], before: PlanStage[]): PlanStage[] {
  const finished = new Map<string, PlanStep[]>()
  for (const st of before.flatMap(s => s.steps).filter(st => isFinished(st.status))) {
    const key = st.title.trim().toLowerCase()
    finished.set(key, [...(finished.get(key) ?? []), st])
  }
  return stages.map(s => ({
    ...s,
    steps: s.steps.map(st => {
      const queue = finished.get(st.title.trim().toLowerCase())
      const was = queue?.[0]
      if (!queue || !was || !(st.status === 'pending' || st.status === was.status)) return st
      queue.shift()
      return { ...st, status: was.status, doneAt: was.doneAt }
    }),
  }))
}

// with nothing in progress, the first open step is the current one
export function pointAt(stages: PlanStage[]): PlanStage[] {
  const steps = stages.flatMap(s => s.steps)
  if (steps.some(st => st.status === 'active' || st.status === 'error')) return stages
  const first = steps.find(st => st.status === 'pending')
  return stages.map(s => ({ ...s, steps: s.steps.map(st => (st === first ? { ...st, status: 'active' as const } : st)) }))
}

const clean = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\s*(\d+[.)]|[-*+]|\[[ xX]\])\s+/, '')
    .replace(/^(\d+[.)]|\[[ xX]\])\s+/, '')
    .trim()

// a markdown plan: `#` the title, `##` and deeper the stages, list items the steps (indented ones substeps), `[x]` done
export function parsePlan(markdown: string, now: number): TaskPlan | null {
  let title = ''
  const headed: PlanStage[] = []
  const items: { depth: number; text: string; status: StepStatus }[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const text = clean(h[2] ?? '')
      if (h[1] === '#' && !title) title = text
      else headed.push({ name: text, steps: [] })
      continue
    }
    const li = line.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/)
    if (!li) continue
    const depth = Math.floor((li[1] ?? '').replace(/\t/g, '  ').length / 2)
    const text = clean(li[3] ?? '').slice(0, 120)
    if (!text) continue
    const status: StepStatus = /^\[[xX]\]\s/.test(li[3] ?? '') ? 'done' : 'pending'
    items.push({ depth, text, status })
    const stage = headed[headed.length - 1]
    if (!stage) continue
    const step = stage.steps[stage.steps.length - 1]
    if (depth === 0 || !step) stage.steps.push({ title: text, status, substeps: [] })
    else step.substeps.push({ title: text, status })
  }
  let stages = headed.filter(s => s.steps.length > 0)
  if (stages.length === 0) {
    if (items.some(i => i.depth > 0)) {
      for (const item of items) {
        const stage = stages[stages.length - 1]
        if (item.depth === 0 || !stage) stages.push({ name: item.text, steps: [] })
        else stage.steps.push({ title: item.text, status: item.status, substeps: [] })
      }
      stages = stages.map(s => (s.steps.length ? s : { ...s, steps: [{ title: s.name, status: 'pending', substeps: [] }] }))
    } else if (items.length > 0) {
      stages = [{ name: 'Tasks', steps: items.map(i => ({ title: i.text, status: i.status, substeps: [] })) }]
    }
  }
  if (stages.length === 0) return null

  return { id: PLAN_ID, title: title || 'Plan', kind: stages.length === 1 ? 'todo' : 'plan', stages, state: 'running', note: null, startedAt: now }
}

// an approved markdown plan over the plan it revises: done steps carry over by title, the start time stays
export function importPlan(markdown: string, prev: TaskPlan | null, now: number): TaskPlan | null {
  const parsed = parsePlan(markdown, now)
  if (!parsed) return null
  return prev ? { ...parsed, stages: pointAt(carryDone(parsed.stages, prev.stages)), startedAt: prev.startedAt } : { ...parsed, stages: pointAt(parsed.stages) }
}

// pos counts the finished steps wherever they are; the current step is the active one, else the first still open
export function where(p: TaskPlan): Where {
  const steps = p.stages.flatMap((s, i) => s.steps.map((step, j) => ({ i, j, step })))
  const pos = p.state === 'done' ? steps.length : steps.filter(x => isFinished(x.step.status)).length
  const cur = p.state === 'done' ? undefined : (steps.find(x => x.step.status === 'active') ?? steps.find(x => !isFinished(x.step.status)))
  const stage = (cur ?? steps[steps.length - 1])?.i ?? 0

  return { pos, total: steps.length, stage, step: cur ? cur.j + 1 : (p.stages[stage]?.steps.length ?? 0), stageSize: p.stages[stage]?.steps.length ?? 0 }
}

// an unfinished plan stops at 99%: 199 of 200 steps would otherwise round up to 100%
export function percent(p: TaskPlan, w: { pos: number; total: number }): number {
  if (p.state === 'done') return 100
  return Math.min(99, Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100))
}

export const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  return sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

// how long each finished step took (from the previous finish, or the plan's start) and each finished stage
// kept for the planned hover overlay; only the tests call it for now
export function stepTimes(p: TaskPlan): { steps: Map<PlanStep, number>; stages: (number | undefined)[] } {
  const ends = p.stages.flatMap(s => s.steps).flatMap(st => (st.doneAt === undefined ? [] : [st.doneAt])).sort((a, b) => a - b)
  const startOf = (at: number) => Math.max(p.startedAt, ...ends.filter(t => t < at))
  const steps = new Map<PlanStep, number>()
  const stages = p.stages.map(s => {
    for (const st of s.steps) if (st.doneAt !== undefined) steps.set(st, st.doneAt - startOf(st.doneAt))
    const times = s.steps.map(st => st.doneAt)
    if (times.some(t => t === undefined)) return undefined
    const done = times as number[]
    return Math.max(...done) - Math.min(...done.map(startOf))
  })
  return { steps, stages }
}

// adds or replaces one plan by id; keeps at most MAX_PLANS, dropping the oldest finished one first, then the oldest
// running one; the plan just placed and plans waiting on the person or in error stay while any other can go
export function placeBar(plans: readonly TaskPlan[], next: TaskPlan): TaskPlan[] {
  const has = plans.some(p => p.id === next.id)
  const rest = has ? plans.map(p => (p.id === next.id ? next : p)) : [...plans, next]
  const pick = (ok: (p: TaskPlan) => boolean) => rest.findIndex(p => p.id !== next.id && ok(p))
  while (rest.length > MAX_PLANS) {
    const at = [pick(p => p.state === 'done'), pick(p => p.state === 'running'), pick(() => true)].find(i => i >= 0) ?? 0
    rest.splice(at, 1)
  }
  return rest
}
