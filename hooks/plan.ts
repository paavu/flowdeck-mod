// The task plan an older flowdeck saved in the Archive, and the small helpers the panel shares; ported from
// plan-progress 0.8.2 (MIT, Kirill Serditov).
import type { PlanStage, PlanState, PlanStep, PlanSubstep, StepStatus, TaskPlan } from '../types'
export type { PlanStage, PlanState, PlanStep, PlanSubstep, StepStatus, TaskPlan }

export type Where = { pos: number; total: number; stage: number; step: number; stageSize: number }

export const STATUSES: StepStatus[] = ['pending', 'active', 'done', 'error', 'skipped']

// the cut drops half a character left at the edge (an emoji is two UTF-16 units)
export const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd() : '')
export const isFinished = (s: StepStatus) => s === 'done' || s === 'skipped'
// a saved step or substep: a title and a known status
export const isStoredStep = (st: unknown): st is { title: string; status: StepStatus } =>
  !!st && typeof st === 'object' && typeof (st as { title?: unknown }).title === 'string' && STATUSES.includes((st as { status?: unknown }).status as StepStatus)

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
