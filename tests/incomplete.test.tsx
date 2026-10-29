import { describe, expect, test } from 'claude-code/testing'

import { agentState, isComplete, isIncomplete, isSettled, markOf, progressOf, stateText } from '../hooks/agent-state'
import { snapshot } from '../hooks/archive'
import { STATE_COLOR } from '../hooks/plan-view'
import type { AgentRun } from '../types'

const NOW = Date.UTC(2026, 9, 29, 10, 0)
const AMBER = STATE_COLOR.needs_input
const GREEN = STATE_COLOR.done
// The desktop drawing at 80 columns: W 632, the bar 568 px wide.
const BAR = 568
const TICK = 'l3.5 3.5 6.5-7'

describe('a run that ended OK with steps left is Incomplete', () => {
  test('done with every step done is Done, full and settled', () => {
    const a = { status: 'done' as const, stepDone: 6, stepTotal: 6 }
    expect(agentState(a)).toEqual({ name: 'Done', color: GREEN })
    expect(progressOf(a)).toBe(1)
    expect(markOf(a)).toBe('done')
    expect(isComplete(a) && isSettled(a) && !isIncomplete(a)).toBe(true)
  })

  test('done with 1 of 6 steps is Incomplete in amber, the bar at 1/6, not settled', () => {
    const a = { status: 'done' as const, stepDone: 1, stepTotal: 6 }
    expect(agentState(a)).toEqual({ name: 'Incomplete', color: AMBER })
    expect(stateText({ ...a, tool: 'Bash' })).toBe('Incomplete')
    expect(progressOf(a)).toBe(1 / 6)
    expect(markOf(a)).toBe('incomplete')
    expect(isComplete(a) || isSettled(a)).toBe(false)
  })

  test('done without a step list is still Done and full; no steps counted reads as 0', () => {
    expect(agentState({ status: 'done' }).name).toBe('Done')
    expect(progressOf({ status: 'done' })).toBe(1)
    expect(progressOf({ status: 'done', stepTotal: 0 })).toBe(1)
    expect(agentState({ status: 'done', stepTotal: 3 }).name).toBe('Incomplete')
  })

  test('a failed run stays Error and settled, its bar at its steps; running is unchanged', () => {
    const f = { status: 'failed' as const, stepDone: 1, stepTotal: 6 }
    expect(agentState(f).name).toBe('Error')
    expect(markOf(f)).toBe('failed')
    expect(isSettled(f)).toBe(true)
    expect(progressOf(f)).toBe(1 / 6)
    expect(agentState({ status: 'running', stepDone: 1, stepTotal: 6 }).name).toBe('Running')
    expect(isSettled({ status: 'running' })).toBe(false)
  })
})

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store: Record<string, unknown> = opts.store ?? {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
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
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { store, clock }
}

const start = ($: any, cwd = '') => $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-careful', description, tool_use_id: id } as any)
const step = ($: any, agentId: string, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__step', agentId, ...input } as any)
const complete = ($: any, agentId: string, reason = 'answer') => $.turn.complete({ reason, answer: 'ok', durationMs: 1, agentId } as any)
const SIX = ['read code', 'write tests', 'wire tool', 'fix types', 'run suite', 'commit']

const desktop = async ($: any) => {
  const p = await pane($, 'desktop')
  const svgs = await p.findAll({ type: 'Svg' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  const source = (name: string) => String(svgs.find((s: any) => String(s.props.alt).startsWith(`${name}:`))?.props.source ?? '')
  return { source, keys: buttons.map((b: any) => String(b.props.key)) }
}
const terminal = async ($: any) => {
  const p = await pane($, 'terminal')
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { texts, text: texts.map((t: any) => t.text).join('\n'), keys: buttons.map((b: any) => String(b.props.key)) }
}

// Four runs of one open flow: all steps done, 1 of 6 (the user's case), no steps, failed.
async function fourRuns($: any, clock: { now: number }) {
  await progress($, { title: 'Ship it', phase: 'delegate', tasks: [{ title: 'all six', tier: 'careful' }] })
  const runs: [string, string][] = [['w1', 'all six'], ['w2', 'one of six'], ['w3', 'no steps'], ['w4', 'broke']]
  for (const [i, [id, d]] of runs.entries()) {
    clock.now = NOW + (i + 1) * 1000
    await spawn($, id, d)
  }
  await step($, 'w1', { steps: SIX.map(title => ({ title })) })
  await step($, 'w1', { done: SIX.slice(0, 5) })
  await step($, 'w2', { steps: SIX.map(title => ({ title })) }) // the first step active; the run's end closes it: 1/6
  clock.now = NOW + 60_000
  for (const id of ['w1', 'w2', 'w3']) await complete($, id)
  await complete($, 'w4', 'error')
}

describe('Incomplete rows in the live panel', () => {
  test('desktop: Done rows keep the tick and a full green bar; the 1/6 row says Incomplete, an amber bar at 1/6, no tick', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await fourRuns($, clock)
    const d = await desktop($)
    const all = d.source('all six')
    expect(all).toContain('>Done</tspan>')
    expect(all).toContain(TICK)
    expect(all).toContain(`width="${BAR}" height="4" rx="2" fill="${GREEN}"`)
    const one = d.source('one of six')
    expect(one).toContain('>Incomplete</tspan>')
    expect(one).toContain('1/6')
    expect(one).not.toContain(TICK)
    expect(one).not.toContain(`width="${BAR}" height="4" rx="2" fill=`)
    expect(one).toContain(`width="${Math.round(BAR / 6)}" height="4" rx="2" fill="${AMBER}"`)
    expect(one).toContain(`stroke="${AMBER}"`)
    const none = d.source('no steps')
    expect(none).toContain('>Done</tspan>')
    expect(none).toContain(TICK)
    expect(none).toContain(`width="${BAR}" height="4" rx="2" fill="${GREEN}"`)
    expect(d.source('broke')).toContain('>Error</tspan>')
  })

  test('no Archive button on the Incomplete row; Done, Done without steps and Error rows keep theirs', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await fourRuns($, clock)
    for (const keys of [(await desktop($)).keys, (await terminal($)).keys]) {
      expect(keys.filter(k => k.startsWith('archive-item-'))).toEqual(['archive-item-w4', 'archive-item-w3', 'archive-item-w1'])
    }
  })

  test('terminal: the Incomplete row has the amber half ring and no tick; the Done row its green tick', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await fourRuns($, clock)
    const t = await terminal($)
    expect(t.text).toMatch(/Incomplete · 1\/6/)
    const marks = t.texts.filter((x: any) => ['✓', '◐', '✗'].includes(x.text)).map((x: any) => `${x.text} ${x.props.color}`)
    expect(marks).toEqual(['✗ red', '✓ green', '◐ ' + AMBER, '✓ green'])
  })

  test('the Finished fold still lists the Incomplete row and counts it', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await fourRuns($, clock)
    const p = await pane($, 'terminal')
    const done = await p.find({ type: 'Button', key: 'done' })
    await p.unmount()
    expect(String(done.props.label)).toBe('▾ Finished · 4')
  })

  test('archiving a newer row passes over the Incomplete one: it stays in the live list', async ($, on) => {
    const { clock } = engine(on, { store: { historyShown: false } })
    await start($, '/work/app')
    await fourRuns($, clock)
    const p = await pane($, 'terminal')
    await p.press({ key: 'archive-item-w4' })
    await settle()
    await p.unmount()
    const t = await terminal($)
    expect(t.text).toContain('one of six')
    expect(t.text).not.toMatch(/all six|no steps|broke/)
    expect(t.keys.filter(k => k.startsWith('archive-item-'))).toEqual([])
  })
})

describe('Incomplete rows in an Archive group', () => {
  test('a saved run done at 1/6 draws as Incomplete there too, and old saved data loads as it is', async ($, on) => {
    const base = { agentId: 'a1', type: 'flowdeck-careful', model: 'claude-opus-5-5', startedAt: NOW - 600_000, endedAt: NOW - 300_000, contextTokens: 0, contextMax: 1_000_000, tokens: 10, costUsd: 0.1, steps: 1, round: 1 }
    const runs: AgentRun[] = [
      { ...base, id: 'a1', description: 'half done', status: 'done', stepDone: 1, stepTotal: 6 },
      { ...base, id: 'a2', agentId: 'a2', description: 'all done', status: 'done', stepDone: 6, stepTotal: 6 },
    ]
    const flow = { title: 'Old flow', total: 2, done: 1, running: 0, phase: 'close' as const, isFinished: true, isLinked: true, tasks: [] }
    const entry = { ...snapshot({ flow, agents: runs, project: '', startedAt: NOW - 700_000, endedAt: NOW - 200_000, status: 'finished' }), id: 'g1' }
    engine(on, { store: { historyShown: true, history: [entry] } })
    await start($)
    await settle()
    const d = await desktop($)
    const half = d.source('half done')
    expect(half).toContain('>Incomplete</tspan>')
    expect(half).not.toContain(TICK)
    expect(d.source('all done')).toContain(TICK)
    const t = await terminal($)
    expect(t.text).toMatch(/Incomplete · 1\/6/)
    expect(t.texts.some((x: any) => x.text === '◐')).toBe(true)
  })
})
