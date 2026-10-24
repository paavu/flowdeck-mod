import { describe, expect, test } from 'claude-code/testing'

function engine(on: any, store: Record<string, unknown> = {}) {
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
}

const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' } as any)
const plan = ($: any) => $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', total: 3, done: 1, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] } as any)
const pane = ($: any) =>
  $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 60 } } as any)
const band = ($: any, surface: 'desktop' | 'terminal', bodyColumns: number) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } } as any)

describe('the band above the prompt', () => {
  test('keeps what other mods draw there and sits above it', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    const b = await band($, 'desktop', 100)
    expect(await b.find({ type: 'Text', text: 'band below' })).toBeDefined()
    const root: any = await b.drawn()
    const json = JSON.stringify(root)
    expect(json.indexOf('Svg') >= 0 || json.indexOf('svg') >= 0).toBe(true)
    expect(json.indexOf('band below')).toBeGreaterThan(json.search(/×\d/))
    await b.unmount()
  })

  test('stays compact: the drawing is narrow and leaves the right edge clear', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    for (const columns of [60, 100, 200, 400]) {
      const b = await band($, 'desktop', columns)
      const json = JSON.stringify(await b.drawn())
      const w = Number(/"width":(\d+),"height":\d+/.exec(json)?.[1] ?? /width="?(\d+)/.exec(json)?.[1])
      expect(w).toBeLessThanOrEqual(300) // small enough to share a row with a neighbour mod's items
      expect(w).toBeLessThanOrEqual(columns * 8 - 150) // never wider than the slot minus the buttons and the collapse mark
      expect(json).toContain('"paddingRight":5')
      expect(json).toContain('"flexShrink":1') // it gives way instead of pushing a neighbour out
      expect(json).toContain('"overflow":"hidden"')
      await b.unmount()
    }
  })

  test('the terminal band keeps the right edge clear and stacks with the rest', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    const b = await band($, 'terminal', 60)
    const json = JSON.stringify(await b.drawn())
    expect(json).toContain('"paddingRight":5')
    expect(json).toContain('band below')
    await b.unmount()
  })

  test('without a flow nothing is added', async ($, on) => {
    engine(on)
    await start($)
    const b = await band($, 'desktop', 100)
    expect(await b.find({ type: 'Text', text: 'band below' })).toBeDefined()
    expect(JSON.stringify(await b.drawn())).not.toMatch(/×\d/)
    await b.unmount()
  })

  test('the dismiss button hides the band but keeps the flow in the panel', async ($, on) => {
    const store: Record<string, unknown> = {}
    engine(on, store)
    await start($)
    await plan($)
    let b = await band($, 'desktop', 100)
    expect(JSON.stringify(await b.drawn())).toMatch(/×\d/)
    await b.press({ key: 'flowdeck-dismiss' })
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    await b.unmount()
    b = await band($, 'desktop', 100)
    expect(JSON.stringify(await b.drawn())).not.toMatch(/×\d/)
    expect(await b.find({ type: 'Text', text: 'band below' })).toBeDefined() // the rest stays
    await b.unmount()
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: /Ship it/ })).toBeDefined() // the flow is still there
    await p.unmount()
  })

  test('the Band button in the panel brings the band back', async ($, on) => {
    const store: Record<string, unknown> = { bandHidden: true }
    engine(on, store)
    await start($)
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    await plan($)
    // plan() started a new flow, which un-hides; hide again as the user would
    const b0 = await band($, 'desktop', 100)
    await b0.press({ key: 'flowdeck-dismiss' })
    await b0.unmount()
    const p = await pane($)
    expect(await p.find({ type: 'Button', text: /Band/ })).toBeDefined()
    await p.press({ key: 'band' })
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    await p.unmount()
    const b = await band($, 'desktop', 100)
    expect(JSON.stringify(await b.drawn())).toMatch(/×\d/)
    await b.unmount()
  })

  test('a new flow un-hides the band but a progress update inside the same flow does not', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    const b0 = await band($, 'desktop', 100)
    await b0.press({ key: 'flowdeck-dismiss' })
    await b0.unmount()
    const shown = async () => {
      const b = await band($, 'desktop', 100)
      const yes = /×\d/.test(JSON.stringify(await b.drawn()))
      await b.unmount()
      return yes
    }
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    expect(await shown()).toBe(false)
    await $.tool.call({ tool: 'mcp__flowdeck__progress', done: 2 } as any) // the same flow moves on
    expect(await shown()).toBe(false)
    await $.tool.call({ tool: 'mcp__flowdeck__progress', finished: true } as any)
    await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Next', total: 1, tasks: [{ title: 'z', tier: 'light' }] } as any) // a new flow
    expect(await shown()).toBe(true)
  })
})
