import { describe, expect, test } from 'claude-code/testing'

import { countCall, isPlanNudgeCall, isWorkCall, PLAN_NUDGE, PLAN_NUDGE_EVERY, PLAN_SEND_BACK, STEP_NUDGE, STEP_NUDGE_AFTER, withNudgeLine } from '../hooks/nudge'

const NOW = Date.UTC(2026, 9, 31, 9, 0)

function engine(on: any, opts: { storeDown?: boolean; rule?: 'on' | 'off' | 'unset'; stopBlock?: string } = {}) {
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('classic.Stop', () => (opts.stopBlock ? { block: opts.stopBlock } : {}))
  const store: Record<string, unknown> = opts.rule ? { rule: opts.rule } : {}
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

const planLine = (r: any): string | undefined => (r.context ?? []).find((l: unknown) => typeof l === 'string' && l.startsWith(PLAN_NUDGE))
const planned = (r: any): boolean => planLine(r) !== undefined
let turnNo = 0
const turn = ($: any) => $.turn.start({ turnId: `t${++turnNo}` } as any)
const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
const ruleText = async ($: any): Promise<string> => (await compose($)).sections.find((s: any) => s.id === 'flowdeck:flow-rule')?.text

describe('the plan nudge', () => {
  test('isWorkCall: edits, shells and workers are work; looking, asking and flowdeck calls are not', () => {
    for (const t of ['Edit', 'Write', 'Bash', 'Agent', 'mcp__lean-ctx__ctx_shell']) expect(isWorkCall(t)).toBe(true)
    for (const t of ['Read', 'Grep', 'ToolSearch', 'mcp__lean-ctx__ctx_read', 'mcp__flowdeck__progress', 'mcp__flowdeck__step']) expect(isWorkCall(t)).toBe(false)
  })

  test('tracking on, no flow: the first work call of a turn gets the line, the next does not; a new turn can get it again', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    expect(planned(await bare($, null, 'Read'))).toBe(false)
    expect(planned(await bare($, null, 'Edit'))).toBe(true)
    expect(planned(await bare($, null, 'Bash'))).toBe(false)
    await turn($)
    expect(planned(await bare($, null, 'Bash'))).toBe(true)
  })

  test('not with tracking off', async ($, on) => {
    engine(on, { rule: 'off' })
    await start($)
    await compose($)
    await turn($)
    expect(planned(await bare($, null, 'Edit'))).toBe(false)
  })

  for (const rule of ['unset', undefined] as const) {
    test(`with tracking ${rule ?? 'never stored'} it nudges like on`, async ($, on) => {
      engine(on, { rule })
      await start($)
      await turn($)
      expect(planned(await bare($, null, 'Edit'))).toBe(true)
    })
  }

  test('before a compose holds the rule the line carries the whole rule; after one, the nudge alone; one line a call', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    const first = await bare($, null, 'Edit')
    expect(planned(await bare($, null, 'Edit'))).toBe(false)
    const rule = await ruleText($)
    expect(rule).toMatch(/^# flowdeck\n/)
    expect(planLine(first)).toBe(`${PLAN_NUDGE} ${rule}`)
    await turn($)
    const second = await bare($, null, 'Bash')
    expect(planLine(second)).toBe(PLAN_NUDGE)
    expect(second.context.filter((l: string) => l.startsWith(PLAN_NUDGE))).toHaveLength(1)
    expect(planned(await bare($, null, 'Bash'))).toBe(false)
  })

  test('turned on in a session that composed it off: the next work call carries the whole rule', async ($, on) => {
    const store = engine(on, { rule: 'off' })
    await start($)
    expect(await ruleText($)).toBeUndefined()
    await turn($)
    expect(planned(await bare($, null, 'Edit'))).toBe(false)
    await $.command.run({ command: 'flowdeck-rule', args: 'on' } as any)
    expect(store.rule).toBe('on')
    const r = await bare($, null, 'Edit')
    expect(planLine(r)?.startsWith(`${PLAN_NUDGE} # flowdeck\n`)).toBe(true)
    expect(String(planLine(r)).length).toBeGreaterThan(PLAN_NUDGE.length + 500)
  })

  test('turned off, the reminder stops at once', async ($, on) => {
    const store = engine(on, { rule: 'on' })
    await start($)
    await compose($)
    store.rule = 'off'
    await turn($)
    expect(planned(await bare($, null, 'Edit'))).toBe(false)
  })

  test('a worker call never gets it', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await spawn($, 'w1')
    await turn($)
    expect(planned(await bare($, 'w1', 'Edit'))).toBe(false)
  })

  test('a linked flow silences it', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Trial', total: 1, tasks: [{ title: 'Build', tier: 'light' }], phase: 'delegate' } as any)
    await turn($)
    expect(planned(await bare($, null, 'Edit'))).toBe(false)
  })

  test('a store that fails counts as on and never throws the call', async ($, on) => {
    engine(on, { storeDown: true, rule: 'on' })
    await start($)
    await turn($)
    const r = await bare($, null, 'Edit')
    expect(r.result).toBe('ok')
    expect(planned(r)).toBe(true)
  })
})

// The main session's work calls in a row (looking calls between them when `look`), and which of them got the plan line.
const plans = async ($: any, n: number, look = false): Promise<number[]> => {
  const at: number[] = []
  for (let i = 1; i <= n; i++) {
    if (look) expect(planned(await bare($, null, 'Read'))).toBe(false)
    if (planned(await bare($, null, i % 2 ? 'Edit' : 'Bash'))) at.push(i)
  }
  return at
}
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const OPEN = { title: 'Trial', total: 1, tasks: [{ title: 'Build', tier: 'light' }], phase: 'delegate' }
const stop = ($: any, e: Record<string, unknown> = {}) => $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, ...e } as any)
const sentBack = async ($: any, e: Record<string, unknown> = {}): Promise<boolean> => (await stop($, e)).block === PLAN_SEND_BACK

describe('the plan nudge: cadence', () => {
  test('isPlanNudgeCall: the 1st work call, then every 3rd after it', () => {
    expect(PLAN_NUDGE_EVERY).toBe(3)
    expect(Array.from({ length: 12 }, (_, i) => i + 1).filter(isPlanNudgeCall)).toEqual([1, 4, 7, 10])
    expect(isPlanNudgeCall(0)).toBe(false)
  })

  test('the line no longer offers the one-step-edit escape: only a pure question or a single-file single edit is exempt', () => {
    expect(PLAN_NUDGE).not.toMatch(/one-step edit/)
    for (const s of ['multi-file edits', 'scripted rewrites', 'renders', 'mcp__flowdeck__progress']) expect(PLAN_NUDGE).toContain(s)
    expect(PLAN_NUDGE).toMatch(/Only a pure question or a single edit to a single file needs none\.$/)
  })

  test('tracking on, no flow: the 1st, 4th, 7th and 10th work call of a turn get the line', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    expect(await plans($, 10)).toEqual([1, 4, 7, 10])
  })

  test('looking calls between them are not counted', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    expect(await plans($, 7, true)).toEqual([1, 4, 7])
  })

  test('a new turn starts the count over', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    expect(await plans($, 3)).toEqual([1])
    await turn($)
    expect(await plans($, 4)).toEqual([1, 4])
  })

  test('an open flow silences it and starts the count over; once it finishes, the next work call gets it again', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    expect(await plans($, 2)).toEqual([1])
    await progress($, OPEN)
    expect(await plans($, 6)).toEqual([])
    await progress($, { finished: true })
    expect(await plans($, 4)).toEqual([1, 4])
  })

  test('tracking off: no line however many work calls', async ($, on) => {
    engine(on, { rule: 'off' })
    await start($)
    await compose($)
    await turn($)
    expect(await plans($, 10)).toEqual([])
  })
})

describe('the turn-end check', () => {
  test('a main turn that worked with no flow open is sent back once', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await plans($, 2)
    const r = await stop($)
    expect(r.block).toBe(PLAN_SEND_BACK)
    expect(r.block).toContain('mcp__flowdeck__progress')
    expect(await sentBack($, { stop_hook_active: true })).toBe(false)
    await plans($, 2)
    expect(await sentBack($)).toBe(false)
  })

  test('a turn a Stop hook already sent back is not sent back again', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await plans($, 2)
    expect(await sentBack($, { stop_hook_active: true })).toBe(false)
  })

  test('a new turn can be sent back again', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await plans($, 2)
    expect(await sentBack($)).toBe(true)
    await turn($)
    await plans($, 2)
    expect(await sentBack($)).toBe(true)
  })

  test('a single work call (a single edit to one file) is not sent back; two are', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await plans($, 1)
    expect(await sentBack($)).toBe(false)
    await turn($)
    await plans($, 1, true)
    expect(await sentBack($)).toBe(false)
    await turn($)
    await plans($, 2)
    expect(await sentBack($)).toBe(true)
  })

  test('not for a turn without work calls (a question)', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    for (const t of ['Read', 'Grep', 'mcp__lean-ctx__ctx_read', 'ToolSearch']) await bare($, null, t)
    expect(await sentBack($)).toBe(false)
  })

  test('tracking off changes nothing: no line and no send-back', async ($, on) => {
    engine(on, { rule: 'off' })
    await start($)
    await compose($)
    await turn($)
    await plans($, 5)
    const r = await stop($)
    expect(r.block).toBeUndefined()
  })

  test('turned off before the turn ends: not sent back', async ($, on) => {
    const store = engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await plans($, 3)
    store.rule = 'off'
    expect(await sentBack($)).toBe(false)
  })

  test('a flow open at the end, or opened and finished after the work, is not sent back; work after a finish is', async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await plans($, 3)
    await progress($, OPEN)
    expect(await sentBack($)).toBe(false)
    await turn($)
    await progress($, { finished: true })
    expect(await plans($, 2)).toEqual([1])
    await progress($, OPEN)
    await progress($, { done: [1], finished: true })
    expect(await sentBack($)).toBe(false)
    await plans($, 2)
    expect(await sentBack($)).toBe(true)
  })

  test("never in a worker: a worker's calls do not count and a worker's stop is never sent back", async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    await spawn($, 'w1')
    await turn($)
    for (let i = 0; i < 5; i++) await bare($, 'w1', 'Edit')
    expect(await sentBack($)).toBe(false)
    await plans($, 1)
    expect(await sentBack($, { agent_id: 'w1' })).toBe(false)
  })

  test("another hook's block is kept as it is", async ($, on) => {
    engine(on, { rule: 'on', stopBlock: 'other: still open' })
    await start($)
    await turn($)
    await plans($, 2)
    expect((await stop($)).block).toBe('other: still open')
  })

  test('a store that fails counts as on and never throws the stop', async ($, on) => {
    engine(on, { storeDown: true, rule: 'on' })
    await start($)
    await turn($)
    await plans($, 2)
    expect(await sentBack($)).toBe(true)
  })
})
