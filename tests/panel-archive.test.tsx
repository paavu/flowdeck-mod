import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { showTab } from './tabs'
import type { Tab } from './tabs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HOUR = 3_600_000

function engine(on: any, opts: { store?: Record<string, unknown>; storeFails?: boolean; clock?: { now: number } } = {}) {
  const store = opts.store ?? {}
  const clock = opts.clock ?? { now: NOW }
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
  return { store, clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const plan = ($: any, title = 'Ship it') =>
  progress($, { title, total: 2, done: 1, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })
// The Archive tab, unless another is named.
const pane = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 80, tab: Tab = 'archive') => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
}

// No fs hook answers here, so the project files cannot be read or written: these tests run on the
// shared-store fallback (tests/project-store.test.tsx covers the files), which shows this project's entries.
const entry = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `e${i}`,
  project: '/work/app',
  title: `Old flow ${i}`,
  startedAt: NOW - 2 * HOUR,
  endedAt: NOW - HOUR,
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
  ...extra,
})

const stored = (store: Record<string, unknown>): any[] => (Array.isArray(store.history) ? (store.history as any[]) : [])

const USAGE = { model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const workers = (on: any) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: USAGE }
  })
}
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-light', description, tool_use_id: id } as any)
const turnStep = async ($: any, agentId: string) => {
  const s = $.turn.step({ agentId, model: 'claude-opus-5-5', turnId: 't', index: 0, messageCount: 1 } as any)
  for await (const _ of s);
}
const terminalText = async ($: any) => {
  const p = await pane($)
  const texts = await p.findAll({ type: 'Text' })
  await p.unmount()
  return texts.map((t: any) => t.text).join('\n')
}

describe('the archive of flows', () => {
  test('finishing a flow stores one entry, and finishing again does not duplicate it', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($)
    await progress($, { finished: true })
    expect(stored(store).length).toBe(1)
    const e = stored(store)[0]
    expect(e.title).toBe('Ship it')
    expect(e.done).toBe(1)
    expect(e.total).toBe(2)
    expect(e.project).toBe('/work/app')
    expect(e.status).toBe('finished')
    expect(e.tasks.length).toBe(2)
    await progress($, { finished: true })
    expect(stored(store).length).toBe(1)
    expect(stored(store)[0].title).toBe('Ship it')
  })

  test('finishing an already finished flow is a no-op: the panel keeps its agents and no blank entry is stored', async ($, on) => {
    const { store, clock } = engine(on)
    workers(on)
    await start($)
    await plan($)
    await spawn($, 'w1', 'write tests')
    await spawn($, 'w2', 'wire it')
    await turnStep($, 'w2')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1', usage: USAGE } as any)
    clock.now = NOW + 60_000
    expect(String((await progress($, { finished: true })).result)).toBe('ok: Done')
    clock.now = NOW + 120_000
    expect(String((await progress($, { finished: true })).result)).toBe('ok: Done')
    expect(stored(store).map((x: any) => x.title)).toEqual(['Ship it'])
    expect(await terminalText($)).toContain('write tests')
  })

  test('an agent still running when its flow is replaced is counted only in the flow it started in', async ($, on) => {
    const { store, clock } = engine(on)
    workers(on)
    await start($)
    await plan($, 'First')
    clock.now = NOW + 1000
    await spawn($, 'w1', 'write tests')
    await turnStep($, 'w1')
    clock.now = NOW + 60_000
    await progress($, { finished: true })
    clock.now = NOW + 120_000
    await plan($, 'Second')
    clock.now = NOW + 180_000
    await progress($, { finished: true })
    const [second, first] = stored(store)
    expect(first.title).toBe('First')
    expect(Math.round(first.cost * 100)).toBe(400)
    expect(second.title).toBe('Second')
    expect(second.cost).toBe(0)
    expect(second.tokens).toBe(0)
    expect(second.time).toBe(0)
  })

  test('a new flow after a finished one keeps both, newest first', async ($, on) => {
    const { store, clock } = engine(on)
    await start($)
    await progress($, { title: 'First', total: 1, done: 0, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })
    clock.now = NOW + 60_000
    await progress($, { finished: true })
    clock.now = NOW + 120_000
    await plan($, 'Second')
    expect(stored(store).length).toBe(1)
    expect(stored(store)[0].title).toBe('First')
    await progress($, { finished: true })
    expect(stored(store).map((x: any) => x.title)).toEqual(['Second', 'First'])
  })

  test('a new flow replacing an unfinished one stores the old one as finished', async ($, on) => {
    const { store, clock } = engine(on)
    on('tool.call', () => ({ result: 'ok' }))
    on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'opus' }))
    await start($)
    // A worker launched without a progress report starts an unlinked flow, which a titled report replaces.
    await $.tool.call({ tool: 'Agent', subagent_type: 'flowdeck-light', description: 'loose task', prompt: 'p' } as any)
    await $.agent.spawn({ subagentType: 'flowdeck-light', description: 'loose task', tool_use_id: 't1' } as any)
    clock.now = NOW + 60_000
    await plan($, 'Next one')
    expect(stored(store).length).toBe(1)
    expect(stored(store)[0].title).toBe('flowdeck')
    expect(stored(store)[0].status).toBe('finished')
    expect(stored(store)[0].time).toBe(60_000)
  })

  test('the session ending with an open flow stores it as open', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(stored(store).length).toBe(1)
    expect(stored(store)[0].status).toBe('open')
    expect(stored(store)[0].title).toBe('Ship it')
  })

  test('the session ending after a finished flow adds nothing more', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($)
    await progress($, { finished: true })
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(stored(store).length).toBe(1)
    expect(stored(store)[0].status).toBe('finished')
  })

  test('an open flow saved at the end and finished later stays one entry', async ($, on) => {
    const { store } = engine(on)
    await start($)
    await plan($)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await progress($, { finished: true })
    expect(stored(store).length).toBe(1)
    expect(stored(store)[0].status).toBe('finished')
  })

  test('the project is the folder of the session that ran the flow', async ($, on) => {
    const { store } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/other/site' } as any)
    await plan($)
    await progress($, { finished: true })
    expect(stored(store)[0].project).toBe('/other/site')
  })

  test('51 flows are all kept, newest first', async ($, on) => {
    const { store, clock } = engine(on)
    await start($)
    for (let i = 1; i <= 51; i++) {
      clock.now = NOW + i * 60_000
      await plan($, `Flow ${i}`)
      await progress($, { finished: true })
    }
    expect(stored(store).length).toBe(51)
    expect(stored(store)[0].title).toBe('Flow 51')
    expect(stored(store)[50].title).toBe('Flow 1')
  })

  test('a save keeps entries another session wrote meanwhile', async ($, on) => {
    const { store } = engine(on)
    await start($)
    store.history = [entry(1)]
    await plan($)
    await progress($, { finished: true })
    expect(stored(store).map((x: any) => x.title)).toEqual(['Ship it', 'Old flow 1'])
  })

  test('a throwing store does not break progress', async ($, on) => {
    engine(on, { storeFails: true })
    await start($)
    const r: any = await plan($)
    expect(String(r?.result ?? r)).toContain('ok')
    const done: any = await progress($, { finished: true })
    expect(String(done?.result ?? done)).toContain('ok')
    const p = await pane($)
    expect((await p.findAll({ type: 'Button' })).some((b: any) => /^archive-k[a-z0-9]+$/.test(String(b.props.key)))).toBe(true)
    await p.unmount()
  })
})

describe('archive section in the panel', () => {
  test('the Archive tab lists the saved sessions with their count; there is no hide toggle', async ($, on) => {
    engine(on, { store: { history: [entry(1)] } })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Button', key: 'archive' })).toBeUndefined()
    expect(await p.find({ type: 'Button', key: 'tab-archive', text: 'Archive (1)' })).toBeDefined()
    expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}`, text: /^▾ .* \(2\)$/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Old flow 1|1\/2|finished/ })).toBeUndefined()
    expect(await p.find({ type: 'Text', text: /≈\$1\.50 · 12k tokens · 30:00/ })).toBeDefined()
    await p.unmount()
  })

  test('a stored shown choice starts shown, newest first, on the desktop too', async ($, on) => {
    // e2 ended later: the order comes from the end (equal ends would sort by id)
    engine(on, { store: { historyShown: true, history: [entry(2, { endedAt: NOW - HOUR / 2 }), entry(1)] } })
    await start($)
    await settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const buttons = (await p.findAll({ type: 'Button' })).filter((b: any) => /^archive-k[a-z0-9]+$/.test(String(b.props.key)))
      expect(buttons.map((b: any) => String(b.props.key))).toEqual([`archive-${keyOf('e2')}`, `archive-${keyOf('e1')}`])
      await p.unmount()
    }
  })

  test('the only entry shows its task lines, pressing folds them and pressing again expands them', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [entry(1)] } })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Button', text: /^▾ .* \(2\)$/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /✓ write tests \(careful\)/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /○ wire it \(medium\)/ })).toBeDefined()
    await p.press({ key: `archive-${keyOf('e1')}` })
    await settle()
    expect(await p.find({ type: 'Button', text: /^▸ .* \(2\)$/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /write tests \(careful\)/ })).toBeUndefined()
    await p.press({ key: `archive-${keyOf('e1')}` })
    await settle()
    expect(await p.find({ type: 'Text', text: /✓ write tests \(careful\)/ })).toBeDefined()
    await p.unmount()
  })

  test('the archive shows in the compact panel too', async ($, on) => {
    engine(on, { store: { historyShown: true, history: [entry(1)] } })
    await start($)
    await settle()
    await plan($) // Collapse belongs to the flow block
    for (const surface of ['terminal', 'desktop'] as const) {
      let p = await pane($, surface, 80, 'active')
      await p.press({ key: 'compact' })
      await settle()
      await p.unmount()
      p = await pane($, surface)
      expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}` })).toBeDefined()
      await p.unmount()
      p = await pane($, surface, 80, 'active')
      await p.press({ key: 'compact' })
      await settle()
      await p.unmount()
    }
  })

  test('the empty archive says so', async ($, on) => {
    engine(on, { store: { historyShown: true } })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeDefined()
    await p.unmount()
  })

  test('a finished flow appears in the open panel', async ($, on) => {
    engine(on, { store: { historyShown: true } })
    await start($)
    await plan($)
    await progress($, { finished: true })
    const p = await pane($)
    expect(await p.find({ type: 'Button', text: /^▾ .* \(2\)$/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /Ship it|1\/2|finished/ })).toBeUndefined()
    await p.unmount()
  })

  for (const [name, saved] of [
    ['a string', 'nope'],
    ['a list with a null', [null, entry(1)]],
    ['an object', { id: 1 }],
    ['a number', 42],
  ] as [string, unknown][]) {
    test(`garbage in the store (${name}) breaks neither the session start nor the panel`, async ($, on) => {
      const { store } = engine(on, { store: { historyShown: true, history: saved } })
      await start($)
      await settle()
      const p = await pane($)
      if (Array.isArray(saved)) expect(await p.find({ type: 'Button', key: `archive-${keyOf('e1')}` })).toBeDefined()
      else expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeDefined()
      await p.unmount()
      await plan($, 'After garbage')
      await progress($, { finished: true })
      expect(stored(store)[0].title).toBe('After garbage')
      expect(stored(store).length).toBe(Array.isArray(saved) ? 2 : 1)
    })
  }
})
