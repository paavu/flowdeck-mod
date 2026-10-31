import { describe, expect, test } from 'claude-code/testing'

import type { TaskPlan } from '../hooks/plan'

// The Plans feature is gone (1.0.0035): the band above the prompt draws the flow row (and the cache chip), never a
// plan row, whatever plans an older flowdeck left in the store or in its held state.

const NOW = Date.UTC(2026, 9, 26, 12, 40)

function engine(on: any, store: Record<string, unknown> = {}) {
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  return { store }
}

// A value an older flowdeck held under `key`: the held state answers it.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return { value: { value, version: r?.value?.version ?? 0 } }
  })

const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' } as any)
const flow = ($: any) => $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'Ship it', total: 3, done: 1, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] } as any)
const band = ($: any, surface: 'desktop' | 'terminal', bodyColumns: number) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } } as any)
const drawn = async (b: any) => JSON.stringify(await b.drawn())
const svgCount = (json: string) => (json.match(/<svg /g) ?? []).length

const oldPlan = (id: string, title: string, state: TaskPlan['state']): TaskPlan => ({
  id,
  title,
  kind: 'plan',
  state,
  note: state === 'needs_input' ? 'which branch?' : null,
  startedAt: NOW - 60_000,
  stages: [{ name: 'Build', steps: [{ title: 'one', status: 'active', substeps: [] }, { title: 'two', status: 'pending', substeps: [] }] }],
})
const OPEN = [oldPlan('p1', 'Running plan', 'running'), oldPlan('p2', 'Waiting plan', 'needs_input'), oldPlan('p3', 'Failed plan', 'error')]
const PLAN_WORDS = /Running plan|Waiting plan|Failed plan|Needs input/

describe('no plan rows in the band', () => {
  test('with no flow, open plans an older flowdeck saved add nothing: only what is below shows', async ($, on) => {
    engine(on, { plans: { s: OPEN } })
    held(on, 'plans', OPEN)
    await start($)
    for (const surface of ['desktop', 'terminal'] as const) {
      const b = await band($, surface, 100)
      const json = await drawn(b)
      expect(json).toContain('band below')
      expect(json).not.toMatch(PLAN_WORDS)
      expect(svgCount(json)).toBe(0)
      await b.unmount()
    }
  })

  test('with a flow, the band draws the flow row alone, never a plan row below it', async ($, on) => {
    engine(on, { plans: { s: OPEN } })
    held(on, 'plans', OPEN)
    await start($)
    await flow($)
    const d = await band($, 'desktop', 100)
    const json = await drawn(d)
    await d.unmount()
    expect(json).toMatch(/×\d/)
    expect(svgCount(json)).toBe(2) // the flow row and the crew icon
    expect(json).not.toMatch(PLAN_WORDS)
    expect(json).not.toContain('flowdeck-plan-')
    const t = await band($, 'terminal', 80)
    const tj = await drawn(t)
    await t.unmount()
    expect(tj).toMatch(/×\d/)
    expect(tj).not.toMatch(PLAN_WORDS)
    expect(tj).not.toContain('flowdeck-plan-')
  })
})
