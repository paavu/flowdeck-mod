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

// The plan nudge: with task tracking on and no flow open, the main session's first work call of a turn gets this line.
export const PLAN_NUDGE =
  'flowdeck: task tracking is on and no flow is open. If this is a task of two or more steps (a trial, a branch, a bump, a build count), plan it with mcp__flowdeck__progress (title, tasks, tier) before going on. A question or a one-step edit needs no flow.'

// Calls that only look or ask: they never start the plan nudge. Everything else (edits, shells, workers) is work.
const LOOKING_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Skill', 'TodoWrite', 'TaskList', 'TaskGet',
  'mcp__lean-ctx__ctx_read', 'mcp__lean-ctx__ctx_search', 'mcp__lean-ctx__ctx_tree', 'mcp__lean-ctx__ctx_glob', 'mcp__lean-ctx__ctx_overview',
])
export const isWorkCall = (tool: string): boolean => !LOOKING_TOOLS.has(tool) && !tool.startsWith('mcp__flowdeck__')

// The call's result with the nudge line added to its context; a refused call or an odd result comes back as it was.
export function withNudgeLine<R>(result: R, line: string = STEP_NUDGE): R {
  const r = result as { deny?: unknown; context?: unknown } | null
  if (!r || typeof r !== 'object' || r.deny !== undefined) return result
  const kept = Array.isArray(r.context) ? r.context.filter((x): x is string => typeof x === 'string') : []
  return { ...r, context: [...kept, line] } as R
}
