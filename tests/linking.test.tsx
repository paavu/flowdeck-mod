import { describe, expect, test } from 'claude-code/testing'

import { linkRuns, MATCH_SCORE, taskTag, titleScore, unstarted, workerTier } from '../hooks/tasks'

const NOW = Date.UTC(2026, 9, 29, 12, 0)

const task = (title: string, tier = 'medium', over: Record<string, unknown> = {}) => ({ title, tier, after: [] as number[], ...over })
const run = (id: string, description: string, type = 'flowdeck-medium', startedAt = NOW, over: Record<string, unknown> = {}) => ({ id, description, type, startedAt, status: 'running' as const, ...over })
// The task number (from 1) each run is linked to, or 0.
const links = (tasks: any[], runs: any[]) => {
  const m = linkRuns(tasks, runs)
  return Object.fromEntries(runs.map(r => [r.id, (m.get(r.id) ?? -1) + 1]))
}

describe('linking workers to planned tasks', () => {
  test('the worker tier comes from the agent type, plugin prefix or not', () => {
    expect(workerTier('flowdeck-careful')).toBe('careful')
    expect(workerTier('flowdeck:flowdeck-light')).toBe('light')
    expect(workerTier('Explore')).toBeNull()
    expect(workerTier('general-purpose')).toBeNull()
  })

  test('a leading task number: #3, [3] and task 3, with the rest of the description', () => {
    expect(taskTag('#3 History module')).toEqual({ n: 3, rest: 'History module' })
    expect(taskTag('[3] History module')).toEqual({ n: 3, rest: 'History module' })
    expect(taskTag('task 3: History module')).toEqual({ n: 3, rest: 'History module' })
    expect(taskTag('Task 12 - docs')).toEqual({ n: 12, rest: 'docs' })
    expect(taskTag('History module #3')).toEqual({ n: null, rest: 'History module #3' })
    expect(taskTag('tasks 3 left')).toEqual({ n: null, rest: 'tasks 3 left' })
  })

  test('rule 1, the exact title, comes first: a title that reads like a number is still a title', () => {
    expect(links([task('Read code'), task('task 1')], [run('w1', 'task 1')])).toEqual({ w1: 2 })
    expect(links([task('Read code'), task('Wire it')], [run('w1', 'WIRE it!')])).toEqual({ w1: 2 })
  })

  test('rule 2, the number: any wording, a number past the list falls back to the title', () => {
    const tasks = [task('Read code'), task('Wire it'), task('Docs')]
    expect(links(tasks, [run('w1', '#3 write the docs page'), run('w2', '[2] plumbing'), run('w3', 'task 1 - scan')])).toEqual({ w1: 3, w2: 2, w3: 1 })
    expect(links(tasks, [run('w1', '#9 Wire it')])).toEqual({ w1: 2 })
  })

  test('rules 1 and 2 give a return round the same task', () => {
    expect(links([task('Wire it')], [run('w1', 'Wire it'), run('w2', 'Wire it', 'flowdeck-medium', NOW + 1), run('w3', '#1 again', 'flowdeck-medium', NOW + 2)])).toEqual({ w1: 1, w2: 1, w3: 1 })
  })

  test('rule 3, the closest title: containment or enough shared words; too few links nothing', () => {
    expect(titleScore('Build the history module for the archive', 'History module')).toBe(1)
    expect(titleScore('Write docs', 'Write tests')).toBeLessThan(MATCH_SCORE)
    expect(links([task('History module', 'light'), task('Write tests', 'light')], [run('w1', 'Build the history module for the archive')])).toEqual({ w1: 1 })
    expect(links([task('Write tests', 'light'), task('Release notes', 'light')], [run('w1', 'Write docs page')])).toEqual({ w1: 0 })
    expect(titleScore('a', 'Read code')).toBe(0)
    expect(titleScore('code', 'Read code')).toBe(1)
  })

  test('rule 3 on a tie: the worker’s own tier wins; a tie that stays links nothing', () => {
    const tasks = [task('History export', 'light'), task('History import', 'medium')]
    expect(links(tasks, [run('w1', 'history')])).toEqual({ w1: 2 })
    expect(links(tasks, [run('w1', 'history', 'flowdeck-careful')])).toEqual({ w1: 0 })
    expect(links(tasks, [run('w1', 'history', 'Explore')])).toEqual({ w1: 0 })
  })

  test('rule 3 never links two runs to one task, and a title match wins over it', () => {
    const tasks = [task('History module', 'light'), task('Docs', 'heavy')]
    expect(links(tasks, [run('w1', 'history module part one', 'flowdeck-careful'), run('w2', 'history module part two', 'flowdeck-careful', NOW + 1)])).toEqual({ w1: 1, w2: 0 })
    // the exact title takes the task even when its run started later
    expect(links(tasks, [run('w1', 'history module part one', 'flowdeck-careful'), run('w2', 'History module', 'flowdeck-light', NOW + 1)])).toEqual({ w1: 0, w2: 1 })
  })

  test('rule 4, the only open task of the worker’s tier when it started', () => {
    const tasks = [task('Read code', 'light'), task('Wire it'), task('Polish')]
    // two medium tasks open: no guess
    expect(links(tasks, [run('w1', 'something')])).toEqual({ w1: 0 })
    // Wire it was taken before: Polish is the only one left
    expect(links(tasks, [run('w2', 'Wire it'), run('w1', 'something', 'flowdeck-medium', NOW + 1)])).toEqual({ w2: 2, w1: 3 })
    // Wire it was taken only after this worker started: still two open then
    expect(links(tasks, [run('w1', 'something'), run('w2', 'Wire it', 'flowdeck-medium', NOW + 1)])).toEqual({ w1: 0, w2: 2 })
    // the light one is alone in its tier
    expect(links(tasks, [run('w1', 'scan things', 'flowdeck:flowdeck-light')])).toEqual({ w1: 1 })
    // never for an agent that is not a flowdeck worker
    expect(links([task('Read code', 'light')], [run('w1', 'scan', 'Explore')])).toEqual({ w1: 0 })
  })

  test('rule 4 is one to one, and skips tasks mirrored from or completed in the session task list', () => {
    const tasks = [task('Read code', 'light'), task('Wire it')]
    expect(links(tasks, [run('w1', 'a'), run('w2', 'b', 'flowdeck-medium', NOW + 1)])).toEqual({ w1: 2, w2: 0 })
    expect(links([task('Todo item', 'medium', { mirrored: true })], [run('w1', 'a')])).toEqual({ w1: 0 })
    expect(links([task('Done item', 'medium', { counted: true })], [run('w1', 'a')])).toEqual({ w1: 0 })
  })

  test('a linked run starts its task and, complete, makes the tasks waiting on it ready', () => {
    const tasks = [task('Read code', 'light'), task('Wire it', 'medium', { after: [1] })]
    const going = [run('w1', 'scan the repo', 'flowdeck-light')]
    expect(unstarted(tasks, going).map(p => `${p.n}${p.ready ? '+' : ''}`)).toEqual(['2'])
    const ended = [{ ...going[0]!, status: 'done' as const }]
    expect(unstarted(tasks, ended).map(p => `${p.n}${p.ready ? '+' : ''}`)).toEqual(['2+'])
  })
})

function engine(on: any) {
  const store: Record<string, unknown> = {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '' } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const spawn = ($: any, id: string, description: string, type = 'flowdeck-medium') => $.agent.spawn({ subagentType: type, description, tool_use_id: id } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const terminal = async ($: any) => {
  const p = await $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  const texts = await p.findAll({ type: 'Text' })
  await p.unmount()
  return texts.map((x: any) => x.text).join('\n')
}
// The Active tab's queued rows (each ends in ◷) and its count.
const queued = (t: string) => (t.match(/ ◷$/gm) ?? []).length

describe('linking in the panel', () => {
  test('a worker started with other words still takes its task off the planned list, and its end makes the next ready', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'History module', tier: 'medium' }, { title: 'Docs', tier: 'light', after: [1] }] })
    await spawn($, 'w1', 'Build history panel')
    let t = await terminal($)
    expect(t).toMatch(/^1\. Build history panel$/m)
    expect(t).not.toContain('History module')
    expect(queued(t)).toBe(1)
    expect(t).toMatch(/^Active \(2\)$/m)
    expect(t).not.toMatch(/ready/)
    clock.now = NOW + 10_000
    await complete($, 'w1')
    t = await terminal($)
    expect(t).toMatch(/light · Opus · low · after 1 · ready/)
  })

  test('#2 in the description links by number and is not repeated after it', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Read code', tier: 'light' }, { title: 'Wire it', tier: 'medium' }, { title: 'Polish', tier: 'medium' }] })
    await spawn($, 'w2', '#2 wire up the tool')
    const t = await terminal($)
    expect(t).toMatch(/^2\. wire up the tool$/m)
    expect(t).not.toContain('#2')
    expect(queued(t)).toBe(2)
    expect(t).toMatch(/^Active \(3\)$/m)
    expect(t).toContain('3. Polish')
  })

  test('a worker that matches nothing keeps its own row, unnumbered, and every task stays planned', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Wire it', tier: 'medium' }, { title: 'Polish', tier: 'medium' }] })
    await spawn($, 'w9', 'Unrelated chore', 'flowdeck-careful')
    const t = await terminal($)
    expect(t).toMatch(/^Unrelated chore$/m)
    expect(queued(t)).toBe(2)
    expect(t).toMatch(/^Active \(3\)$/m)
  })
})
