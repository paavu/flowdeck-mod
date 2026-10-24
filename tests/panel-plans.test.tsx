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

  test('without plans it says there are no plans yet', async ($, on) => {
    engine(on)
    await start($)
    const p = await pane($, 'terminal')
    expect(await p.find({ type: 'Text', text: /no plans yet/ })).toBeDefined()
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
    expect(await p.find({ type: 'Text', text: /Beta cleanup/ })).toBeUndefined()
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
