import { describe, expect, test } from 'claude-code/testing'

// The band above the prompt in a session like the live one: a plan with waits, workers linked by number and by title,
// step lists, an Incomplete run, accepted task numbers; the panel's Band button; held values from older versions; and a
// chain beneath that fails.

const NOW = Date.UTC(2026, 9, 29, 11, 0)
const SURFACES = ['desktop', 'terminal'] as const

function engine(on: any, opts: { store?: Record<string, unknown>; below?: boolean; isClockDown?: () => boolean } = {}) {
  const store = opts.store ?? {}
  const logs: { text: string; to?: string }[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => (opts.isClockDown?.() ? { deny: 'clock down' } : { value: NOW }))
  on('clock.after', () => ({ value: undefined })) // the wait is over at once: the timer's function runs
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => (logs.push({ text: e.text, to: e.to }), { value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  if (opts.below !== false) on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
  return { store, logs }
}

// A value an older flowdeck wrote: the held state answers it until the new code writes the key.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return r?.value?.version > 0 ? r : { value: { value, version: r?.value?.version ?? 0 } }
  })

// The held runs cannot be read while `isDown` says so.
const agentsDown = (on: any, isDown: () => boolean) =>
  on('state.get', { plugin: 'flowdeck', key: 'agents' }, async (_$: any, e: any, next: any) => (isDown() ? { deny: 'agents down' } : next(e)))

const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const start = ($: any, surface: 'desktop' | 'terminal' = 'desktop') => $.session.start({ surface, isInteractive: true, cwd: '' } as any)
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const spawn = ($: any, id: string, type: string, description: string) => $.agent.spawn({ subagentType: type, description, tool_use_id: id } as any)
const step = ($: any, agentId: string, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__step', agentId, ...input } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const pane = ($: any, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const band = ($: any, surface: 'desktop' | 'terminal', bodyColumns = 100) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns } } as any)

// The flow row is drawn: its count and dismiss buttons (no Finish: a flow finishes by itself), and on the desktop its drawing.
async function rowOf($: any, surface: 'desktop' | 'terminal', bodyColumns = 100) {
  const b = await band($, surface, bodyColumns)
  const crew = await b.find({ type: 'Button', key: 'flowdeck-agents' })
  const finish = await b.find({ type: 'Button', key: 'flowdeck-finish' })
  const dismiss = await b.find({ type: 'Button', key: 'flowdeck-dismiss' })
  const below = await b.find({ type: 'Text', text: 'band below' })
  const svgs = await b.findAll({ type: 'Svg' })
  await b.unmount()
  return { shown: !!crew && !!dismiss, crew: crew ? String(crew.props.label) : '', finish: !!finish, below: !!below, svgs }
}

const PLAN = [
  { title: 'Read the band code', tier: 'light' },
  { title: 'Reproduce in harness', tier: 'careful', after: [1] },
  { title: 'Fix root cause', tier: 'heavy', after: [2, 9, 3] }, // an unknown wait and itself: dropped
  { title: 'Docs and ledger', tier: 'light', after: [3] },
]

async function liveSession($: any) {
  await progress($, { title: 'Band fix', phase: 'delegate', tasks: PLAN })
  await progress($, { add: [{ title: 'Tag the release', tier: 'light', after: [4, 5] }] })
  await spawn($, 'w1', 'flowdeck:flowdeck-light', 'Read the band code')
  await step($, 'w1', { steps: [{ title: 'read' }, { title: 'note' }] })
  await step($, 'w1', { next: true })
  await step($, 'w1', { next: true })
  await complete($, 'w1')
  await spawn($, 'w2', 'flowdeck:flowdeck-careful', '#2 harness repro')
  await step($, 'w2', { steps: [{ title: 'write' }, { title: 'run' }, { title: 'report' }] })
  await complete($, 'w2') // Incomplete: 0 of 3 steps
  await spawn($, 'w3', 'flowdeck:flowdeck-heavy', 'root cause of the missing band') // linked by its tier
  await spawn($, 'x1', 'Explore', 'look around')
  await progress($, { done: [1, 2], phase: 'review' })
}

describe('the band in a live-like session', () => {
  for (const surface of SURFACES) {
    test(`plan with waits, linked workers, Incomplete and accepted runs: the band draws (${surface} session)`, async ($, on) => {
      const { logs } = engine(on)
      await start($, surface)
      await liveSession($)
      for (const s of SURFACES) {
        for (const columns of [40, 100, 400]) {
          const r = await rowOf($, s, columns)
          expect(r.shown).toBe(true)
          expect(r.finish).toBe(false)
          expect(r.below).toBe(true)
          expect(r.crew).toMatch(/^×\d+$/)
        }
      }
      expect(logs.filter(l => /band/.test(l.text))).toEqual([])
    })
  }

  for (const surface of SURFACES) {
    test(`the panel's Band button hides the band and shows it again (${surface} panel)`, async ($, on) => {
      engine(on)
      await start($)
      await liveSession($)
      expect((await rowOf($, 'desktop')).shown).toBe(true)
      const p = await pane($, surface)
      expect(await p.find({ type: 'Button', key: 'band', text: /▾ Band/ })).toBeDefined()
      await p.press({ key: 'band' })
      await settle()
      expect(await p.find({ type: 'Button', key: 'band', text: /▸ Band/ })).toBeDefined()
      for (const s of SURFACES) {
        const r = await rowOf($, s)
        expect(r.shown).toBe(false)
        expect(r.below).toBe(true) // what is drawn beneath stays
      }
      await p.press({ key: 'band' })
      await settle()
      expect(await p.find({ type: 'Button', key: 'band', text: /▾ Band/ })).toBeDefined()
      for (const s of SURFACES) expect((await rowOf($, s)).shown).toBe(true)
      await p.unmount()
    })
  }

  test('a panel open while ✕ hides the band is drawn again, and its Band press brings the band back', async ($, on) => {
    engine(on)
    await start($)
    await liveSession($)
    const p = await pane($, 'desktop') // drawn with the band shown
    const b = await band($, 'desktop')
    await b.press({ key: 'flowdeck-dismiss' }) // hidden from the band itself
    await b.unmount()
    await settle()
    expect(await p.find({ type: 'Button', key: 'band', text: /▸ Band/ })).toBeDefined()
    await p.press({ key: 'band' }) // the person presses Band to bring it back
    await settle()
    await p.unmount()
    expect((await rowOf($, 'desktop')).shown).toBe(true)
  })

  test('the ✕ press then the Band press: hidden, then shown, on both surfaces', async ($, on) => {
    engine(on)
    await start($)
    await liveSession($)
    for (const s of SURFACES) {
      const b = await band($, s)
      await b.press({ key: 'flowdeck-dismiss' })
      await b.unmount()
      await settle()
      expect((await rowOf($, s)).shown).toBe(false)
      const p = await pane($, s)
      await p.press({ key: 'band' })
      await settle()
      await p.unmount()
      expect((await rowOf($, s)).shown).toBe(true)
    }
  })
})

describe('the band from values an older flowdeck held', () => {
  const FLOWS: [string, unknown][] = [
    ['tasks without tier or after', { title: 'Old', total: 3, done: 1, running: 1, phase: 'delegate', isFinished: false, isLinked: true, tasks: [{ title: 'a' }, { title: 'b', after: [1] }, { title: 'c', after: 'x' }] }],
    ['accepted of junk, done past total', { title: 'Old', total: 2, done: 7, running: 0, phase: 'review', isFinished: false, isLinked: true, tasks: [{ title: 'a', tier: 'light', after: [] }], accepted: [1, 'x', null, 9, 2.5] }],
    ['no total, no tasks', { title: 'Old', phase: 'delegate', isLinked: false }],
    ['done not a number', { title: 'Old', total: 3, done: null, running: 'x', phase: 'nope', isFinished: 'no', isLinked: true, tasks: [null, 3, { title: 'z', tier: 5 }] }],
    ['a finished flow', { title: 'Old', total: 2, done: 2, running: 0, phase: 'close', isFinished: true, isLinked: true, tasks: [{ title: 'a', tier: 'light', after: [] }] }],
  ]
  const RUNS = [
    { id: 'w1', type: 'flowdeck-light', description: 'a', model: 'claude-opus-5-5', status: 'done', startedAt: NOW - 60_000, endedAt: NOW - 30_000, stepDone: 1, stepTotal: 3 },
    { id: 'w2', type: 'flowdeck:flowdeck-medium', description: '#2 bee', model: 'claude-opus-5-5', status: 'running', startedAt: NOW - 20_000 },
    { id: 'w3', description: 'no type', status: 'failed', startedAt: NOW - 10_000 },
    { id: 'bad' },
  ]
  for (const [name, flow] of FLOWS) {
    test(`${name}: the band still draws`, async ($, on) => {
      engine(on)
      held(on, 'flow', flow)
      held(on, 'agents', RUNS)
      held(on, 'panel', { isCompact: true })
      for (const s of SURFACES) {
        const r = await rowOf($, s)
        expect(r.shown).toBe(true)
        expect(r.below).toBe(true)
      }
    })
  }
})

describe('the band when what is beneath it fails', () => {
  test('a chain beneath that throws still leaves the flow row', async ($, on) => {
    engine(on, { below: false })
    on('ui.render', () => {
      throw new Error('beneath broke')
    })
    await start($)
    await liveSession($)
    for (const s of SURFACES) expect((await rowOf($, s)).shown).toBe(true)
  })
})

describe('a band that fails says why', () => {
  test('it gives way to what is below and logs the reason once, as a transcript line', async ($, on) => {
    let isDown = false
    const { logs } = engine(on)
    agentsDown(on, () => isDown)
    await start($)
    // No worker left running: nothing outside the band reads the runs while they are down.
    await progress($, { title: 'Band fix', phase: 'delegate', tasks: PLAN })
    isDown = true // the runs the band reads for its flow row fail from now on
    for (const s of SURFACES) {
      for (let i = 0; i < 3; i++) {
        const r = await rowOf($, s)
        expect(r.shown).toBe(false)
        expect(r.below).toBe(true)
      }
    }
    const lines = logs.filter(l => /band above the prompt could not be drawn/.test(l.text))
    expect(lines.length).toBe(1) // once per reason, however often the band redraws
    expect(lines[0]!.to).toBe('transcript')
    expect(lines[0]!.text).toMatch(/^flowdeck: the band above the prompt could not be drawn: .*agents down/)
    // The panel says it too, under its buttons, on both surfaces; the band itself never reads it.
    await settle()
    isDown = false
    for (const s of SURFACES) {
      const p = await pane($, s)
      expect(await p.find({ type: 'Text', text: /^band error: .*agents down/ })).toBeDefined()
      expect(await p.find({ type: 'Button', key: 'band' })).toBeDefined()
      await p.unmount()
    }
  })

  test('a reload clears the band error line; one that happens again is said again', async ($, on) => {
    let isDown = false
    const { logs } = engine(on)
    agentsDown(on, () => isDown)
    await start($)
    await progress($, { title: 'Band fix', phase: 'delegate', tasks: PLAN })
    isDown = true
    await rowOf($, 'desktop')
    await settle()
    isDown = false
    await start($) // a reload runs session.start again
    const p = await pane($, 'desktop')
    expect(await p.find({ type: 'Text', text: /^band error:/ })).toBeUndefined()
    await p.unmount()
    expect((await rowOf($, 'desktop')).shown).toBe(true)
    expect(logs.filter(l => /could not be drawn/.test(l.text)).length).toBe(1)
    isDown = true
    await rowOf($, 'terminal')
    await settle()
    expect(logs.filter(l => /could not be drawn/.test(l.text)).length).toBe(2)
    isDown = false
    const again = await pane($, 'terminal')
    expect(await again.find({ type: 'Text', text: /^band error: .*agents down/ })).toBeDefined()
    await again.unmount()
  })

  test('a band that draws logs nothing', async ($, on) => {
    const { logs } = engine(on)
    await start($)
    await liveSession($)
    for (const s of SURFACES) expect((await rowOf($, s)).shown).toBe(true)
    expect(logs.filter(l => /flowdeck/.test(l.text))).toEqual([])
  })
})
