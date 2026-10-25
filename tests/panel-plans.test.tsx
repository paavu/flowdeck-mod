import { describe, expect, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 26, 12, 40)

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store = opts.store ?? {}
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
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 60) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const plan = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__plan', ...input } as any)
const saved = (store: Record<string, unknown>): any[] => ((store.plans as any)?.s ?? []) as any[]

const STAGES = [
  { name: 'Build', steps: [{ title: 'write tests' }, { title: 'wire tool' }] },
  { name: 'Ship', steps: [{ title: 'commit' }] },
]
const create = ($: any, id: string, title: string) => plan($, { id, title, stages: STAGES })
const finish = ($: any, id: string) => plan($, { id, done: ['write tests', 'wire tool', 'commit'] })

describe('plans section in the panel', () => {
  test('a created plan shows its title, state and percent in the terminal panel', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    await plan($, { id: 'alpha', next: true })
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /Plans/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Alpha rollout {2}Running/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /33%/ })).toBeDefined()
    await p.unmount()
  })

  test('the desktop panel draws one svg per plan', async ($, on) => {
    engine(on)
    await start($)
    const before = await pane($, 'desktop', 80)
    const base = (await before.findAll({ type: 'Svg' })).length
    await before.unmount()
    await create($, 'alpha', 'Alpha rollout')
    const p = await pane($, 'desktop', 80)
    expect((await p.findAll({ type: 'Svg' })).length).toBe(base + 1)
    await p.unmount()
  })

  test('the Plans button hides the section and the choice is stored', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    let p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /▾ Plans/ })).toBeDefined()
    await p.press({ key: 'plans' })
    await settle()
    expect(store.plansShown).toBe(false)
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /▸ Plans/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Alpha rollout/ })).toBeUndefined()
    await p.unmount()
  })

  test('a stored hidden choice starts hidden', async ($, on) => {
    engine(on, { store: { plansShown: false } })
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /▸ Plans/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Alpha rollout/ })).toBeUndefined()
    expect(await p.find({ type: 'Text', text: /no plans yet/ })).toBeUndefined()
    await p.unmount()
  })

  test('without plans the Plans section takes no place', async ($, on) => {
    engine(on)
    await start($)
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /▾ Plans/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /no plans yet/ })).toBeUndefined()
    expect(await p.find({ type: 'Button', text: /Clear finished/ })).toBeUndefined()
    await p.unmount()
  })

  test('Clear finished shows only with a done plan and removes only done plans', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    await create($, 'beta', 'Beta cleanup')
    let p = await pane($, 'terminal')
    expect(await p.find({ type: 'Button', text: /Clear finished/ })).toBeUndefined()
    await p.unmount()
    await finish($, 'beta')
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Beta cleanup {2}Done/ })).toBeDefined()
    await p.press({ key: 'plans-clear' })
    await settle()
    await p.unmount()
    expect(saved(store).map(x => x.id)).toEqual(['alpha'])
    p = await pane($, 'terminal')
    // gone from the Plans section; only its Archive group still draws it
    expect((await p.findAll({ type: 'Text' })).filter((t: any) => /Beta cleanup/.test(t.text))).toHaveLength(1)
    expect(await p.find({ type: 'Text', text: /Alpha rollout/ })).toBeDefined()
    expect(await p.find({ type: 'Button', text: /Clear finished/ })).toBeUndefined()
    await p.unmount()
  })

  test('three plans all show', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    await create($, 'beta', 'Beta cleanup')
    await create($, 'gamma', 'Gamma docs')
    const p = await pane($, 'terminal')
    for (const t of [/Alpha rollout/, /Beta cleanup/, /Gamma docs/]) expect(await p.find({ type: 'Text', text: t })).toBeDefined()
    await p.unmount()
    const d = await pane($, 'desktop', 80)
    const alts = (await d.findAll({ type: 'Svg' })).map((n: any) => String(n.props?.alt ?? ''))
    for (const t of ['Alpha rollout: Running, 0%', 'Beta cleanup: Running, 0%', 'Gamma docs: Running, 0%']) expect(alts).toContain(t)
    await d.unmount()
  })

  test('the section also shows in compact mode', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', total: 1, tasks: [{ title: 'a', tier: 'light' }] } as any) // Collapse belongs to the flow block
    let p = await pane($, 'terminal')
    await p.press({ key: 'compact' })
    await settle()
    await p.unmount()
    p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Alpha rollout/ })).toBeDefined()
    await p.unmount()
    const before = await pane($, 'desktop', 80)
    const alts = (await before.findAll({ type: 'Svg' })).map((n: any) => String(n.props?.alt ?? ''))
    expect(alts).toContain('Alpha rollout: Running, 0%')
    await before.unmount()
  })

  test('a narrow panel does not throw', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    const t = await pane($, 'terminal', 10)
    expect(await t.find({ type: 'Button', text: /Plans/ })).toBeDefined()
    await t.unmount()
    const d = await pane($, 'desktop', 10)
    expect((await d.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(1)
    await d.unmount()
  })

  test('plans restored from the store after a new session start show up', async ($, on) => {
    const stored = {
      id: 'alpha',
      title: 'Alpha rollout',
      kind: 'plan',
      stages: [{ name: 'Build', steps: [{ title: 'write tests', status: 'done', substeps: [] }, { title: 'wire tool', status: 'active', substeps: [] }] }],
      state: 'running',
      note: null,
      startedAt: NOW - 60_000,
    }
    engine(on, { store: { plans: { s: [stored] } } })
    await start($)
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /Alpha rollout/ })).toBeDefined()
    await p.unmount()
  })
})

describe('agent rows: live tool word and state colours', () => {
  const RUNNING = '#8f8cf4'
  const AMBER = '#e8b13c'
  const GREEN = '#5fbf8f'
  const RED = '#e5534b'
  const CAREFUL = '#BA7517'
  const STATE_HEX = new Set([RUNNING, AMBER, GREEN, RED])

  // the bottom of the tool chain; `during` runs while the call is in flight
  const agentEngine = (on: any, during?: (e: any) => Promise<void>, answer: Record<string, unknown> = {}) => {
    const ctx = engine(on)
    on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
    on('classic.PermissionRequest', () => answer)
    on('classic.PermissionDenied', () => ({}))
    on('tool.call', async (_$: any, e: any) => {
      if (during) await during(e)
      return { result: 'ok' }
    })
    return ctx
  }
  const spawn = ($: any, id = 'w1', description = 'wire it') =>
    $.agent.spawn({ subagentType: 'flowdeck-careful', description, tool_use_id: id } as any)
  const call = ($: any, tool: string, agentId?: string, extra: Record<string, unknown> = {}) =>
    $.tool.call({ tool, ...(agentId ? { agentId } : {}), ...extra } as any)
  const ask = ($: any, tool = 'Bash', agentId = 'w1') => $.classic.PermissionRequest({ tool_name: tool, tool_input: {}, agent_id: agentId } as any)
  // the coloured state words of the terminal rows (bars left out)
  const stateWords = (all: any[]) =>
    all.filter(t => STATE_HEX.has(String(t.props.color)) && !/^[█░]+$/.test(t.text)).map(t => ({ text: t.text, color: t.props.color }))
  const words = async ($: any, cols = 80) => {
    const p = await pane($, 'terminal', cols)
    const all = await p.findAll({ type: 'Text' })
    await p.unmount()
    return stateWords(all)
  }
  const paneText = async ($: any, cols = 80) => {
    const p = await pane($, 'terminal', cols)
    const all = await p.findAll({ type: 'Text' })
    await p.unmount()
    return all.map(t => t.text).join('\n')
  }
  // a row's drawing, found by its alt text
  const svgOf = async ($: any, alt: RegExp, cols = 80) => {
    const p = await pane($, 'desktop', cols)
    const el = (await p.findAll({ type: 'Svg' })).find(s => alt.test(String(s.props.alt)))
    await p.unmount()
    return String(el?.props.source ?? '')
  }

  test('a run with no tool yet shows plain Running in the running colour', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    expect(await words($)).toEqual([{ text: 'Running', color: RUNNING }])
  })

  test('a subagent tool call sets the word and a second one replaces it', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, 'Read', 'w1', { file_path: '/x' })
    expect(await words($)).toEqual([{ text: 'Running · Read', color: RUNNING }])
    await call($, 'Bash', 'w1', { command: 'ls' })
    expect(await words($)).toEqual([{ text: 'Running · Bash', color: RUNNING }])
  })

  test('flowdeck’s step, progress and plan calls do not change the word', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, 'Bash', 'w1')
    await call($, 'mcp__flowdeck__step', 'w1', { done: 1, total: 3, note: 'tests' })
    await call($, 'mcp__flowdeck__plan', 'w1', { id: 'x' })
    await call($, 'mcp__flowdeck__progress', 'w1', {})
    expect(await words($)).toEqual([{ text: 'Running · Bash', color: RUNNING }])
    expect(await paneText($)).toMatch(/Running · Bash · 1\/3 tests$/m)
  })

  test('the main agent’s own tool calls change nothing', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, 'Grep')
    expect(await words($)).toEqual([{ text: 'Running', color: RUNNING }])
    await call($, 'Read', 'w1')
    await call($, 'Bash')
    expect(await words($)).toEqual([{ text: 'Running · Read', color: RUNNING }])
  })

  // A Bash call of w1 held open at the bottom of the chain until `release`, as a call waits behind its dialog.
  const holdBash = (on: any, answer: Record<string, unknown> = {}) => {
    let release = () => {}
    let entered = () => {}
    const gate = new Promise<void>(done => (release = done))
    const inside = new Promise<void>(done => (entered = done))
    let useId: string | undefined
    agentEngine(
      on,
      async e => {
        if (e.tool !== 'Bash' || !e.agentId) return
        useId = e.tool_use_id
        entered()
        await gate
      },
      answer,
    )
    return { release: () => release(), inside, useId: () => useId }
  }

  // The harness reads a drawing only once no call is in flight, so these check the call passes through
  // untouched and the row once it is answered; the amber itself is checked on a request outside a call below.
  test('a request during the agent’s call leaves the call untouched and clears once the call is answered', async ($, on) => {
    const held = holdBash(on)
    await start($)
    await spawn($)
    const running = call($, 'Bash', 'w1')
    await held.inside
    expect(await ask($)).toEqual({})
    held.release()
    expect(String((await running).result)).toBe('ok')
    expect(await words($)).toEqual([{ text: 'Running · Bash', color: RUNNING }])
  })

  test('a denied request during the call clears the mark and leaves the call to its own end', async ($, on) => {
    const held = holdBash(on)
    await start($)
    await spawn($)
    const running = call($, 'Bash', 'w1')
    await held.inside
    await ask($)
    await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: held.useId() ?? 'none', reason: 'no', agent_id: 'w1' } as any)
    held.release()
    expect(String((await running).result)).toBe('ok')
    expect(await words($)).toEqual([{ text: 'Running · Bash', color: RUNNING }])
  })

  test('a request a settings hook answers passes its decision through', async ($, on) => {
    const held = holdBash(on, { decision: { behavior: 'allow' } })
    await start($)
    await spawn($)
    const running = call($, 'Bash', 'w1')
    await held.inside
    expect(await ask($)).toEqual({ decision: { behavior: 'allow' } })
    held.release()
    await running
    expect(await words($)).toEqual([{ text: 'Running · Bash', color: RUNNING }])
  })

  test('a denied request outside a call clears Needs approval at once', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await ask($)
    expect(await words($)).toEqual([{ text: 'Needs approval', color: AMBER }])
    await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'none', reason: 'no', agent_id: 'w1' } as any)
    expect(await words($)).toEqual([{ text: 'Running', color: RUNNING }])
  })

  test('a settings hook answer outside a call raises no Needs approval', async ($, on) => {
    agentEngine(on, undefined, { decision: { behavior: 'deny', message: 'no' } })
    await start($)
    await spawn($)
    await ask($)
    expect(await words($)).toEqual([{ text: 'Running', color: RUNNING }])
  })

  test('the agent’s next tool call clears a Needs approval its call left behind', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await ask($)
    expect(await words($)).toEqual([{ text: 'Needs approval', color: AMBER }])
    await call($, 'Read', 'w1')
    expect(await words($)).toEqual([{ text: 'Running · Read', color: RUNNING }])
  })

  test('a request from the main agent or for another agent leaves the row alone', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as any)
    await ask($, 'Bash', 'other')
    expect(await words($)).toEqual([{ text: 'Running', color: RUNNING }])
  })

  test('the run end clears the word: Done in green, a failed run Error in red', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($, 'w1', 'first')
    await spawn($, 'w2', 'second')
    await call($, 'Bash', 'w1')
    await call($, 'Read', 'w2')
    await ask($, 'Read', 'w2')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, agentId: 'w2' } as any)
    const shown = await words($)
    expect(shown).toContainEqual({ text: 'Done', color: GREEN })
    expect(shown).toContainEqual({ text: 'Error', color: RED })
    const text = await paneText($)
    expect(text).not.toMatch(/Bash|Read|Needs approval/)
  })

  test('the desktop row names the state in its colour and draws the bar in it, the tier only on its text', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, 'mcp__flowdeck__step', 'w1', { done: 1, total: 3 })
    await call($, 'Bash', 'w1')
    const src = await svgOf($, /^wire it:/)
    expect(src).toContain(`<tspan fill="${RUNNING}">Running · Bash</tspan>`)
    expect(src).toMatch(new RegExp(`<rect x="42" y="37" width="\\d+" height="4" rx="2" fill="${RUNNING}"/>`))
    expect(src).not.toMatch(new RegExp(`y="37"[^>]*fill="${CAREFUL}"`))
    expect(src).toContain(`<tspan fill="${CAREFUL}">careful</tspan>`)
    expect(src).toContain('1/3')
  })

  test('the desktop row turns amber while a dialog is up and green when done', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await ask($)
    expect(await svgOf($, /^wire it:/)).toContain(`<tspan fill="${AMBER}">Needs approval</tspan>`)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    const src = await svgOf($, /^wire it:/)
    expect(src).toContain(`<tspan fill="${GREEN}">Done</tspan>`)
    expect(src).toMatch(new RegExp(`<rect x="42" y="37" width="\\d+" height="4" rx="2" fill="${GREEN}"/>`))
  })

  test('the terminal bar takes the state colour once steps are reported', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, 'mcp__flowdeck__step', 'w1', { done: 1, total: 2 })
    const p = await pane($, 'terminal', 80)
    const bars = (await p.findAll({ type: 'Text' })).filter(t => /^[█░]+$/.test(t.text) && t.props.color)
    await p.unmount()
    expect(bars.map(b => b.props.color)).toEqual([RUNNING])
  })

  test('a long tool word is cut to fit a narrow panel, the stats stay', async ($, on) => {
    const LONG = 'mcp__some-server__a_really_long_tool_name_for_testing'
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, LONG, 'w1')
    const src = await svgOf($, /^wire it:/, 40)
    expect(src).toContain(`<tspan fill="${RUNNING}">Running · `)
    expect(src).toContain('…')
    expect(src).not.toContain(LONG)
    expect(src).toContain('ctx 0%')
    const shown = await words($, 40)
    expect(shown.length).toBe(1)
    expect(shown[0]!.text.endsWith('…')).toBe(true)
    expect(shown[0]!.text).not.toContain(LONG)
    expect(await paneText($, 40)).toContain('ctx 0%')
    expect((await words($, 120))[0]!.text).toBe(`Running · ${LONG}`)
  })

  // the row's text lines by their y, tags stripped; the same width estimate the row uses
  const lineAt = (src: string, y: number) =>
    [...src.matchAll(new RegExp(`<text[^>]* y="${y}"[^>]*>(.*?)</text>`, 'g'))].map(m => m[1]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'))
  const charEm = (ch: string) => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56)
  const width11 = (s: string) => [...s].reduce((w, ch) => w + charEm(ch) * 11, 0)
  const STATS = ['ctx 0% · 0  ≈$0.00  0:00', 'ctx 0% · 0  ≈$0.00', 'ctx 0%  ≈$0.00', 'ctx 0%']
  // desktop W = cols * 8 - 8, at least 240; the text slot is W - 64; the title is native, so the model line is at y 16, the state at 31
  const rowAt = async ($: any, cols: number) => {
    const src = await svgOf($, /^wire it:/, cols)
    const [meta = '', stats = ''] = lineAt(src, 16)
    return { src, meta, stats, state: lineAt(src, 31), slot: Math.max(240, cols * 8 - 8) - 64 }
  }
  const stepped = async ($: any, on: any, note = 'Device verification') => {
    agentEngine(on)
    await start($)
    await spawn($)
    await call($, 'Bash', 'w1')
    await call($, 'mcp__flowdeck__step', 'w1', { done: 4, total: 6, note })
  }

  test('a wide row puts the full stats on the model line and gives the state line the whole width', async ($, on) => {
    await stepped($, on)
    const r = await rowAt($, 76)
    expect(r.meta).toContain('Opus 5.5')
    expect(r.stats).toBe(STATS[0])
    expect(r.src).toMatch(/<text class="s" x="\d+" y="16" text-anchor="end"/)
    expect(r.state).toEqual(['Running · Bash · 4/6 · Device verification'])
    expect(r.src).not.toContain('NaN')
  })

  test('a narrower row drops the time first and never cuts the model meta', async ($, on) => {
    await stepped($, on)
    // W 272: the meta here has no effort word, so this is where the time no longer fits
    const r = await rowAt($, 35)
    const room = r.slot - width11(r.meta) - 12
    expect(r.meta).not.toContain('…')
    expect(r.meta).toContain('Opus 5.5')
    expect(r.stats).toBe(STATS.find(v => width11(v) <= room))
    expect(r.stats).not.toMatch(/\d:\d\d/)
    expect(r.stats.startsWith('ctx 0%')).toBe(true)
    const [t = ''] = r.state
    expect(t.startsWith('Running · Bash · 4/6 · Device verif')).toBe(true)
    expect(width11(t)).toBeLessThanOrEqual(r.slot)
    if (t.endsWith('…')) expect(width11(t)).toBeGreaterThan(r.slot - 12)
  })

  test('the narrowest row keeps only ctx or nothing, and no text outgrows its slot', async ($, on) => {
    await stepped($, on)
    const r = await rowAt($, 30)
    expect(r.meta).not.toContain('…')
    expect(r.stats).toBe('ctx 0%')
    if (r.stats) expect(width11(r.meta) + 12 + width11(r.stats)).toBeLessThanOrEqual(r.slot)
    for (const t of r.state) expect(width11(t)).toBeLessThanOrEqual(r.slot)
    expect(r.src).not.toContain('NaN')
  })

  test('a long step note is cut only at the full row width', async ($, on) => {
    const NOTE = 'Device verification across every connected phone, tablet and foldable in the lab, then a second full pass'
    await stepped($, on, NOTE)
    const r = await rowAt($, 76)
    const [t = ''] = r.state
    expect(t.endsWith('…')).toBe(true)
    expect(t.startsWith('Running · Bash · 4/6 · Device verification across')).toBe(true)
    expect(width11(t)).toBeLessThanOrEqual(r.slot)
    expect(width11(t)).toBeGreaterThan(r.slot - 12)
    expect(r.stats).toBe(STATS[0])
  })

  test('finished and failed desktop rows carry the stats on the model line', async ($, on) => {
    agentEngine(on)
    await start($)
    await spawn($, 'w1', 'first')
    await spawn($, 'w2', 'second')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, agentId: 'w2' } as any)
    for (const name of ['first', 'second']) {
      const src = await svgOf($, new RegExp(`^${name}:`), 76)
      expect(lineAt(src, 16)[1]).toBe(STATS[0])
      expect(lineAt(src, 31).join('')).not.toContain('ctx')
      expect(src).not.toContain('NaN')
    }
  })

  test('the terminal row puts the stats on the model line when they fit, else leaves them out', async ($, on) => {
    await stepped($, on)
    const wide = (await paneText($, 80)).split('\n')
    const model = wide.find(l => l.includes('Opus 5.5'))!
    expect(model).toContain('ctx 0% · 0 ≈$0.00 0:00')
    expect(wide.find(l => l.includes('Device verification'))).not.toContain('ctx')
    const narrow = (await paneText($, 30)).split('\n')
    const m2 = narrow.find(l => l.includes('Opus 5.5'))!
    expect(m2.length).toBeLessThanOrEqual(30)
    expect(m2).not.toMatch(/\d:\d\d/)
    expect(narrow.join('\n')).not.toContain('NaN')
    const tight = (await paneText($, 24)).split('\n')
    expect(tight.find(l => l.includes('Opus 5.5'))).not.toContain('ctx')
  })

  test('planned rows keep their neutral look; a matched task shows as its run', async ($, on) => {
    agentEngine(on)
    await start($)
    await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship', total: 2, phase: 'delegate', tasks: [{ title: 'wire it', tier: 'careful' }, { title: 'later', tier: 'light' }] } as any)
    await spawn($, 'w1', 'wire it')
    expect(await words($)).toEqual([{ text: 'Running', color: RUNNING }])
    expect(await paneText($)).toMatch(/2\. later ◷/)
    expect(await svgOf($, /^1\. wire it/)).toBe('')
    const planned = await svgOf($, /^2\. later/)
    expect(planned).toContain('later')
    for (const hex of STATE_HEX) expect(planned).not.toContain(hex)
    expect(planned).not.toMatch(/Running|Needs approval/)
  })
})
