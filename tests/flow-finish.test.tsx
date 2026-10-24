import { describe, expect, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HISTORY = '/work/app/.claude/flowdeck/history.json'

type Fail = { fs?: boolean; store?: boolean; clock?: boolean }

function engine(on: any, opts: { store?: Record<string, unknown>; fail?: Fail } = {}) {
  const store = opts.store ?? {}
  const files: Record<string, string> = {}
  const fail = opts.fail ?? {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => {
    if (fail.clock) throw new Error('clock down')
    return { value: clock.now }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (fail.store) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (fail.store) throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('fs.read', (_$: any, e: any) => {
    if (fail.fs) throw new Error('fs down')
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.write', (_$: any, e: any) => {
    if (fail.fs) throw new Error('EACCES')
    files[e.path] = e.text
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { store, files, clock, fail }
}

const USAGE = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const workers = (on: any) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: USAGE }
  })
}
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-light', description, tool_use_id: id } as any)

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const plan = ($: any, title = 'Ship it') =>
  progress($, { title, total: 2, done: 1, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })
const band = ($: any, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } } as any)
const pane = ($: any) => $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const entries = (files: Record<string, string>): any[] => JSON.parse(files[HISTORY] ?? '[]')
const has = async (m: any, key: string) => (await m.findAll({ type: 'Button' })).some((b: any) => JSON.stringify(b).includes(`"${key}"`))
const bandHas = async ($: any, surface: 'desktop' | 'terminal', key: string) => {
  const b = await band($, surface)
  const yes = await has(b, key)
  await b.unmount()
  return yes
}
const paneText = async ($: any) => {
  const p = await pane($)
  const texts = await p.findAll({ type: 'Text' })
  await p.unmount()
  return texts.map((t: any) => t.text).join('\n')
}
const shown = async ($: any) => {
  const b = await band($, 'desktop')
  const yes = /×\d/.test(JSON.stringify(await b.drawn()))
  await b.unmount()
  return yes
}
// The flow reads Done: a finish on an already finished flow is a no-op that reports its label.
const terminalLabel = async ($: any) => String((await progress($, { finished: true })).result) === 'ok: Done'

describe('the Finish button', () => {
  test('the band shows Finish on both surfaces only while a flow is open', async ($, on) => {
    engine(on)
    await start($)
    expect(await bandHas($, 'desktop', 'flowdeck-finish')).toBe(false)
    await plan($)
    for (const surface of ['desktop', 'terminal'] as const) {
      const b = await band($, surface)
      const finish = await b.find({ type: 'Button', key: 'flowdeck-finish' })
      expect(finish).toBeDefined()
      expect(JSON.stringify(finish)).toContain('Finish')
      const json = JSON.stringify(await b.drawn())
      const at = json.indexOf('flowdeck-finish')
      expect(at).toBeGreaterThan(json.indexOf('flowdeck-agents'))
      expect(at).toBeLessThan(json.indexOf('flowdeck-dismiss'))
      await b.unmount()
    }
    await progress($, { finished: true })
    expect(await bandHas($, 'desktop', 'flowdeck-finish')).toBe(false)
    expect(await bandHas($, 'terminal', 'flowdeck-finish')).toBe(false)
  })

  test('pressing Finish on the band records the flow once as finished and the flow reads Done', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await plan($)
    const b = await band($, 'terminal')
    await b.press({ key: 'flowdeck-finish' })
    await settle()
    await b.unmount()
    const list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].title).toBe('Ship it')
    expect(list[0].status).toBe('finished')
    expect(list[0].done).toBe(1)
    expect(list[0].total).toBe(2)
    expect(await terminalLabel($)).toBe(true)
    expect(await bandHas($, 'terminal', 'flowdeck-finish')).toBe(false)
    expect(await bandHas($, 'desktop', 'flowdeck-finish')).toBe(false)
  })

  test('a second press on a stale band does nothing', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await plan($)
    const b = await band($, 'desktop')
    await b.press({ key: 'flowdeck-finish' })
    await settle()
    await b.press({ key: 'flowdeck-finish' }).catch(() => {})
    await settle()
    await b.unmount()
    expect(entries(files).length).toBe(1)
    expect(await terminalLabel($)).toBe(true)
  })

  test('the panel shows Finish flow while a flow is open and pressing it finishes the flow', async ($, on) => {
    const { files } = engine(on)
    await start($)
    let p = await pane($)
    expect(await has(p, 'flow-finish')).toBe(false)
    await p.unmount()
    await plan($)
    p = await pane($)
    const finish = await p.find({ type: 'Button', key: 'flow-finish' })
    expect(finish).toBeDefined()
    expect(JSON.stringify(finish)).toContain('Finish flow')
    expect(await has(p, 'compact')).toBe(true)
    await p.press({ key: 'flow-finish' })
    await settle()
    await p.press({ key: 'flow-finish' }).catch(() => {})
    await settle()
    await p.unmount()
    const list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('finished')
    expect(list[0].title).toBe('Ship it')
    expect(await terminalLabel($)).toBe(true)
    p = await pane($)
    expect(await has(p, 'flow-finish')).toBe(false)
    expect(await has(p, 'compact')).toBe(true)
    await p.unmount()
    expect(await bandHas($, 'desktop', 'flowdeck-finish')).toBe(false)
  })

  test('a failing store, fs and clock never break the Finish button', async ($, on) => {
    const { fail } = engine(on)
    await start($)
    await plan($)
    fail.fs = true
    fail.store = true
    fail.clock = true
    const b = await band($, 'terminal')
    await b.press({ key: 'flowdeck-finish' })
    await settle()
    await b.unmount()
    expect(await terminalLabel($)).toBe(true)
  })
})

describe('restart', () => {
  test('restart with an open flow records it as finished and starts the new one', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($, 'Old work')
    clock.now = NOW + 60_000
    const r = await progress($, { restart: true, title: 'New work', total: 1, phase: 'delegate', tasks: [{ title: 'new task', tier: 'light' }] })
    expect(String(r.result)).toBe('ok: Tasks 0/1')
    let list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].title).toBe('Old work')
    expect(list[0].status).toBe('finished')
    expect(list[0].done).toBe(1)
    expect(list[0].total).toBe(2)
    expect(list[0].endedAt).toBe(NOW + 60_000)
    const text = await paneText($)
    expect(text).toContain('New work')
    expect(text).toContain('new task')
    expect(text).not.toContain('wire it')
    clock.now = NOW + 120_000
    await progress($, { finished: true })
    list = entries(files)
    expect(list.map(e => e.title)).toEqual(['New work', 'Old work'])
    expect(list[0].startedAt).toBe(NOW + 60_000) // a fresh record, not the old flow's
    expect(list[0].done).toBe(0)
    expect(list[0].total).toBe(1)
    expect(list[0].tasks.map((t: any) => t.title)).toEqual(['new task'])
  })

  test('restart brings a dismissed band back', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    const b = await band($, 'desktop')
    await b.press({ key: 'flowdeck-dismiss' })
    await settle()
    await b.unmount()
    expect(await shown($)).toBe(false)
    await progress($, { restart: true, title: 'Next', total: 1, tasks: [{ title: 'z', tier: 'light' }] })
    expect(await shown($)).toBe(true)
  })

  test('restart keeps running agents and clears finished ones', async ($, on) => {
    engine(on)
    workers(on)
    await start($)
    await plan($)
    await spawn($, 'w1', 'write tests')
    await spawn($, 'w2', 'wire it')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1', usage: USAGE } as any)
    await progress($, { restart: true, title: 'Next', total: 1, tasks: [{ title: 'z', tier: 'light' }] })
    const text = await paneText($)
    expect(text).toContain('wire it')
    expect(text).not.toContain('write tests')
  })

  test('restart without a flow just starts one, and without a title keeps the default title', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await progress($, { restart: true, title: 'Fresh', total: 1, tasks: [{ title: 'z', tier: 'light' }] })
    expect(entries(files).length).toBe(0)
    expect(await paneText($)).toContain('Fresh')
    await progress($, { restart: true, total: 2 })
    expect(entries(files).map(e => e.title)).toEqual(['Fresh'])
    const text = await paneText($)
    expect(text).toContain('flowdeck')
    expect(text).not.toContain('Fresh')
  })

  test('restart after the flow was finished starts a new flow and records nothing twice', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await plan($)
    await progress($, { finished: true })
    expect(entries(files).length).toBe(1)
    await progress($, { restart: true, title: 'Again', total: 1, tasks: [{ title: 'z', tier: 'light' }] })
    expect(entries(files).length).toBe(1)
    expect(await paneText($)).toContain('Again')
    expect(await bandHas($, 'terminal', 'flowdeck-finish')).toBe(true)
  })

  test('a failing store, fs and clock never break restart', async ($, on) => {
    const { fail } = engine(on)
    await start($)
    await plan($)
    fail.fs = true
    fail.store = true
    fail.clock = true
    const r = await progress($, { restart: true, title: 'Next', total: 1, phase: 'delegate', tasks: [{ title: 'z', tier: 'light' }] })
    expect(String(r.result)).toBe('ok: Tasks 0/1')
  })

  test('without restart a linked flow still takes a re-plan, add and a second finish as before', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await plan($)
    await progress($, { title: 'Other', tasks: [{ title: 'third', tier: 'light' }] })
    await progress($, { add: [{ title: 'fourth', tier: 'light' }] })
    expect(entries(files).length).toBe(0)
    const text = await paneText($)
    expect(text).toContain('Other')
    expect(text).toContain('fourth')
    await progress($, { finished: true })
    await progress($, { finished: true })
    expect(entries(files).length).toBe(1)
  })
})
