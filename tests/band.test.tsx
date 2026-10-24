import { describe, expect, test } from 'claude-code/testing'

function engine(on: any) {
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
}

const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' } as any)
const plan = ($: any) => $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', total: 3, done: 1, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] } as any)
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
      expect(w).toBeLessThanOrEqual(420)
      expect(w).toBeLessThanOrEqual(columns * 8 - 150) // never wider than the slot minus the buttons and the collapse mark
      expect(json).toContain('"paddingRight":5')
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
})
