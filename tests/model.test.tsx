import { describe, expect, test } from 'claude-code/testing'

import { parseArchive, snapshot } from '../hooks/archive'
import { asFlow } from '../hooks/shapes'
import { modelOf } from '../hooks/tasks'

const NOW = Date.UTC(2026, 9, 31, 11, 0)

function engine(on: any) {
  const store: Record<string, unknown> = {}
  const registered: any[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', (_$: any, e: any) => {
    registered.push(e)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { registered }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '' } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const pane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const terminal = async ($: any) => {
  const p = await pane($, 'terminal')
  const texts = await p.findAll({ type: 'Text' })
  await p.unmount()
  return texts.map((x: any) => x.text).join('\n')
}
const desktop = async ($: any) => {
  const p = await pane($, 'desktop')
  const svgs = await p.findAll({ type: 'Svg' })
  await p.unmount()
  return (alt: RegExp) => String(svgs.find((s: any) => alt.test(String(s.props.alt)))?.props.source ?? '')
}
const metaOf = (src: string) => /<tspan class="m">([^<]*)<\/tspan>/.exec(src)?.[1] ?? ''

const PLAN = [
  { title: 'Fix glyph', tier: 'light' },
  { title: 'Build it', tier: 'medium', model: 'opus' },
  { title: 'Refactor', tier: 'careful' },
  { title: 'Investigate', tier: 'heavy', model: 'sonnet' },
  { title: 'Hard one', tier: 'fable' },
]

describe('the model on a planned row', () => {
  test('the tier default without a model, the task model with one (terminal)', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    const t = await terminal($)
    expect(t).toMatch(/^ {2}light · Sonnet · low · ready$/m)
    expect(t).toMatch(/^ {2}medium · Opus · medium · ready$/m)
    expect(t).toMatch(/^ {2}careful · Opus · high · ready$/m)
    expect(t).toMatch(/^ {2}heavy · Sonnet · xhigh · ready$/m)
    expect(t).toMatch(/^ {2}fable · Fable · high · ready$/m)
  })

  test('the same on the desktop rows', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    const src = await desktop($)
    expect(metaOf(src(/^1\. Fix glyph/))).toContain('Sonnet · low')
    expect(metaOf(src(/^2\. Build it/))).toContain('Opus · medium')
    expect(metaOf(src(/^3\. Refactor/))).toContain('Opus · high')
    expect(metaOf(src(/^4\. Investigate/))).toContain('Sonnet · xhigh')
  })

  test('add takes a model; a re-plan keeps a task model; unknown values and fable are ignored', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'A', tier: 'medium', model: 'haiku' }, { title: 'B', tier: 'light', model: 'fable' }, { title: 'C', tier: 'light', model: 'gpt-9' }] })
    await progress($, { add: [{ title: 'D', tier: 'careful', model: 'Sonnet' }] })
    let t = await terminal($)
    expect(t).toMatch(/^ {2}medium · Haiku · medium · ready$/m)
    expect(t.match(/^ {2}light · Sonnet · low · ready$/gm)).toHaveLength(2)
    expect(t).toMatch(/^ {2}careful · Sonnet · high · ready$/m)
    await progress($, { tasks: [{ title: 'A', tier: 'medium' }] })
    t = await terminal($)
    expect(t).toMatch(/^ {2}medium · Haiku · medium · ready$/m)
  })

  test('the progress tool accepts sonnet, opus and haiku only', async ($, on) => {
    const { registered } = engine(on)
    await start($)
    const props = registered.find(r => r.name === 'progress').inputSchema.properties
    expect(props.tasks.items.properties.model.enum).toEqual(['sonnet', 'opus', 'haiku'])
    expect(props.add.items.properties.model.enum).toEqual(['sonnet', 'opus', 'haiku'])
    expect(props.tasks.items.required).not.toContain('model')
  })
})

describe('the model held and archived', () => {
  test('modelOf reads known models in any case and nothing else', () => {
    expect([modelOf('Opus'), modelOf(' haiku '), modelOf('fable'), modelOf(3), modelOf(undefined)]).toEqual(['opus', 'haiku', undefined, undefined, undefined])
  })

  test('a held task without a model reads as before; one with a model keeps it', () => {
    const f = asFlow({ title: 'T', tasks: [{ title: 'old', tier: 'light', after: [] }, { title: 'new', tier: 'light', after: [], model: 'opus' }, { title: 'bad', tier: 'light', model: 'fable' }] })
    expect(f!.tasks.map(t => t.model)).toEqual([undefined, 'opus', undefined])
    expect('model' in f!.tasks[0]!).toBe(false)
  })

  test('the archive keeps a task model through JSON and reads an old entry without one', () => {
    const flow = { title: 'T', total: 2, done: 2, running: 0, phase: 'close', isFinished: true, isLinked: true, tasks: [{ title: 'a', tier: 'light', after: [], model: 'opus' }, { title: 'b', tier: 'light', after: [] }] } as any
    const e = snapshot({ flow, agents: [], project: '/p', startedAt: 1000, endedAt: 61_000, status: 'finished' })
    expect(e.tasks.map(t => t.model)).toEqual(['opus', undefined])
    const back = parseArchive(JSON.parse(JSON.stringify([e])))
    expect(back[0]!.tasks.map(t => t.model)).toEqual(['opus', undefined])
    expect('model' in back[0]!.tasks[1]!).toBe(false)
  })
})
