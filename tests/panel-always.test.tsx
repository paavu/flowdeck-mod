import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'

// The panel always draws: values an older flowdeck left in the held state (a reload keeps them), a section that fails
// and an empty session all leave the top buttons, Context, Usage and the Archive on screen.

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HOUR = 3_600_000
const SURFACES = ['terminal', 'desktop'] as const

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store = opts.store ?? {}
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
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store }
}

// A value an older flowdeck wrote: the held state answers it until the new code writes the key.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return r?.value?.version > 0 ? r : { value: { value, version: r?.value?.version ?? 0 } }
  })

// A value the held state always answers, whatever was written.
const pinned = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return { value: { value, version: r?.value?.version ?? 0 } }
  })

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const band = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const plan = ($: any) =>
  progress($, { title: 'Ship it', total: 2, done: 1, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })

// The panel as the first flowdeck versions wrote it: none of the archive fields, the old History names.
const OLD_PANEL = { isCompact: false, isDoneCollapsed: false, isContextShown: true, isUsageShown: true, isHistoryShown: true, openFinished: [], historyLimit: 10, autoOpenedFor: '' }
const OLD_FLOW = {
  title: 'Ship it',
  total: 2,
  done: 1,
  running: 0,
  phase: 'delegate',
  isFinished: false,
  isLinked: true,
  tasks: [
    { title: 'write tests', tier: 'careful', after: [] },
    { title: 'wire it', tier: 'medium', after: [1] },
  ],
}
// Runs from before `archived` existed.
const OLD_AGENTS = [
  {
    id: 'w1',
    agentId: 'w1',
    type: 'flowdeck-careful',
    description: 'write tests',
    model: 'claude-opus-5-5',
    effort: 'high',
    status: 'done',
    startedAt: NOW - 10 * 60_000,
    endedAt: NOW - 5 * 60_000,
    contextTokens: 1000,
    contextMax: 1_000_000,
    tokens: 12_000,
    costUsd: 0.5,
    steps: 3,
    round: 1,
    stepDone: 2,
    stepTotal: 2,
    items: [
      { title: 'step one', status: 'done' },
      { title: 'step two', status: 'done' },
    ],
  },
  {
    id: 'w2',
    agentId: 'w2',
    type: 'flowdeck-medium',
    description: 'wire it',
    model: 'claude-opus-5-5',
    status: 'running',
    startedAt: NOW - 2 * 60_000,
    contextTokens: 500,
    contextMax: 1_000_000,
    tokens: 4000,
    costUsd: 0.1,
    steps: 1,
    round: 1,
  },
]
// Archive entries saved before `partial` existed.
const entry = (i: number) => ({
  id: `e${i}`,
  project: '/work/app',
  title: `Old flow ${i}`,
  startedAt: NOW - (i + 2) * HOUR,
  endedAt: NOW - (i + 1) * HOUR,
  status: 'finished',
  done: 1,
  total: 2,
  tasks: [
    { title: 'write tests', tier: 'careful' },
    { title: 'wire it', tier: 'medium' },
  ],
  cost: 1.5,
  tokens: 12_000,
  time: 30 * 60_000,
})

const TOP = ['context', 'usage', 'plans', 'band', 'archive']
const hasTop = async (p: any) => {
  for (const key of TOP) expect(await p.find({ type: 'Button', key })).toBeDefined()
}
const holdOld = (on: any) => {
  held(on, 'panel', OLD_PANEL)
  held(on, 'flow', OLD_FLOW)
  held(on, 'agents', OLD_AGENTS)
}

describe('a panel held from an older flowdeck', () => {
  test('draws every section after a reload, on both surfaces', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [entry(2), entry(1)] } })
    holdOld(on)
    await start($) // a reload runs session.start again
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      await hasTop(p)
      expect(await p.find({ type: 'Button', key: 'flow-finish' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /write tests/ })).toBeDefined()
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e2')}` })).toBeDefined()
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}` })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /could not be drawn|could not draw/ })).toBeUndefined()
      await p.unmount()
    }
  })

  test('draws before session.start has run again too', async ($, on) => {
    engine(on)
    holdOld(on)
    held(on, 'archive', [entry(2), entry(1)])
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      await hasTop(p)
      expect(await p.find({ type: 'Text', text: /write tests/ })).toBeDefined()
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}` })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /could not be drawn|could not draw/ })).toBeUndefined()
      await p.unmount()
    }
  })

  test('the band draws from it and its dismiss hides only the band', async ($, on) => {
    engine(on)
    holdOld(on)
    on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
    for (const surface of SURFACES) {
      const b = await band($, surface)
      expect(await b.find({ type: 'Button', key: 'flowdeck-agents' })).toBeDefined()
      await b.unmount()
    }
    const b = await band($, 'terminal')
    await b.press({ key: 'flowdeck-dismiss' })
    await b.unmount()
    const again = await band($, 'terminal')
    expect(await again.find({ type: 'Button', key: 'flowdeck-agents' })).toBeUndefined()
    expect(await again.find({ type: 'Text', text: 'band below' })).toBeDefined()
    await again.unmount()
  })

  // Each press reads the old-shaped panel itself: nothing has written the key before it.
  const presses: [string, string, (p: any) => Promise<unknown>, (p: any) => Promise<unknown>][] = [
    ['context', 'context', p => p.find({ type: 'Button', key: 'context', text: /▾ Context/ }), p => p.find({ type: 'Button', key: 'context', text: /▸ Context/ })],
    ['usage', 'usage', p => p.find({ type: 'Button', key: 'usage', text: /▾ Usage/ }), p => p.find({ type: 'Button', key: 'usage', text: /▸ Usage/ })],
    ['plans', 'plans', p => p.find({ type: 'Button', key: 'plans', text: /▾ Plans/ }), p => p.find({ type: 'Button', key: 'plans', text: /▸ Plans/ })],
    ['band', 'band', p => p.find({ type: 'Button', key: 'band', text: /▾ Band/ }), p => p.find({ type: 'Button', key: 'band', text: /▸ Band/ })],
    ['archive', 'archive', p => p.find({ type: 'Button', key: 'archive', text: /▾ Archive/ }), p => p.find({ type: 'Button', key: 'archive', text: /▸ Archive/ })],
    ['compact', 'compact', p => p.find({ type: 'Button', key: 'compact', text: /Collapse/ }), p => p.find({ type: 'Button', key: 'compact', text: /Expand/ })],
    ['done', 'done', p => p.find({ type: 'Button', key: 'done', text: /▾ Finished/ }), p => p.find({ type: 'Button', key: 'done', text: /▸ Finished/ })],
    ['agent fold', 'agent-fold-w1', p => p.find({ type: 'Button', key: 'agent-fold-w1', text: '▸' }), p => p.find({ type: 'Button', key: 'agent-fold-w1', text: '▾' })],
    ['open archive group', `archive-${keyOf('e2')}`, p => p.find({ type: 'Button', key: `archive-${keyOf('e2')}`, text: /^▾/ }), p => p.find({ type: 'Button', key: `archive-${keyOf('e2')}`, text: /^▸/ })],
    ['folded archive group', `archive-${keyOf('e1')}`, p => p.find({ type: 'Button', key: `archive-${keyOf('e1')}`, text: /^▸/ }), p => p.find({ type: 'Button', key: `archive-${keyOf('e1')}`, text: /^▾/ })],
    ['finish flow', 'flow-finish', p => p.find({ type: 'Button', key: 'flow-finish' }), async p => ((await p.find({ type: 'Button', key: 'flow-finish' })) ? undefined : true)],
    ['archive item', 'archive-item-w1', p => p.find({ type: 'Button', key: 'archive-item-w1' }), p => p.find({ type: 'Text', text: /1 archived/ })],
  ]
  for (const [name, key, before, after] of presses) {
    for (const surface of SURFACES) {
      test(`the ${name} press works on it (${surface})`, async ($, on) => {
        engine(on)
        holdOld(on)
        held(on, 'archive', [entry(2), entry(1)])
        const p = await pane($, surface)
        expect(await before(p)).toBeDefined()
        await p.press({ key })
        expect(await after(p)).toBeDefined()
        expect(await p.find({ type: 'Text', text: /could not be drawn|could not draw/ })).toBeUndefined()
        await p.unmount()
      })
    }
  }
})

describe('a failing part leaves the rest drawn', () => {
  test('a section that throws draws one dim line, and the others draw', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [entry(1)] } })
    on('state.get', { plugin: 'flowdeck', key: 'reading' }, () => ({ deny: 'reading down' })) // the read itself fails
    await start($)
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      expect(await p.find({ type: 'Text', text: 'Context could not be drawn' })).toBeDefined()
      await hasTop(p)
      expect(await p.find({ type: 'Text', text: /no usage data yet/ })).toBeDefined()
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}` })).toBeDefined()
      await p.unmount()
    }
  })

  test('an archive group that throws draws one dim line, and the other groups draw', async ($, on) => {
    engine(on)
    pinned(on, 'archive', [entry(2), { ...entry(1), tasks: [null] }])
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      expect((await p.findAll({ type: 'Text', text: 'Archive group could not be drawn' })).length).toBe(1)
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e2')}` })).toBeDefined()
      await hasTop(p)
      await p.unmount()
    }
  })

  test('when the whole panel fails it still draws its buttons and says so', async ($, on) => {
    engine(on)
    on('state.get', { plugin: 'flowdeck', key: 'panel' }, () => ({ deny: 'panel down' })) // the read itself fails
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      expect(await p.find({ type: 'Text', text: 'flowdeck could not draw this panel' })).toBeDefined()
      await hasTop(p)
      await p.unmount()
    }
  })

  test('the band never throws into the prompt area', async ($, on) => {
    engine(on)
    on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
    on('state.get', { plugin: 'flowdeck', key: 'flow' }, () => ({ deny: 'flow down' })) // the read itself fails
    for (const surface of SURFACES) {
      const b = await band($, surface)
      expect(await b.find({ type: 'Text', text: 'band below' })).toBeDefined()
      await b.unmount()
    }
  })
})

describe('the panel without a flow', () => {
  test('draws the top buttons, Context, Usage and the Archive (shown by default), and no flow block', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      await hasTop(p)
      expect(await p.find({ type: 'Button', key: 'archive', text: /▾ Archive/ })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /no context data yet/ })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /no usage data yet/ })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /No subagents yet|no plans yet/ })).toBeUndefined()
      expect(await p.find({ type: 'Button', key: 'flow-finish' })).toBeUndefined()
      expect(await p.find({ type: 'Button', key: 'compact' })).toBeUndefined()
      await p.unmount()
    }
  })

  test('a stored hidden Archive choice still hides it', async ($, on) => {
    engine(on, { store: { historyShown: false, history: [entry(1)] } })
    await start($)
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      expect(await p.find({ type: 'Button', key: 'archive', text: /▸ Archive/ })).toBeDefined()
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}` })).toBeUndefined()
      expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeUndefined()
      await p.unmount()
    }
  })

  test('a running flow adds the flow block beside Context, Usage and the Archive', async ($, on) => {
    engine(on)
    on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
    await start($)
    await plan($)
    await $.agent.spawn({ subagentType: 'flowdeck-careful', description: 'write tests', tool_use_id: 'w1' } as any)
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      await hasTop(p)
      expect(await p.find({ type: 'Button', key: 'flow-finish' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /write tests/ })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /no context data yet/ })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeDefined()
      await p.unmount()
    }
  })
})
