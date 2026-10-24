import { describe, expect, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 26, 12, 40)

type Tool = (e: any, store: Record<string, unknown>) => unknown

function engine(on: any, opts: { store?: Record<string, unknown>; storeFails?: boolean; clockFails?: boolean; tool?: Tool } = {}) {
  const store = opts.store ?? {}
  const clock = { now: NOW }
  const prompts: any[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => {
    if (opts.clockFails) throw new Error('clock down')
    return { value: clock.now }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('tool.call', (_$: any, e: any) => (opts.tool ? opts.tool(e, store) : { result: 'ok' }))
  on('prompt.submit', (_$: any, e: any) => {
    prompts.push(e)
    return { text: e.text }
  })
  on('store.get', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, clock, prompts }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const plan = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__plan', ...input } as any)).result)
const saved = (store: Record<string, unknown>): any[] => ((store.plans as any)?.s ?? []) as any[]
const steps = (p: any) => p.stages.flatMap((s: any) => s.steps.map((st: any) => `${st.title}:${st.status}`))
const approve = ($: any, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'ExitPlanMode', ...extra } as any)
const ask = ($: any, questions: unknown[], extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'AskUserQuestion', questions, ...extra } as any)
const submit = ($: any, kind: string) => $.prompt.submit({ text: 'yes', wait: false, origin: { kind } } as any)

const MD = ['# Hook work', '', '## Build', '- [x] read code', '- write tests', '', '## Ship', '1. commit'].join('\n')
const MD2 = ['# Hook work', '', '## Build', '- read code', '- write tests', '- wire hooks', '', '## Ship', '1. commit'].join('\n')
const planTool: Tool = e => ({ result: { plan: e.plan ?? MD, isAgent: false } })

describe('plan mode and input hooks', () => {
  test('an approved plan becomes the plan "plan" with its title, stages and done step', async ($, on) => {
    const { store } = engine(on, { tool: planTool })
    await start($)
    const ran: any = await approve($)
    expect(ran.result).toEqual({ plan: MD, isAgent: false })
    const [p] = saved(store)
    expect(p.id).toBe('plan')
    expect(p.title).toBe('Hook work')
    expect(p.stages.map((s: any) => s.name)).toEqual(['Build', 'Ship'])
    expect(steps(p)).toEqual(['read code:done', 'write tests:active', 'commit:pending'])
    expect(p.state).toBe('running')
  })

  test('the plan in the tool input is used when the result carries none', async ($, on) => {
    const { store } = engine(on, { tool: () => ({ result: 'approved' }) })
    await start($)
    await approve($, { plan: MD })
    expect(saved(store)[0].title).toBe('Hook work')
  })

  test('approving again keeps the finished steps and does not open a second plan', async ($, on) => {
    const { store } = engine(on, { tool: planTool })
    await start($)
    await approve($)
    await plan($, { id: 'plan', next: true })
    await approve($, { plan: MD2 })
    const list = saved(store)
    expect(list.map(p => p.id)).toEqual(['plan'])
    expect(steps(list[0])).toEqual(['read code:done', 'write tests:done', 'wire hooks:active', 'commit:pending'])
    expect(list[0].startedAt).toBe(NOW)
  })

  test("a subagent's plan and a refused one are ignored", async ($, on) => {
    let answer: unknown = { result: { plan: MD } }
    const { store } = engine(on, { tool: () => answer })
    await start($)
    await approve($, { agentId: 'w1' })
    answer = { deny: 'no' }
    await approve($)
    expect(saved(store)).toEqual([])
  })

  test('a question sets the newest running plan to needs_input with a note, and the answer brings it back', async ($, on) => {
    let during: any[] = []
    const { store } = engine(on, {
      tool: (e, s) => {
        if (e.tool !== 'AskUserQuestion') return { result: 'ok' }
        during = JSON.parse(JSON.stringify((s.plans as any).s))
        return { result: { answers: { Branch: 'main' } } }
      },
    })
    await start($)
    await plan($, { id: 'old', title: 'Old', stages: [{ name: 'S', steps: [{ title: 'a' }] }] })
    await plan($, { id: 'new', title: 'New', stages: [{ name: 'S', steps: [{ title: 'b' }] }] })
    const ran: any = await ask($, [{ question: 'Which branch should the release go to?', header: 'Branch', options: [] }])
    expect(ran.result).toEqual({ answers: { Branch: 'main' } })
    expect(during.map(p => [p.id, p.state, p.note])).toEqual([
      ['old', 'running', null],
      ['new', 'needs_input', 'Branch'],
    ])
    expect(saved(store).map(p => [p.id, p.state, p.note])).toEqual([
      ['old', 'running', null],
      ['new', 'running', null],
    ])
  })

  test('a question without a header notes its text, capped', async ($, on) => {
    let note = ''
    engine(on, {
      tool: (e, s) => {
        if (e.tool === 'AskUserQuestion') note = (s.plans as any).s[0].note
        return { result: 'ok' }
      },
    })
    await start($)
    await plan($, { id: 'w', title: 'W', stages: [{ name: 'S', steps: [{ title: 'a' }] }] })
    await ask($, [{ question: 'x'.repeat(300), options: [] }])
    expect(note).toBe('x'.repeat(160))
  })

  test('a question with no running plan, or from a subagent, changes nothing', async ($, on) => {
    const seen: string[] = []
    const { store } = engine(on, {
      tool: (e, s) => {
        if (e.tool === 'AskUserQuestion') seen.push(JSON.stringify((s.plans as any)?.s ?? []))
        return { result: 'ok' }
      },
    })
    await start($)
    await ask($, [{ question: 'q?', header: 'Q', options: [] }])
    expect(saved(store)).toEqual([])
    await plan($, { id: 'w', title: 'W', stages: [{ name: 'S', steps: [{ title: 'a' }] }] })
    const before = JSON.stringify(saved(store))
    await ask($, [{ question: 'q?', header: 'Q', options: [] }], { agentId: 'w1' })
    expect(seen[1]).toBe(before)
    expect(JSON.stringify(saved(store))).toBe(before)
  })

  test("the user's prompt returns needs_input to running and clears the note", async ($, on) => {
    const { store, prompts } = engine(on)
    await start($)
    await plan($, { id: 'w', title: 'W', stages: [{ name: 'S', steps: [{ title: 'a' }] }], state: 'needs_input', note: 'which branch?' })
    await plan($, { id: 'v', title: 'V', stages: [{ name: 'S', steps: [{ title: 'b' }] }], state: 'error', note: 'broke' })
    await submit($, 'composer')
    expect(prompts).toHaveLength(1)
    expect(saved(store).map(p => [p.id, p.state, p.note])).toEqual([
      ['w', 'running', null],
      ['v', 'error', 'broke'],
    ])
  })

  test('a reply from the phone (Remote Control) also answers it', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($, { id: 'w', title: 'W', stages: [{ name: 'S', steps: [{ title: 'a' }] }], state: 'needs_input', note: 'which branch?' })
    await submit($, 'bridge')
    expect(saved(store)[0].state).toBe('running')
    expect(saved(store)[0].note).toBeNull()
  })

  test('a prompt that is not the user\'s leaves needs_input alone', async ($, on) => {
    const { store, prompts } = engine(on)
    await start($)
    await plan($, { id: 'w', title: 'W', stages: [{ name: 'S', steps: [{ title: 'a' }] }], state: 'needs_input', note: 'which branch?' })
    await submit($, 'task-notification')
    expect(prompts).toHaveLength(1)
    expect(saved(store)[0].state).toBe('needs_input')
    expect(saved(store)[0].note).toBe('which branch?')
  })

  test('a throwing store breaks neither the tools nor the prompt', async ($, on) => {
    const { prompts } = engine(on, { storeFails: true, tool: planTool })
    await start($)
    expect(((await approve($)) as any).result).toEqual({ plan: MD, isAgent: false })
    expect(await plan($, { id: 'plan', next: true })).toBe('plan: 2/3, running, active "commit"')
    expect(((await ask($, [{ question: 'q?', header: 'Q' }])) as any).result).toEqual({ plan: MD, isAgent: false })
    await submit($, 'composer')
    expect(prompts).toHaveLength(1)
  })

  test('a throwing clock costs the plan, not the approval', async ($, on) => {
    const { store } = engine(on, { tool: planTool, clockFails: true })
    await start($)
    expect(((await approve($)) as any).result).toEqual({ plan: MD, isAgent: false })
    expect(saved(store)).toEqual([])
  })
})
