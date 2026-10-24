import { describe, expect, test } from 'claude-code/testing'

import type { PlanState, StepStatus, TaskPlan } from '../hooks/plan'
import { planBandSvg, planBandText, STATE_COLOR } from '../hooks/plan-view'

const NOW = Date.UTC(2026, 9, 26, 12, 40)

function engine(on: any, store: Record<string, unknown> = {}) {
  const opened: unknown[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$: any, e: any) => (opened.push(e), { value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { opened, store }
}

const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const flow = ($: any) => $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', total: 3, done: 1, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] } as any)
const plan = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__plan', ...input } as any)
const STAGES = [{ name: 'Build', steps: [{ title: 'one' }, { title: 'two' }, { title: 'three' }] }]
const create = ($: any, id: string, title: string) => plan($, { id, title, stages: STAGES })
const pane = ($: any) =>
  $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 60 } } as any)
const band = ($: any, surface: 'desktop' | 'terminal', bodyColumns: number) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } } as any)
const drawn = async (b: any) => JSON.stringify(await b.drawn())
const svgCount = (json: string) => (json.match(/<svg /g) ?? []).length

function taskPlan(state: PlanState, done: number, extra: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: 'p',
    title: 'Ship the band rows',
    kind: 'plan',
    state,
    note: null,
    startedAt: NOW - 60_000,
    stages: [
      {
        name: 'Build',
        steps: Array.from({ length: 4 }, (_, j) => {
          const status: StepStatus = state === 'done' || j < done ? 'done' : j === done ? 'active' : 'pending'
          return { title: `Step ${j + 1}`, status, substeps: [] }
        }),
      },
    ],
    ...extra,
  }
}

describe('plans in the band above the prompt', () => {
  test('a running plan shows a row with its title and state above the rest', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    for (const surface of ['desktop', 'terminal'] as const) {
      const b = await band($, surface, 100)
      const json = await drawn(b)
      expect(json).toContain('Alpha rollout')
      expect(json).toContain('Running')
      expect(json.indexOf('band below')).toBeGreaterThan(json.indexOf('Alpha rollout'))
      expect(json).not.toMatch(/×\d/) // no flow: no crew count
      expect(await b.find({ type: 'Button' })).toBeUndefined() // a plan row has no buttons
      await b.unmount()
    }
  })

  test('a done plan shows no row', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    await plan($, { id: 'alpha', done: ['one', 'two', 'three'] })
    const b = await band($, 'desktop', 100)
    const json = await drawn(b)
    expect(json).not.toContain('Alpha rollout')
    expect(json).toContain('band below')
    await b.unmount()
  })

  test('with a flow and a plan both rows show and the crew button still works', async ($, on) => {
    const { opened } = engine(on)
    await start($)
    await flow($)
    await create($, 'alpha', 'Alpha rollout')
    const b = await band($, 'desktop', 100)
    const json = await drawn(b)
    expect(json).toMatch(/×\d/)
    expect(svgCount(json)).toBe(2)
    const flowAt = json.indexOf('Ship it')
    const planAt = json.indexOf('Alpha rollout')
    expect(flowAt).toBeGreaterThanOrEqual(0)
    expect(planAt).toBeGreaterThan(flowAt) // the plan sits below the flow row
    expect(json.indexOf('band below')).toBeGreaterThan(planAt)
    const before = opened.length
    await b.press({ key: 'flowdeck-agents' })
    await settle()
    expect(opened.length).toBe(before + 1)
    await b.unmount()
    const t = await band($, 'terminal', 80)
    const tj = await drawn(t)
    expect(tj).toMatch(/×\d/)
    expect(tj.indexOf('Alpha rollout')).toBeGreaterThan(tj.indexOf('Ship it'))
    await t.unmount()
  })

  test('three running plans show only the two newest', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'p1', 'First plan')
    await create($, 'p2', 'Second plan')
    await create($, 'p3', 'Third plan')
    const b = await band($, 'desktop', 100)
    const json = await drawn(b)
    expect(svgCount(json)).toBe(2)
    expect(json).not.toContain('First plan')
    expect(json.indexOf('Third plan')).toBeLessThan(json.indexOf('Second plan')) // newest first
    await b.unmount()
  })

  test('a needs_input plan reads Needs input and an error plan Error', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'ask', 'Ask plan')
    await plan($, { id: 'ask', state: 'needs_input', note: 'which branch?' })
    await create($, 'bad', 'Bad plan')
    await plan($, { id: 'bad', failed: 'one' })
    for (const surface of ['desktop', 'terminal'] as const) {
      const b = await band($, surface, 100)
      const json = await drawn(b)
      expect(json).toContain('Needs input')
      expect(json).toContain('Error')
      await b.unmount()
    }
  })

  test('the dismiss button hides the plan rows too', async ($, on) => {
    engine(on)
    await start($)
    await flow($)
    await create($, 'alpha', 'Alpha rollout')
    const b0 = await band($, 'desktop', 100)
    await b0.press({ key: 'flowdeck-dismiss' })
    await settle()
    await b0.unmount()
    const b = await band($, 'desktop', 100)
    const json = await drawn(b)
    expect(json).not.toContain('Alpha rollout')
    expect(json).not.toMatch(/×\d/)
    expect(json).toContain('band below')
    await b.unmount()
  })

  test('the Band toggle hides and brings back plan rows without a flow', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    const shown = async () => {
      const b = await band($, 'terminal', 80)
      const yes = (await drawn(b)).includes('Alpha rollout')
      await b.unmount()
      return yes
    }
    expect(await shown()).toBe(true)
    const toggle = async () => {
      const p = await pane($)
      await p.press({ key: 'band' })
      await settle()
      await p.unmount()
    }
    await toggle()
    expect(await shown()).toBe(false)
    await toggle()
    expect(await shown()).toBe(true)
  })

  test('the desktop plan row has the flow row width rule, with or without a flow', async ($, on) => {
    engine(on)
    await start($)
    await create($, 'alpha', 'Alpha rollout')
    for (const columns of [20, 60, 100, 200, 400]) {
      const slot = Math.max(180, Math.min(1600, columns * 9 - 180))
      const b = await band($, 'desktop', columns)
      const json = await drawn(b)
      const widths = [...json.matchAll(/<svg [^>]*?width=\\"(\d+)\\"/g)].map(m => Number(m[1]))
      expect(widths.length).toBe(1)
      expect(widths[0]).toBe(slot)
      expect(json).not.toContain('"paddingRight"')
      await b.unmount()
    }
    await flow($)
    const b = await band($, 'desktop', 100)
    const widths = [...(await drawn(b)).matchAll(/<svg [^>]*?width=\\"(\d+)\\"/g)].map(m => Number(m[1]))
    expect(widths).toEqual([720, 720])
    await b.unmount()
  })

  test('with no flow and no open plan nothing is added', async ($, on) => {
    engine(on)
    await start($)
    const b = await band($, 'desktop', 100)
    const json = await drawn(b)
    expect(svgCount(json)).toBe(0)
    expect(json).toContain('band below')
    await b.unmount()
  })
})

describe('planBandSvg', () => {
  test('a 22 px one-line body with the title, the state colour, name and percent', () => {
    for (const state of ['running', 'needs_input', 'error', 'done'] as const) {
      const d = planBandSvg(600, taskPlan(state, 2), NOW)
      expect(d.height).toBe(22)
      expect(d.body).toContain(STATE_COLOR[state])
      expect(d.body).toContain('Ship the band rows')
      expect(d.body).toContain('class="k"')
      expect(d.body).toContain('class="t"')
      expect(d.body).not.toMatch(/\bid=|clip-path|clipPath/)
    }
    expect(planBandSvg(600, taskPlan('running', 2), NOW).body).toContain('Running')
    expect(planBandSvg(600, taskPlan('running', 2), NOW).body).toContain('50%')
    expect(planBandSvg(600, taskPlan('needs_input', 2), NOW).body).toContain('Needs input')
  })

  test('NaN-free and inside its width from 180 to 1600 px', () => {
    for (const W of [180, 240, 300, 480, 790, 1200, 1600]) {
      for (const p of [taskPlan('running', 0), taskPlan('needs_input', 3), taskPlan('running', 1, { title: 'x'.repeat(300) }), taskPlan('running', 0, { stages: [] })]) {
        const { body } = planBandSvg(W, p, NOW)
        expect(body).not.toMatch(/NaN|Infinity|undefined/)
        for (const m of body.matchAll(/\s(?:x|width|cx)="([^"]*)"/g)) {
          const v = Number(m[1])
          expect(v >= 0 && v <= W).toBe(true)
        }
        for (const m of body.matchAll(/<rect[^>]*\sx="([^"]*)"[^>]*\swidth="([^"]*)"/g)) expect(Number(m[1]) + Number(m[2])).toBeLessThanOrEqual(W)
      }
    }
  })

  test('the fill grows with the percent and the title is escaped', () => {
    const fill = (done: number) => Number(/data-fill="[^"]*"[^>]*width="([^"]*)"/.exec(planBandSvg(800, taskPlan('running', done), NOW).body)?.[1])
    expect(fill(0)).toBe(0)
    expect(fill(2)).toBeGreaterThan(fill(1))
    expect(planBandSvg(800, taskPlan('running', 1, { title: 'a <b> & "c"' }), NOW).body).toContain('a &lt;b&gt; &amp; &quot;c&quot;')
  })

  test('deterministic', () => {
    expect(planBandSvg(700, taskPlan('running', 2), NOW)).toEqual(planBandSvg(700, taskPlan('running', 2), NOW))
    expect(planBandText(taskPlan('running', 2), 60)).toBe(planBandText(taskPlan('running', 2), 60))
  })
})

describe('planBandText', () => {
  test('one row of title, bar, state and percent that fits the columns', () => {
    for (const cols of [24, 40, 80]) {
      const line = planBandText(taskPlan('running', 2), cols)
      expect(line.length).toBeLessThanOrEqual(cols)
      expect(line).toMatch(/Running 50%$/)
      expect(line).toMatch(/[█░]/)
      expect(line).not.toContain('\n')
    }
    expect(planBandText(taskPlan('running', 2), 80).startsWith('Ship the band rows ')).toBe(true)
    expect(planBandText(taskPlan('needs_input', 2), 40)).toMatch(/Needs input 50%$/)
    for (const cols of [0, 5, 12, 200]) expect(planBandText(taskPlan('needs_input', 1, { title: 'y'.repeat(300) }), cols).length).toBeLessThanOrEqual(cols)
  })
})
