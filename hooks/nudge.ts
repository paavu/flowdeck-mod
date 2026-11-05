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

// The plan nudge: with task tracking on and no flow open, the main session's first work call of a turn gets this line,
// and again every PLAN_NUDGE_EVERY-th work call after it while still no flow is open.
export const PLAN_NUDGE =
  'flowdeck: task tracking is on and no flow is open. Plan this task with mcp__flowdeck__progress (title, tasks, tier) before going on: every task that does work needs a flow, even a single edit (a flow of one task), and so do multi-file edits, scripted rewrites, builds, renders, trials and bumps. Only an answer with no work calls needs none.'
export const PLAN_NUDGE_EVERY = 3

// True for the n-th work call (from 1) since the turn started or a flow was last open: the 1st, then every PLAN_NUDGE_EVERY-th after it.
export const isPlanNudgeCall = (n: number): boolean => n >= 1 && (n - 1) % PLAN_NUDGE_EVERY === 0

// The turn-end check: a main turn that made work calls with tracking on and no flow open is sent back once with this.
export const PLAN_SEND_BACK =
  'flowdeck: task tracking is on and this turn did work with no flow open; every task that does work needs a flow, even a single edit. Open one now with mcp__flowdeck__progress (ToolSearch select:mcp__flowdeck__progress if deferred): a title and the tasks this turn carried out, then done with their numbers and a result note for each. Then end the turn.'

// The turn-end check for an open flow: a main turn that did work while a flow is open, ended with no run going and tasks
// of the flow not reported done, is sent back once with this.
export const FLOW_SEND_BACK =
  'flowdeck: this turn did work and the open flow still has tasks not reported done. With mcp__flowdeck__progress, report done with their numbers and a result note for each task this turn finished, and add or plan the tasks that remain. Then end the turn.'

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
