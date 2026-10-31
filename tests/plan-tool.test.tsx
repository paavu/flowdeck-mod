import { describe, expect, test } from 'claude-code/testing'

// The Plans feature is gone (1.0.0035): flowdeck registers its progress and step tools, never a plan tool.
function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store = opts.store ?? {}
  const tools: string[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 26, 12, 40) }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', (_$: any, e: any) => {
    tools.push(String(e.name))
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
  return { store, tools }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)

describe('no plan tool', () => {
  test('the progress and step tools are registered, the plan tool is not', async ($, on) => {
    const { tools } = engine(on)
    await start($)
    expect(tools).toContain('progress')
    expect(tools).toContain('step')
    expect(tools).not.toContain('plan')
  })

  test('the plans an older flowdeck kept in the store are neither read into the panel nor rewritten', async ($, on) => {
    const old = { s: [{ id: 'work', title: 'Old plan', kind: 'plan', stages: [{ name: 'S', steps: [{ title: 'a', status: 'active', substeps: [] }] }], state: 'running', note: null, startedAt: 1 }] }
    const before = JSON.stringify(old)
    const { store } = engine(on, { store: { plans: old } })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
      expect(JSON.stringify(await p.drawn())).not.toContain('Old plan')
      await p.unmount()
    }
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(JSON.stringify(store.plans)).toBe(before)
  })
})
