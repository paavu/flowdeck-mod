import { describe, expect, test } from 'claude-code/testing'

import { countRemind, STEP_REMIND_EVERY, stepRemind } from '../hooks/nudge'

// The step reminder: a running session whose prompt may predate FLOW_RULE's step instruction (no compose by this load of
// the hooks, as after /reload-plugins) gets one line on its own work calls while it does a flow task without a step list.

const NOW = Date.UTC(2026, 10, 9, 9, 0)

function engine(on: any, opts: { rule?: 'on' | 'off'; storeDown?: boolean } = {}) {
  const store: Record<string, unknown> = opts.rule ? { rule: opts.rule } : {}
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (opts.storeDown) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.compose', () => ({ sections: [] }))
  return store
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const step = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__step', ...input } as any)).result)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-careful', description, tool_use_id: id } as any)
const call = ($: any, tool = 'Edit', agentId?: string) => $.tool.call({ tool, ...(agentId ? { agentId } : {}) } as any)
const reminder = (r: any): string | undefined => (r.context ?? []).find((l: unknown) => typeof l === 'string' && l.startsWith('flowdeck: you are doing task'))
const TWO = { title: 'Backtest', phase: 'delegate', tasks: [{ title: 'Fetch history', tier: 'careful' }, { title: 'Write report', tier: 'careful' }] }
// The main session's own work calls in a row, and which of them got the reminder.
const reminded = async ($: any, n: number): Promise<number[]> => {
  const at: number[] = []
  for (let i = 1; i <= n; i++) if (reminder(await call($, i % 2 ? 'Edit' : 'Bash'))) at.push(i)
  return at
}

describe('the step reminder: counting', () => {
  test('countRemind: the 1st call for a task, then every STEP_REMIND_EVERY-th; another task starts over', () => {
    expect(STEP_REMIND_EVERY).toBe(3)
    const c = { task: '', n: 0 }
    expect(Array.from({ length: 7 }, (_, i) => (countRemind(c, 'a') ? i + 1 : 0)).filter(Boolean)).toEqual([1, 4, 7])
    expect(countRemind(c, 'b')).toBe(true)
    expect(countRemind(c, 'b')).toBe(false)
  })

  test('the line names the task and the step tool, its list form and the ToolSearch hint', () => {
    expect(stepRemind(3)).toBe(
      'flowdeck: you are doing task 3 yourself; report it with mcp__flowdeck__step: `steps` (3-8 titles) once, then `next: true` as each ends (ToolSearch select:mcp__flowdeck__step if deferred).',
    )
  })
})

describe('the step reminder: through tool.call', () => {
  test('fires on the first own work call of a task with no list, naming the task', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await progress($, TWO)
    const r = await call($)
    expect(r.result).toBe('ok')
    expect(reminder(r)).toBe(stepRemind(1))
    expect(r.context.filter((l: string) => l.startsWith('flowdeck: '))).toHaveLength(1)
  })

  test('repeats at the interval while the list is still missing', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await progress($, TWO)
    expect(await reminded($, 10)).toEqual([1, 4, 7, 10])
  })

  test('silent once the task has a step list', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await progress($, TWO)
    expect(await reminded($, 1)).toEqual([1])
    expect(await step($, { steps: [{ title: 'fetch' }, { title: 'check' }] })).toBe('ok: task 1')
    expect(await reminded($, 10)).toEqual([])
  })

  test('the count starts over for the next task: a finished list on task 1 moves it to task 2', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await progress($, TWO)
    expect(await reminded($, 2)).toEqual([1])
    await step($, { steps: [{ title: 'fetch' }] })
    await step($, { done: ['fetch'] })
    const r = await call($) // the 3rd own work call: task 1's count would stay silent here
    expect(reminder(r)).toBe(stepRemind(2))
  })

  test("never for a worker's call", async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await progress($, TWO)
    await spawn($, 'w1', 'side job')
    for (let i = 0; i < 5; i++) expect(reminder(await call($, 'Edit', 'w1'))).toBeUndefined()
  })

  test('silent for a task a worker run covers, and for a call that hands work on', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await progress($, TWO)
    expect(reminder(await call($, 'Agent'))).toBeUndefined()
    await spawn($, 'w1', '#1 Fetch history')
    expect(await reminded($, 4)).toEqual([])
  })

  test('silent when this load composed the prompt with the rule', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await compose($)
    await progress($, TWO)
    expect(await reminded($, 7)).toEqual([])
  })

  test('silent with no flow, and once the flow finished', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await $.turn.start({ turnId: 't1' } as any)
    expect(await reminded($, 4)).toEqual([])
    await progress($, TWO)
    await progress($, { finished: true })
    expect(await reminded($, 4)).toEqual([])
  })

  test('silent with tracking off', async ($, on) => {
    engine(on, { rule: 'off' })
    await start($)
    await progress($, TWO)
    expect(await reminded($, 7)).toEqual([])
  })

  test('a store that fails never throws the call', async ($, on) => {
    engine(on, { rule: 'on', storeDown: true })
    await start($)
    for (let i = 0; i < 5; i++) expect((await call($)).result).toBe('ok')
  })
})
