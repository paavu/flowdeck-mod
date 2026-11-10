import { describe, expect, test } from 'claude-code/testing'

import { isStrictWork, isWorkCall, PLAN_NUDGE, remindShown, STRICT_ALLOWED, STRICT_DENY_MAX, STRICT_FLOW_DENY, STRICT_STEP_AFTER, stepRemind, strictStepDeny } from '../hooks/nudge'
import { asStrict, STRICT_KEY } from '../hooks/rule'
import { asPanel, PANEL_DEFAULT } from '../hooks/shapes'
import { fakeFs } from './fake-fs'

// Strict mode: with tracking on, the main session's work calls are refused while no flow is open (the flow block), and
// its own work on a task without a step list once the step reminder was shown twice (the step block). After 2 refusals
// in a main turn the rest of the turn goes through, logged once in untracked-work.json. Off unless switched on.

const NOW = Date.UTC(2026, 10, 9, 9, 0)
const DIR = '/work/app/.claude/flowdeck'
const LOG = `${DIR}/untracked-work.json`

function engine(on: any, opts: { store?: Record<string, unknown>; storeDown?: boolean } = {}) {
  const store: Record<string, unknown> = { ...(opts.store ?? {}) }
  const fs = fakeFs(on, { files: {} })
  const commands: any[] = []
  let panes: { id: string }[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => (commands.push(e), { value: undefined }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$: any, e: any) => ((panes = [{ id: e.id }]), { value: undefined }))
  on('ui.close', () => ((panes = []), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (opts.storeDown) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (opts.storeDown) throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  return { store, files: fs.files, commands }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
let turnNo = 0
const turn = ($: any) => $.turn.start({ turnId: `strict-${++turnNo}` } as any)
const call = ($: any, tool = 'Edit', agentId?: string): Promise<any> => $.tool.call({ tool, ...(agentId ? { agentId } : {}) } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const step = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__step', ...input } as any)).result)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-careful', description, tool_use_id: id } as any)
const command = async ($: any, args: string): Promise<string> => String((await $.command.run({ command: 'flowdeck-strict', args } as any)).text)
const logOf = (files: Record<string, string>): any[] => (LOG in files ? JSON.parse(files[LOG]!) : [])
const denied = (r: any): string | undefined => r?.deny
const reminder = (r: any): string | undefined => (r?.context ?? []).find((l: unknown) => typeof l === 'string' && l.startsWith('flowdeck: you are doing task'))
const TWO = { title: 'Backtest', phase: 'delegate', tasks: [{ title: 'Fetch history', tier: 'careful' }, { title: 'Write report', tier: 'careful' }] }
const STRICT_ON = { rule: 'on', strict: 'on' }

const pane = ($: any, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const walk = (n: any): any[] => (n && typeof n === 'object' ? [n, ...(Array.isArray(n) ? n : (n.children ?? [])).flatMap(walk)] : [])
async function strictLabel($: any, surface: 'desktop' | 'terminal'): Promise<string | null> {
  const p = await pane($, surface)
  const root = await p.drawn()
  await p.unmount()
  return walk(root).find(n => n?.props?.key === 'strict-mode')?.props?.label ?? null
}
async function press($: any, key: string, surface: 'desktop' | 'terminal' = 'terminal') {
  const p = await pane($, surface)
  await p.press({ key })
  await p.unmount()
}

describe('strict mode: the pure parts', () => {
  test('the stored choice: only `on` is on; the key is `strict`; the panel defaults to off', () => {
    expect(STRICT_KEY).toBe('strict')
    expect([asStrict('on'), asStrict('off'), asStrict(undefined), asStrict(null), asStrict(true), asStrict('ON')]).toEqual([true, false, false, false, false, false])
    expect(PANEL_DEFAULT.isStrict).toBe(false)
    expect(asPanel({}).isStrict).toBe(false)
    expect(asPanel({ isStrict: 'yes' }).isStrict).toBe(false)
    expect(asPanel({ isStrict: true }).isStrict).toBe(true)
  })

  test('the allowlist: reads, searches, asks, flowdeck tools and bookkeeping are never refused', () => {
    for (const tool of [
      'ToolSearch', 'AskUserQuestion', 'mcp__flowdeck__progress', 'mcp__flowdeck__step', 'Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite',
      'mcp__lean-ctx__ctx_read', 'mcp__lean-ctx__ctx_search', 'mcp__lean-ctx__ctx_tree', 'mcp__lean-ctx__ctx_glob', 'mcp__lean-ctx__ctx_compose',
      'TaskCreate', 'TaskUpdate', 'TaskOutput', 'ExitPlanMode', 'LSP',
      'mcp__google-workspace__list_events', 'mcp__google-workspace__get_file_metadata', 'mcp__srv__searchThreads', 'mcp__srv__read',
    ]) {
      expect([tool, isStrictWork(tool)]).toEqual([tool, false])
    }
    expect(STRICT_ALLOWED.tools.has('TaskCreate')).toBe(true)
    expect(STRICT_ALLOWED.mcpReadVerbs).toContain('get')
  })

  test('work as isWorkCall counts it is refused: edits, shells, workers, writing MCP tools', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task', 'mcp__lean-ctx__ctx_shell', 'mcp__lean-ctx__ctx_patch', 'mcp__google-workspace__send_email', 'mcp__srv__getaway']) {
      expect([tool, isStrictWork(tool)]).toEqual([tool, true])
      expect(isWorkCall(tool)).toBe(true)
    }
  })

  test('remindShown counts the reminders countRemind showed for a task; another task reads 0', () => {
    expect(remindShown({ task: 'a', n: 0 }, 'a')).toBe(0)
    expect([1, 2, 3, 4, 6, 7].map(n => remindShown({ task: 'a', n }, 'a'))).toEqual([1, 1, 1, 2, 2, 3])
    expect(remindShown({ task: 'a', n: 7 }, 'b')).toBe(0)
    expect([STRICT_STEP_AFTER, STRICT_DENY_MAX]).toEqual([2, 2])
  })

  test('the refusals say exactly what to do', () => {
    expect(STRICT_FLOW_DENY).toBe(
      'flowdeck strict mode: refused, no flow is open. Load mcp__flowdeck__progress (ToolSearch select:mcp__flowdeck__progress if deferred), plan this task with it (title, tasks), then retry this call.',
    )
    expect(strictStepDeny(2)).toBe(
      'flowdeck strict mode: refused, task 2 has no step list. Send mcp__flowdeck__step with `task: 2` and `steps` (3-8 titles) (ToolSearch select:mcp__flowdeck__step if deferred), then retry this call.',
    )
  })
})

describe('strict mode: the stored choice', () => {
  test('default off: a fresh install stores nothing for strict and refuses nothing', async ($, on) => {
    const { store } = engine(on)
    await start($)
    expect(STRICT_KEY in store).toBe(false)
    await turn($)
    for (const tool of ['Edit', 'Bash', 'Agent', 'Write']) expect(denied(await call($, tool))).toBeUndefined()
    expect(STRICT_KEY in store).toBe(false)
  })

  test('an existing install with tracking on is never migrated to strict', async ($, on) => {
    const { store } = engine(on, { store: { rule: 'on', contextShown: true, keepWarm: { '/work/app': true } } })
    await start($)
    await start($)
    expect(store[STRICT_KEY]).toBeUndefined()
    await turn($)
    expect(denied(await call($))).toBeUndefined()
  })

  test('`on` refuses, `off` and anything else do not; the store is read at each call', async ($, on) => {
    const { store } = engine(on, { store: STRICT_ON })
    await start($)
    await turn($)
    expect(denied(await call($))).toBe(STRICT_FLOW_DENY)
    store[STRICT_KEY] = 'off'
    await turn($)
    expect(denied(await call($))).toBeUndefined()
    store[STRICT_KEY] = true
    await turn($)
    expect(denied(await call($))).toBeUndefined()
    store[STRICT_KEY] = 'on'
    await turn($)
    expect(denied(await call($))).toBe(STRICT_FLOW_DENY)
  })
})

describe('strict mode: the flow block', () => {
  test('with no flow open, edits, shells and worker launches are refused; looking and flowdeck calls go through', async ($, on) => {
    engine(on, { store: STRICT_ON })
    await start($)
    await turn($)
    for (const tool of ['ToolSearch', 'AskUserQuestion', 'Read', 'Grep', 'Glob', 'mcp__lean-ctx__ctx_read', 'mcp__lean-ctx__ctx_search', 'mcp__lean-ctx__ctx_tree', 'mcp__lean-ctx__ctx_glob']) {
      expect([tool, (await call($, tool)).result]).toEqual([tool, 'ok'])
    }
    expect(denied(await call($, 'Edit'))).toBe(STRICT_FLOW_DENY)
    await turn($)
    expect(denied(await call($, 'Bash'))).toBe(STRICT_FLOW_DENY)
    expect(denied(await call($, 'Agent'))).toBe(STRICT_FLOW_DENY)
    await turn($)
    expect(String((await progress($, { title: 'Fix', phase: 'delegate', tasks: [{ title: 'Edit file', tier: 'light' }] })).result)).toMatch(/^ok: /)
    expect(await step($, { steps: [{ title: 'edit' }, { title: 'check' }] })).toBe('ok: task 1')
    for (const tool of ['Edit', 'Bash', 'Write']) expect([tool, (await call($, tool)).result]).toEqual([tool, 'ok'])
  })

  test('a refused worker launch starts no flow', async ($, on) => {
    const { files } = engine(on, { store: STRICT_ON })
    await start($)
    await turn($)
    const r = await $.tool.call({ tool: 'Agent', subagent_type: 'flowdeck-light', description: 'side job', prompt: 'p' } as any)
    expect(denied(r)).toBe(STRICT_FLOW_DENY)
    expect(JSON.stringify(files)).not.toContain('side job')
    const p = await pane($, 'terminal')
    const drawn = JSON.stringify(await p.drawn())
    await p.unmount()
    expect(drawn).not.toContain('side job')
  })

  test('a finished flow counts as no open flow: the flow block applies again, never the step block', async ($, on) => {
    engine(on, { store: STRICT_ON })
    await start($)
    await progress($, TWO)
    await progress($, { finished: true })
    await turn($)
    expect(denied(await call($))).toBe(STRICT_FLOW_DENY)
  })

  test("never a worker's or a subagent's call", async ($, on) => {
    engine(on, { store: STRICT_ON })
    await start($)
    await turn($)
    await spawn($, 'w1', 'side job')
    for (let i = 0; i < 6; i++) {
      expect((await call($, 'Edit', 'w1')).result).toBe('ok')
      expect((await call($, 'Bash', 'sub-7')).result).toBe('ok')
    }
  })

  test('never with tracking off, and not for a /flowdeck:flowdeck session with tracking off', async ($, on) => {
    engine(on, { store: { rule: 'off', strict: 'on' } })
    await start($)
    await turn($)
    for (let i = 0; i < 4; i++) expect(denied(await call($))).toBeUndefined()
    await $.skill.prompt({ skill: 'flowdeck', pluginName: 'flowdeck', text: 'x' } as any)
    await turn($)
    for (let i = 0; i < 4; i++) expect(denied(await call($, 'Bash'))).toBeUndefined()
  })

  test('a store that cannot be read never refuses (fail open)', async ($, on) => {
    engine(on, { store: STRICT_ON, storeDown: true })
    await start($)
    await turn($)
    for (const tool of ['Edit', 'Bash', 'Agent', 'Edit', 'Bash']) expect((await call($, tool)).result).toBe('ok')
  })

  test('the loop guard: 2 refusals a turn, then the rest of the turn goes through, logged once; a new turn refuses again', async ($, on) => {
    const { files } = engine(on, { store: STRICT_ON })
    await start($)
    await turn($)
    expect(denied(await call($, 'Edit'))).toBe(STRICT_FLOW_DENY)
    expect(denied(await call($, 'Edit'))).toBe(STRICT_FLOW_DENY)
    expect(logOf(files)).toEqual([])
    const passed = await call($, 'Bash')
    expect(passed.result).toBe('ok')
    expect((passed.context ?? []).some((l: string) => l.startsWith(PLAN_NUDGE))).toBe(true) // let through as an ordinary untracked call
    expect((await call($, 'Edit')).result).toBe('ok')
    expect(logOf(files)).toEqual([{ day: '2026-11-09', time: expect.stringMatching(/^\d\d:\d\d$/), strict: 'flow', tool: 'Bash', denied: 2 }])
    await turn($)
    expect(denied(await call($, 'Edit'))).toBe(STRICT_FLOW_DENY)
  })

  test('the loop guard record is not counted as a turn without a flow', async ($, on) => {
    const { files } = engine(on, { store: STRICT_ON })
    await start($)
    await turn($)
    await call($, 'Edit')
    await call($, 'Edit')
    await call($, 'Read')
    await call($, 'Edit') // let through
    expect(logOf(files)).toHaveLength(1)
    const p = await pane($, 'terminal')
    const text = JSON.stringify(await p.drawn())
    await p.unmount()
    expect(text).not.toContain('without a flow today')
  })
})

describe('strict mode: the step block', () => {
  test('own work on a task without a list is refused after the reminder was shown twice, with the task number', async ($, on) => {
    engine(on, { store: STRICT_ON })
    await start($)
    await compose($) // a fresh session: the prompt holds the rule, yet strict still reminds before it refuses
    await progress($, TWO)
    await turn($)
    const got: (string | undefined)[] = []
    for (let i = 1; i <= 4; i++) {
      const r = await call($, i % 2 ? 'Edit' : 'Bash')
      expect(r.result).toBe('ok')
      got.push(reminder(r))
    }
    expect(got).toEqual([stepRemind(1), undefined, undefined, stepRemind(1)])
    expect(denied(await call($, 'Edit'))).toBe(strictStepDeny(1))
  })

  test('the loop guard lets the 3rd through and logs it once; the step list ends the refusals', async ($, on) => {
    const { files } = engine(on, { store: STRICT_ON })
    await start($)
    await progress($, TWO)
    await turn($)
    for (let i = 0; i < 4; i++) await call($)
    expect(denied(await call($, 'Edit'))).toBe(strictStepDeny(1))
    expect(denied(await call($, 'Bash'))).toBe(strictStepDeny(1))
    expect((await call($, 'Write')).result).toBe('ok')
    expect((await call($, 'Edit')).result).toBe('ok')
    expect(logOf(files)).toEqual([{ day: '2026-11-09', time: expect.stringMatching(/^\d\d:\d\d$/), strict: 'step', tool: 'Write', denied: 2 }])
    await turn($)
    expect(denied(await call($))).toBe(strictStepDeny(1))
    expect(await step($, { task: 1, steps: [{ title: 'fetch' }, { title: 'check' }, { title: 'save' }] })).toBe('ok: task 1')
    for (let i = 0; i < 5; i++) expect((await call($)).result).toBe('ok')
  })

  test('not for calls that hand work on, nor while a worker runs, nor for looking calls', async ($, on) => {
    engine(on, { store: STRICT_ON })
    await start($)
    await progress($, TWO)
    await turn($)
    for (let i = 0; i < 4; i++) await call($)
    expect((await call($, 'Read')).result).toBe('ok')
    expect((await call($, 'TaskCreate')).result).toBe('ok')
    expect((await call($, 'Agent')).result).toBe('ok')
    await spawn($, 'w1', '#2 Write report')
    for (let i = 0; i < 4; i++) expect((await call($)).result).toBe('ok')
  })

  test('not before the flow reaches delegate (no task is the orchestrator\'s yet)', async ($, on) => {
    engine(on, { store: STRICT_ON })
    await start($)
    await progress($, { ...TWO, phase: 'plan' })
    await turn($)
    for (let i = 0; i < 8; i++) expect((await call($)).result).toBe('ok')
  })

  test('never with tracking off', async ($, on) => {
    engine(on, { store: { rule: 'off', strict: 'on' } })
    await start($)
    await progress($, TWO)
    await turn($)
    for (let i = 0; i < 8; i++) expect((await call($)).result).toBe('ok')
  })
})

describe('strict mode: /flowdeck-strict', () => {
  test('registered beside /flowdeck-rule', async ($, on) => {
    const { commands } = engine(on)
    await start($)
    expect(commands.map(c => c.name)).toEqual(['flowdeck-panel', 'flowdeck-agents', 'flowdeck-rule', 'flowdeck-strict'])
    expect(commands.find(c => c.name === 'flowdeck-strict')).toMatchObject({ description: 'Turn strict mode on or off: refuse work while no flow is open', argumentHint: 'on | off | status' })
  })

  test('on, off and status; anything else says how to use it', async ($, on) => {
    const { store } = engine(on)
    await start($)
    expect(await command($, 'status')).toMatch(/^Strict mode is off: /)
    expect(await command($, '')).toMatch(/^Strict mode is off: /)
    expect(await command($, ' ON ')).toMatch(/^Strict mode is on for every project: /)
    expect(store[STRICT_KEY]).toBe('on')
    expect(await command($, 'status')).toMatch(/^Strict mode is on for every project: /)
    await turn($)
    expect(denied(await call($))).toBe(STRICT_FLOW_DENY)
    expect(await command($, 'off')).toMatch(/^Strict mode is off: /)
    expect(store[STRICT_KEY]).toBe('off')
    expect(await command($, 'maybe')).toBe('Usage: /flowdeck-strict on | off | status')
    expect(store[STRICT_KEY]).toBe('off')
  })

  test('with tracking off, the reply says nothing is refused until tracking is on', async ($, on) => {
    engine(on, { store: { rule: 'off' } })
    await start($)
    expect(await command($, 'on')).toContain('Task tracking is off, so nothing is refused until /flowdeck-rule on.')
  })
})

describe('strict mode: the Strict switch', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`beside Track tasks while tracking is on: ○ by default, a press toggles and stores it (${surface})`, async ($, on) => {
      const { store } = engine(on)
      await start($)
      expect(await strictLabel($, surface)).toBe('○ Strict')
      await press($, 'strict-mode', surface)
      expect(store[STRICT_KEY]).toBe('on')
      expect(await strictLabel($, surface)).toBe('● Strict')
      await press($, 'strict-mode', surface)
      expect(store[STRICT_KEY]).toBe('off')
      expect(await strictLabel($, surface)).toBe('○ Strict')
    })

    test(`hidden while tracking is off, back with tracking on (${surface})`, async ($, on) => {
      engine(on, { store: { rule: 'off', strict: 'on' } })
      await start($)
      expect(await strictLabel($, surface)).toBeNull()
      await press($, 'track-tasks', surface)
      expect(await strictLabel($, surface)).toBe('● Strict')
    })
  }
})

describe('strict mode off changes nothing', () => {
  // One scripted session: calls with no flow, a plan, own work, a worker, a finished flow, a new turn; what each call returns.
  async function script($: any): Promise<unknown[]> {
    const out: unknown[] = []
    await start($)
    await turn($)
    for (const tool of ['Read', 'Edit', 'Bash', 'Agent', 'Write', 'Edit', 'ToolSearch', 'Bash']) out.push(await call($, tool))
    out.push(await progress($, TWO))
    for (let i = 0; i < 9; i++) out.push(await call($, i % 3 ? 'Edit' : 'Bash'))
    await turn($)
    for (let i = 0; i < 7; i++) out.push(await call($))
    out.push(await progress($, { finished: true }))
    await turn($)
    for (const tool of ['Edit', 'Edit', 'Edit', 'Agent']) out.push(await call($, tool))
    out.push(await $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false } as any))
    return out
  }

  // What 1.0.0076 returned for the script (strict did not exist): the plan nudge on the 1st and 4th work call with no flow
  // open (turn 1, then again after the flow finished), the step reminder on the 1st and every 3rd own work call of task 1
  // (the prompt was not composed; the count runs across turns), never a refusal.
  const shape = (out: unknown[]) => {
    const flat = out.map((r: any) => ({ deny: r?.deny, plan: (r?.context ?? []).some((l: string) => l.startsWith(PLAN_NUDGE)), step: reminder(r) ?? null }))
    return {
      denied: flat.filter(r => r.deny !== undefined).length,
      plan: flat.map((r, i) => (r.plan ? i : -1)).filter(i => i >= 0),
      step: flat.map((r, i) => (r.step ? i : -1)).filter(i => i >= 0),
    }
  }
  const BEFORE = { denied: 0, plan: [1, 4, 26, 29], step: [9, 12, 15, 18, 21, 24] }
  const BEFORE_OFF = { denied: 0, plan: [], step: [] }
  const runs: Record<string, unknown[]> = {}

  for (const [name, store] of [
    ['never stored', { rule: 'on' }],
    ['off', { rule: 'on', strict: 'off' }],
    ['garbage', { rule: 'on', strict: 'yes' }],
  ] as const) {
    test(`tracking on, strict ${name}: the 1.0.0076 results, no refusal`, async ($, on) => {
      engine(on, { store })
      runs[name] = await script($)
      expect(shape(runs[name]!)).toEqual(BEFORE)
    })
  }

  for (const [name, store] of [
    ['tracking off, strict never stored', { rule: 'off' }],
    ['tracking off, strict on', { rule: 'off', strict: 'on' }],
  ] as const) {
    test(`${name}: no reminder and no refusal`, async ($, on) => {
      engine(on, { store })
      runs[name] = await script($)
      expect(shape(runs[name]!)).toEqual(BEFORE_OFF)
    })
  }

  test('every call returned the very same result whatever the strict value, while strict cannot refuse', () => {
    expect(Object.keys(runs)).toHaveLength(5)
    expect(runs['off']).toEqual(runs['never stored'])
    expect(runs['garbage']).toEqual(runs['never stored'])
    expect(runs['tracking off, strict on']).toEqual(runs['tracking off, strict never stored'])
  })
})
