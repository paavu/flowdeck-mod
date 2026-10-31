// The README's screenshots, drawn by the mod itself through the engine's test kit with sample data (no real session).
// Not a test of the suite: scripts/screenshots.sh copies the mod to a temporary folder, puts this file there as
// tests/shots.test.tsx and runs it; each mounted drawing is printed as one `@@SHOT <name> <json>` line, which
// scripts/screenshots/render.mjs lays out as HTML and turns into PNG files under docs/images/.
import { mock, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { seed } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.UTC(2026, 9, 31, 13, 40)
const ROOT = '/work/web-app'
const DIR = `${ROOT}/.claude/flowdeck`
const MODEL = 'claude-opus-5-5'
const BAND_COLS = 110
const PANE_COLS = 62

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 9_800, color: 'promptBorder', kind: 'used' },
    { name: 'System tools', tokens: 21_400, color: 'inactive', kind: 'used' },
    { name: 'Messages', tokens: 381_000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', kind: 'buffer' },
    { name: 'Free space', tokens: 537_800, color: 'promptBorder', kind: 'free' },
  ],
  totalTokens: 412_200,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 41,
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
}
const RATES = [
  { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 2 * HOUR + 20 * MIN).toISOString() },
  { kind: 'seven_day', percentUsed: 21, resetsAt: new Date(NOW + 61 * HOUR).toISOString() },
]

// Task tracking is on in every shot but the strip's own (`rule` off there).
function engine(on: any, files: Record<string, string> = {}, rule = 'on') {
  const clock = mock.clock(on, { now: NOW - 70 * MIN })
  mock.store(on, { rule })
  fakeFs(on, { files })
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 'sample', cwd: e.cwd }))
  on('session.id', () => ({ value: 'sample' }))
  on('session.end', () => ({ sessionId: 'sample' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.model', () => ({ value: MODEL }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 412_200, window: 1_000_000, percent: 41, breakdown: BREAKDOWN }, rateLimits: RATES, cost: { usd: 0 } } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: MODEL }))
  on('turn.step', async function* (_$: any, e: any) {
    const sub = !!e.agentId
    const usage = { model: MODEL, input_tokens: sub ? 4_000 : 10, output_tokens: sub ? 2_500 : 0, cache_read_input_tokens: sub ? 38_000 : 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.SessionStart', () => ({}))
  on('model.fork', () => ({ value: { isAnswered: true, text: 'ok', usage: { model: MODEL, input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } }))
  return { clock }
}

const at = (clock: any, ms: number) => clock.set(NOW + ms)
const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: ROOT } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const spawn = ($: any, id: string, type: string, description: string, prompt: string) => $.agent.spawn({ subagentType: `flowdeck:flowdeck-${type}`, description, prompt, tool_use_id: id } as any)
const step = ($: any, agentId: string, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__step', agentId, ...input } as any)
const request = async ($: any, agentId?: string) => {
  for await (const _ of $.turn.step({ ...(agentId ? { agentId } : {}), model: MODEL, effort: agentId ? 'high' : undefined, turnId: 't', index: 0, messageCount: 1 } as any));
}
const endRun = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, agentId } as any)
const mainTurn = async ($: any) => {
  await request($)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 4000 } as any)
}

const TASKS = [
  { title: 'Map the upload code', tier: 'light', goal: 'Find where uploads start, fail and report errors.' },
  { title: 'Add retry to uploads', tier: 'careful', after: [1], goal: 'Retry a failed upload up to 3 times with backoff; keep the progress events as they are.' },
  { title: 'Retry button in dialog', tier: 'medium', after: [2], goal: 'A Retry button in the upload dialog for a failed file.' },
  { title: 'Update the docs', tier: 'light', after: [1], goal: 'Describe the retry behaviour in the user guide.' },
]
const BRIEF = (t: string) => `Repo: /work/web-app. ${t} Keep the public API unchanged. Before your final report, close your step list with \`mcp__flowdeck__step\`: every step \`done\` or \`failed\`.`

// A flow a few tasks in: task 1 accepted, task 2 running on its third step, task 3 waiting on it, task 4 ready.
async function runningFlow($: any, clock: any) {
  await start($)
  await at(clock, -62 * MIN)
  await progress($, { title: 'Upload retries', phase: 'delegate', tasks: TASKS })
  await spawn($, 'w1', 'light', '#1 Map the upload code', BRIEF('List the upload entry points, the error paths and where progress is reported.'))
  await step($, 'w1', { steps: [{ title: 'Find entry points' }, { title: 'Trace error paths' }, { title: 'Write the map' }] })
  await request($, 'w1')
  await at(clock, -58 * MIN)
  await step($, 'w1', { next: true })
  await at(clock, -55 * MIN)
  await step($, 'w1', { next: true })
  await at(clock, -53 * MIN)
  await step($, 'w1', { next: true })
  await endRun($, 'w1')
  await at(clock, -50 * MIN)
  await progress($, { done: [1], phase: 'delegate', notes: [{ task: 1, result: 'Map of upload.ts and queue.ts: one entry point, two error paths.', feedback: 'Checked the map against the code; the queue path was missed at first.' }] })
  await at(clock, -24 * MIN)
  await spawn($, 'w2', 'careful', '#2 Add retry to uploads', BRIEF('Wrap the upload request in a retry with exponential backoff (3 tries); a final failure still emits the error event.'))
  await step($, 'w2', { steps: [{ title: 'Read upload queue' }, { title: 'Write failing test' }, { title: 'Add retry with backoff' }, { title: 'Run the suite' }, { title: 'Report' }] })
  await request($, 'w2')
  await at(clock, -19 * MIN)
  await step($, 'w2', { next: true })
  // the main thread's last request, 18 minutes ago: the cache is warm with 42 minutes left
  await at(clock, -18 * MIN)
  await mainTurn($)
  await at(clock, -11 * MIN)
  await step($, 'w2', { next: true })
  await request($, 'w2')
  await at(clock, 0)
}

async function shot(name: string, el: any) {
  console.log(`@@SHOT ${name} ${JSON.stringify(await el.drawn())}`)
  await el.unmount()
}
const band = ($: any, cols = BAND_COLS) => $.ui.mount({ plugin: 'flowdeck', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: cols } } as any)
const pane = ($: any) => $.ui.mount({ plugin: 'flowdeck', surface: 'desktop', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: PANE_COLS } } as any)
const press = async ($: any, mount: () => Promise<any>, key: string) => {
  const p = await mount()
  await p.press({ key })
  await p.unmount()
}
const tab = async ($: any, t: Tab) => showTab($, t)

test('band, cache card and panel of a running flow', async ($, on) => {
  const { clock } = engine(on)
  await runningFlow($, clock)
  await shot('band-running', await band($))
  await press($, () => band($), 'cache-fold')
  await shot('cache-warm', await band($))
  await press($, () => pane($), 'agent-fold-w2')
  await press($, () => pane($), 'note-task-3')
  await shot('panel-active', await pane($))
  await tab($, 'finished')
  await press($, () => pane($), 'note-w1')
  await shot('panel-finished', await pane($))
})

// Kept warm twice after the last request, then cold an hour after the second renewal.
test('the cache gone cold', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = engine(on)
  await runningFlow($, clock)
  for (let m = 10; m <= 175; m += 15) await at(clock, m * MIN)
  await shot('cache-cold', await band($))
})

test('a finished flow', async ($, on) => {
  const { clock } = engine(on)
  await runningFlow($, clock)
  for (const [id, t, n] of [['w2', 'careful', 2], ['w3', 'medium', 3], ['w4', 'light', 4]] as const) {
    if (id !== 'w2') {
      await spawn($, id, t, `#${n} ${TASKS[n - 1]!.title}`, BRIEF(TASKS[n - 1]!.goal))
      await step($, id, { steps: [{ title: 'Change' }, { title: 'Verify' }] })
      await request($, id)
    }
    await step($, id, { done: id === 'w2' ? ['Read upload queue', 'Write failing test', 'Add retry with backoff', 'Run the suite', 'Report'] : ['Change', 'Verify'] })
    await endRun($, id)
    await progress($, { done: [n] })
  }
  await mainTurn($)
  await shot('band-done', await band($))
})

// Sessions saved in the project's archive, as finished flows leave them.
const run = (id: string, tier: string, description: string, endedAt: number, steps: string[]) => ({
  id,
  agentId: id,
  type: `flowdeck:flowdeck-${tier}`,
  description,
  model: MODEL,
  effort: 'medium',
  status: 'done',
  startedAt: endedAt - 9 * MIN,
  endedAt,
  contextTokens: 52_000,
  contextMax: 1_000_000,
  tokens: 180_000,
  costUsd: 0.62,
  steps: 6,
  round: 1,
  items: steps.map((title, i) => ({ id: `${id}-${i}`, title, status: 'done', startedAt: endedAt - (9 - 2 * i) * MIN, endedAt: endedAt - (7 - 2 * i) * MIN })),
  stepDone: steps.length,
  stepTotal: steps.length,
})
const session = (i: number, title: string, end: number, tasks: { title: string; tier: string }[]) => ({
  id: `${end - 3 * HOUR}-${ROOT}`,
  project: ROOT,
  title,
  startedAt: end - 3 * HOUR,
  endedAt: end,
  status: 'finished',
  done: tasks.length,
  total: tasks.length,
  tasks: tasks.map(t => ({ ...t, goal: `Sample goal for ${t.title.toLowerCase()}.` })),
  accepted: tasks.map((_, n) => n + 1),
  cost: 0.62 * tasks.length,
  tokens: 180_000 * tasks.length,
  time: 2 * HOUR + i * 7 * MIN,
  agents: tasks.map((t, n) => run(`s${i}-r${n + 1}`, t.tier, `#${n + 1} ${t.title}`, end - (tasks.length - n) * 12 * MIN, ['Read', 'Change', 'Verify'])),
})

test('archive and trash', async ($, on) => {
  const files: Record<string, string> = {}
  const day = 24 * HOUR
  const list = [
    session(1, 'Dark mode', NOW - 2 * HOUR, [{ title: 'Theme tokens', tier: 'medium' }, { title: 'Toggle in settings', tier: 'medium' }, { title: 'Contrast check', tier: 'light' }]),
    session(2, 'Search index', NOW - day - 3 * HOUR, [{ title: 'Index schema', tier: 'heavy' }, { title: 'Backfill job', tier: 'careful' }]),
    session(3, 'Login rate limit', NOW - 2 * day, [{ title: 'Limiter middleware', tier: 'careful' }, { title: 'Error page copy', tier: 'light' }]),
    session(4, 'Release 2.4', NOW - 3 * day - 5 * HOUR, [{ title: 'Changelog', tier: 'light' }]),
    session(5, 'Old prototype', NOW - 6 * day, [{ title: 'Spike', tier: 'medium' }]),
  ]
  seed(files, DIR, list)
  const { clock } = engine(on, files)
  await at(clock, 0)
  await start($)
  // Context folded to its bar and Usage hidden, so the lists show
  await press($, () => pane($), 'context')
  await press($, () => pane($), 'usage')
  await tab($, 'archive')
  for (const i of [4, 5]) {
    const k = keyOf(list[i - 1]!.id)
    await press($, () => pane($), `archive-del-${k}`)
    await press($, () => pane($), `archive-trash-${k}`)
  }
  await press($, () => pane($), `archive-del-${keyOf(list[2]!.id)}`)
  await shot('panel-archive', await pane($))
  await press($, () => pane($), `archive-cancel-${keyOf(list[2]!.id)}`)
  await tab($, 'trash')
  await shot('panel-trash', await pane($))
})

// Task tracking turned off: the strip above the Active list says so and offers to turn it on.
test('task tracking off', async ($, on) => {
  const { clock } = engine(on, {}, 'off')
  await at(clock, 0)
  await start($)
  await press($, () => pane($), 'context')
  await press($, () => pane($), 'usage')
  await shot('panel-tracking-off', await pane($))
})
