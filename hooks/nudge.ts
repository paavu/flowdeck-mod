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

// The step reminder: a running session whose system prompt may predate the step instruction in FLOW_RULE (a plugin update
// picked up with /reload-plugins swaps the hooks, not the prompt) gets this line on its own work calls while it does a task
// of the open flow itself without a step list: the first such call per task, then every STEP_REMIND_EVERY-th.
export const STEP_REMIND_EVERY = 3
export const stepRemind = (n: number): string =>
  `flowdeck: you are doing task ${n} yourself; report it with mcp__flowdeck__step: \`steps\` (3-8 titles) once, then \`next: true\` as each ends (ToolSearch select:mcp__flowdeck__step if deferred).`

// The reminder's count for the task it last counted (`task`, a key): another task starts it over. True on the 1st call
// for a task, then every STEP_REMIND_EVERY-th.
export type RemindCount = { task: string; n: number }
export function countRemind(c: RemindCount, task: string): boolean {
  if (c.task !== task) {
    c.task = task
    c.n = 0
  }
  c.n++
  return (c.n - 1) % STEP_REMIND_EVERY === 0
}

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

// How many times countRemind has shown the step reminder for `task` (0 while it counts another task).
export const remindShown = (c: RemindCount, task: string): number => (c.task !== task || c.n < 1 ? 0 : Math.floor((c.n - 1) / STEP_REMIND_EVERY) + 1)

// Strict mode (rule.ts STRICT_KEY): with tracking on, a main-session work call is refused while no flow is open, and its
// own work on a task without a step list once the step reminder was shown STRICT_STEP_AFTER times for that task. After
// STRICT_DENY_MAX refusals in one main turn the rest of that turn goes through (the loop guard).
export const STRICT_STEP_AFTER = 2
export const STRICT_DENY_MAX = 2
export const STRICT_FLOW_DENY =
  'flowdeck strict mode: refused, no flow is open. Load mcp__flowdeck__progress (ToolSearch select:mcp__flowdeck__progress if deferred), plan this task with it (title, tasks), then retry this call.'
export const strictStepDeny = (n: number): string =>
  `flowdeck strict mode: refused, task ${n} has no step list. Send mcp__flowdeck__step with \`task: ${n}\` and \`steps\` (3-8 titles) (ToolSearch select:mcp__flowdeck__step if deferred), then retry this call.`

// Calls strict mode never refuses, beyond those isWorkCall does not count as work: these tool names (task bookkeeping,
// plan mode, waiting on or stopping a background job, read-only tools), and an MCP tool whose own name (after
// `mcp__<server>__`) starts with one of `mcpReadVerbs` (get_, list_, search_, ...). Anything else isWorkCall counts is refused.
export const STRICT_ALLOWED: { readonly tools: ReadonlySet<string>; readonly mcpReadVerbs: readonly string[] } = {
  tools: new Set([
    'TaskCreate', 'TaskUpdate', 'TaskOutput', 'TaskStop', 'KillShell', 'BashOutput', 'Monitor', 'EnterPlanMode', 'ExitPlanMode',
    'NotebookRead', 'LSP', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ListSkills', 'SearchSkills', 'ListPlugins',
    'mcp__lean-ctx__ctx_compose', 'mcp__lean-ctx__ctx_expand', 'mcp__lean-ctx__ctx_callgraph', 'mcp__lean-ctx__ctx_graph',
    'mcp__lean-ctx__ctx_delta', 'mcp__lean-ctx__ctx_url_read',
  ]),
  mcpReadVerbs: ['get', 'list', 'read', 'search', 'find', 'query', 'view', 'describe', 'inspect', 'show', 'fetch', 'lookup'],
}

const isMcpRead = (tool: string): boolean => {
  if (!tool.startsWith('mcp__')) return false
  const own = tool.slice(tool.lastIndexOf('__') + 2)
  return STRICT_ALLOWED.mcpReadVerbs.some(v => own === v || own.startsWith(`${v}_`) || own.startsWith(`${v}-`) || new RegExp(`^${v}[A-Z]`).test(own))
}

/** A call strict mode may refuse: work as isWorkCall counts it, and not on the STRICT_ALLOWED list. */
export const isStrictWork = (tool: string): boolean => isWorkCall(tool) && !STRICT_ALLOWED.tools.has(tool) && !isMcpRead(tool)

// The call's result with the nudge line added to its context; a refused call or an odd result comes back as it was.
export function withNudgeLine<R>(result: R, line: string = STEP_NUDGE): R {
  const r = result as { deny?: unknown; context?: unknown } | null
  if (!r || typeof r !== 'object' || r.deny !== undefined) return result
  const kept = Array.isArray(r.context) ? r.context.filter((x): x is string => typeof x === 'string') : []
  return { ...r, context: [...kept, line] } as R
}
