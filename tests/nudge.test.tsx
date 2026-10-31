import { describe, expect, test } from 'claude-code/testing'

import { countCall, STEP_NUDGE, STEP_NUDGE_AFTER, withNudgeLine } from '../hooks/nudge'

const NOW = Date.UTC(2026, 9, 31, 9, 0)

function engine(on: any, opts: { storeDown?: boolean } = {}) {
  const store: Record<string, unknown> = {}
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
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const spawn = ($: any, id: string) => $.agent.spawn({ subagentType: 'flowdeck-medium', description: `task ${id}`, tool_use_id: id } as any)
const step = ($: any, agentId: string | null, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__step', ...(agentId ? { agentId } : {}), ...input } as any)
const bare = ($: any, agentId: string | null, tool = 'Read') => $.tool.call({ tool, ...(agentId ? { agentId } : {}) } as any)
const nudges = async ($: any, agentId: string | null, n: number): Promise<number[]> => {
  const at: number[] = []
  for (let i = 1; i <= n; i++) if ((await bare($, agentId)).context?.includes(STEP_NUDGE)) at.push(i)
  return at
}

describe('the step nudge: counting', () => {
  test('countCall fires on every STEP_NUDGE_AFTER-th call and starts over', () => {
    const calls = new Map<string, number>()
    const fired = Array.from({ length: STEP_NUDGE_AFTER * 2 }, () => countCall(calls, 'a'))
    expect(fired.map((f, i) => (f ? i + 1 : 0)).filter(Boolean)).toEqual([STEP_NUDGE_AFTER, STEP_NUDGE_AFTER * 2])
    expect(STEP_NUDGE_AFTER).toBe(8)
  })

  test('withNudgeLine adds the line to the context, keeps the rest, and leaves a refusal or odd value alone', () => {
    expect(withNudgeLine({ result: 'ok' })).toEqual({ result: 'ok', context: [STEP_NUDGE] })
    expect(withNudgeLine({ result: 'ok', context: ['a'] })).toEqual({ result: 'ok', context: ['a', STEP_NUDGE] })
    expect(withNudgeLine({ result: 'ok', context: 'junk' })).toEqual({ result: 'ok', context: [STEP_NUDGE] })
    expect(withNudgeLine({ deny: 'no' })).toEqual({ deny: 'no' })
    expect(withNudgeLine(null)).toBeNull()
    expect(withNudgeLine('text')).toBe('text')
  })
})

describe('the step nudge: through tool.call', () => {
  test('a worker with an active step is nudged at the 8th call and again after 8 more', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1')
    await step($, 'w1', { steps: [{ title: 'one' }, { title: 'two' }] })
    expect(await nudges($, 'w1', 17)).toEqual([8, 16])
  })

  test('a step call resets the count', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1')
    await step($, 'w1', { steps: [{ title: 'one' }, { title: 'two' }, { title: 'three' }] })
    expect(await nudges($, 'w1', 7)).toEqual([])
    await step($, 'w1', { next: true })
    expect(await nudges($, 'w1', 7)).toEqual([])
    expect(await nudges($, 'w1', 1)).toEqual([1])
  })

  test('workers count separately', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1')
    await spawn($, 'w2')
    await step($, 'w1', { steps: [{ title: 'one' }] })
    await step($, 'w2', { steps: [{ title: 'one' }] })
    expect(await nudges($, 'w1', 5)).toEqual([])
    expect(await nudges($, 'w2', 8)).toEqual([8])
    expect(await nudges($, 'w1', 3)).toEqual([3])
  })

  test('never for the orchestrator, a worker without a step list, or one whose steps are all closed', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1')
    await spawn($, 'w2')
    expect(await nudges($, null, 20)).toEqual([])
    expect(await nudges($, 'w1', 20)).toEqual([])
    await step($, 'w2', { steps: [{ title: 'one' }] })
    await step($, 'w2', { next: true })
    expect(await nudges($, 'w2', 20)).toEqual([])
  })

  test('the flowdeck tools themselves are not counted or nudged', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1')
    await step($, 'w1', { steps: [{ title: 'one' }, { title: 'two' }] })
    for (let i = 0; i < 20; i++) await step($, 'w1', { note: 'working' })
    expect(await nudges($, 'w1', 7)).toEqual([])
  })

  test('a store that fails never throws the call and adds nothing', async ($, on) => {
    engine(on, { storeDown: true })
    await start($)
    for (let i = 0; i < 20; i++) expect((await bare($, 'w9')).result).toBe('ok')
  })
})
