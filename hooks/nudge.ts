// The step-list nudge: a worker with an active step that makes STEP_NUDGE_AFTER tool calls without a `step` call gets one
// line appended to that call's result (the `context` a tool.call result carries, which the model reads and the user does not).
export const STEP_NUDGE_AFTER = 8
export const STEP_NUDGE = 'flowdeck: update your step list now (mcp__flowdeck__step, next: true) before continuing'

// Counts one call of `agentId` since its last step call; true on every STEP_NUDGE_AFTER-th, which restarts the count.
export function countCall(calls: Map<string, number>, agentId: string): boolean {
  const n = (calls.get(agentId) ?? 0) + 1
  if (n < STEP_NUDGE_AFTER) {
    calls.set(agentId, n)
    return false
  }
  calls.set(agentId, 0)
  return true
}

// The call's result with the nudge line added to its context; a refused call or an odd result comes back as it was.
export function withNudgeLine<R>(result: R): R {
  const r = result as { deny?: unknown; context?: unknown } | null
  if (!r || typeof r !== 'object' || r.deny !== undefined) return result
  const kept = Array.isArray(r.context) ? r.context.filter((x): x is string => typeof x === 'string') : []
  return { ...r, context: [...kept, STEP_NUDGE] } as R
}
