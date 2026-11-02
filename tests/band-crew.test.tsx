import { describe, expect, test } from 'claude-code/testing'

// The band's crew control: the worker icon sits right before the ×N button, N counts the workers running now.

function engine(on: any) {
  const store: Record<string, unknown> = {}
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
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
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
}

const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '' } as any)
const plan = ($: any) =>
  $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', total: 3, done: 0, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }, { title: 'b', tier: 'light' }, { title: 'c', tier: 'light' }] } as any)
const spawn = ($: any, id: string) => $.agent.spawn({ subagentType: 'flowdeck:flowdeck-light', description: `#${id} job`, tool_use_id: id } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)

async function crewOf($: any, surface: 'desktop' | 'terminal', columns = 100) {
  const b = await $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns } } as any)
  const button = await b.find({ type: 'Button', key: 'flowdeck-agents' })
  const svgs = await b.findAll({ type: 'Svg' })
  const json = JSON.stringify(await b.drawn())
  await b.unmount()
  return { label: String(button?.props.label), svgs, json }
}

describe('the band crew control', () => {
  test('×N counts the workers running now; queued tasks and finished runs do not count', async ($, on) => {
    engine(on)
    await start($)
    await plan($) // three queued tasks, no run
    expect((await crewOf($, 'desktop')).label).toBe('×0')
    await spawn($, 'w1')
    await spawn($, 'w2')
    expect((await crewOf($, 'desktop')).label).toBe('×2')
    await complete($, 'w1')
    expect((await crewOf($, 'desktop')).label).toBe('×1')
    await complete($, 'w2')
    expect((await crewOf($, 'terminal')).label).toBe('×0')
  })

  test('the crew icon is its own Svg before the button, animated only while a worker runs', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    const idle = await crewOf($, 'desktop')
    const row = idle.svgs[0]
    const icon = idle.svgs[idle.svgs.length - 1]
    expect(idle.svgs.length).toBe(2)
    expect(String(icon.props.alt)).toBe('no workers running')
    expect(String(row.props.source)).not.toContain('class="bd"') // the sprite is not in the title row
    expect(idle.json.indexOf(String(icon.props.alt))).toBeLessThan(idle.json.indexOf('×0'))
    expect(String(icon.props.source)).not.toMatch(/class="[^"]*\brun\b/)
    await spawn($, 'w1')
    const busy = await crewOf($, 'desktop')
    const busyIcon = busy.svgs[busy.svgs.length - 1]
    expect(String(busyIcon.props.alt)).toBe('1 worker running')
    expect(String(busyIcon.props.source)).toMatch(/class="[^"]*\brun\b/)
    expect(String(busy.svgs[0].props.source)).not.toContain('class="bd"')
  })

  test('the title row plus the icon and the button stay within the pane width', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    for (const columns of [60, 100, 200, 400]) {
      const r = await crewOf($, 'desktop', columns)
      const widths = r.svgs.map((s: any) => Number(s.props.width))
      // with the ×0 Button (16 px of label, 11 at each side, one 9 px cell over the icon) and the X (8, 11 at each side),
      // within the row: 9 px a column less 14
      expect(widths[1]).toBe(32) // the icon's 5 px inset, its 22.2 px, 5 px of tail
      expect(widths[0]! + widths[1]! - 9 + (16 + 22) + (8 + 22)).toBeLessThanOrEqual(columns * 9 - 14)
    }
  })

  test('the agents card is as wide as its count: a second digit takes 8 px from the bar', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    const bar = async () => Number((await crewOf($, 'desktop')).svgs[0].props.width)
    const one = await bar()
    for (let i = 1; i <= 10; i++) await spawn($, `w${i}`)
    expect((await crewOf($, 'desktop')).label).toBe('×10')
    expect(await bar()).toBe(one - 8)
  })

  test('the terminal keeps the ▣ before the button', async ($, on) => {
    engine(on)
    await start($)
    await plan($)
    await spawn($, 'w1')
    const r = await crewOf($, 'terminal')
    expect(r.label).toBe('×1')
    expect(r.json.indexOf('▣')).toBeGreaterThan(-1)
    expect(r.json.indexOf('▣')).toBeLessThan(r.json.indexOf('×1'))
  })
})
