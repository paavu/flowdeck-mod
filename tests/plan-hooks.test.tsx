import { describe, expect, test } from 'claude-code/testing'

// The Plans feature is gone (1.0.0035): an approved plan-mode plan, a question to the user and the user's answer pass
// through flowdeck unchanged and never make or move a plan.

const NOW = Date.UTC(2026, 9, 26, 12, 40)

type Tool = (e: any) => unknown

function engine(on: any, opts: { store?: Record<string, unknown>; tool?: Tool } = {}) {
  const store = opts.store ?? {}
  const prompts: any[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('tool.call', (_$: any, e: any) => (opts.tool ? opts.tool(e) : { result: 'ok' }))
  on('prompt.submit', (_$: any, e: any) => {
    prompts.push(e)
    return { text: e.text }
  })
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, prompts }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const MD = ['# Hook work', '', '## Build', '- [x] read code', '- write tests', '', '## Ship', '1. commit'].join('\n')
const waiting = { s: [{ id: 'work', title: 'Old plan', kind: 'plan', stages: [{ name: 'S', steps: [{ title: 'a', status: 'active', substeps: [] }] }], state: 'needs_input', note: 'which?', startedAt: 1 }] }

describe('plan mode and input hooks make no plans', () => {
  test('an approved plan-mode plan comes back as the engine gave it; no plan is stored', async ($, on) => {
    const { store } = engine(on, { tool: () => ({ result: { plan: MD, isAgent: false } }) })
    await start($)
    const ran: any = await $.tool.call({ tool: 'ExitPlanMode', plan: MD } as any)
    expect(ran.result).toEqual({ plan: MD, isAgent: false })
    expect(store.plans).toBeUndefined()
  })

  test('a question and the user\'s answer leave the plans an older flowdeck stored exactly as they were', async ($, on) => {
    const before = JSON.stringify(waiting)
    const { store, prompts } = engine(on, { store: { plans: waiting } })
    await start($)
    const ran: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ header: 'Branch', question: 'Which branch?' }] } as any)
    expect(ran.result).toBe('ok')
    await $.prompt.submit({ text: 'yes', wait: false, origin: { kind: 'composer' } } as any)
    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(store.plans)).toBe(before)
  })
})
