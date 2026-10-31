import { describe, expect, test } from 'claude-code/testing'

import { doneText } from '../hooks/time'
import { keyOf } from '../hooks/archive'
import { fileOf, indexPath, records, sessionPaths, sessions } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const DIR = '/work/app/.claude/flowdeck'
const ID = `${NOW}-/work/app`
// The live flow's own session file in `archive/` (the flow starts at NOW).
const SESSION = `${DIR}/archive/${fileOf({ id: ID, startedAt: NOW })}`
const INDEX = indexPath(DIR)

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store = opts.store ?? { historyShown: false } // these tests start with the Archive hidden, as they show it by tab
  const fail = { store: false }
  const fs = fakeFs(on)
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (fail.store) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (fail.store) throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: USAGE }
  })
  return { store, files: fs.files, clock, fail, fs }
}

const USAGE = { model: 'claude-opus-5-5', input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const plan = ($: any) =>
  progress($, { title: 'Ship it', total: 3, done: 1, phase: 'delegate', tasks: [{ title: 'task 1', tier: 'light' }, { title: 'never started', tier: 'medium' }, { title: 'task 2', tier: 'light' }] })
// The Finished tab, unless another is named.
const pane = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 80, tab: Tab = 'finished') => {
  await showTab($, tab)
  return $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
}
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-light', description, tool_use_id: id } as any)
const turnStep = async ($: any, agentId: string) => {
  const s = $.turn.step({ agentId, model: 'claude-opus-5-5', turnId: 't', index: 0, messageCount: 1 } as any)
  for await (const _ of s);
}
const complete = ($: any, agentId: string, reason = 'answer') => $.turn.complete({ reason, answer: 'ok', durationMs: 1, agentId } as any)

// `n` workers `task 1` … `task n`, started a second apart and each finished a minute later; `failed` ones end in error.
async function finishedRows($: any, clock: { now: number }, n: number, failed: number[] = [], before?: () => Promise<unknown>) {
  for (let i = 1; i <= n; i++) {
    clock.now = NOW + i * 1000
    await spawn($, `w${i}`, `task ${i}`)
    await turnStep($, `w${i}`)
  }
  await before?.()
  for (let i = 1; i <= n; i++) {
    clock.now = NOW + 60_000 + i * 1000
    await complete($, `w${i}`, failed.includes(i) ? 'error' : 'answer')
  }
  clock.now = NOW + 120_000
}

const archiveKeys = (buttons: any[]) => buttons.map((b: any) => String(b.props.key)).filter(k => k.startsWith('archive-item-'))
const ICON = '⤓'
const terminal = async ($: any, cols = 80, tab: Tab = 'finished') => {
  const p = await pane($, 'terminal', cols, tab)
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { text: texts.map((t: any) => t.text).join('\n'), texts, buttons }
}
const desktop = async ($: any, cols = 80, tab: Tab = 'finished') => {
  const p = await pane($, 'desktop', cols, tab)
  const svgs = await p.findAll({ type: 'Svg' })
  const buttons = await p.findAll({ type: 'Button' })
  const drawn = JSON.stringify(await p.drawn())
  await p.unmount()
  return { svgs, buttons, drawn, alts: svgs.map((s: any) => String(s.props.alt ?? '')) }
}
// The live rows the desktop draws, by description.
const desktopRows = (d: { alts: string[] }) => d.alts.filter(a => /^task \d+: /.test(a)).map(a => a.split(':')[0])
const press = async ($: any, key: string, surface: 'terminal' | 'desktop' = 'terminal', tab: Tab = 'finished') => {
  const p = await pane($, surface, 80, tab)
  await p.press({ key })
  await settle()
  await p.unmount()
}
const entries = (files: Record<string, string>): any[] => sessions(files, DIR)
const ids = (e: any): string[] => (e?.agents ?? []).map((a: any) => a.id).sort()


describe('Finished rows have no archive button', () => {
  test('neither on the terminal nor on the desktop, in an open flow or after it', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3, [2])
    for (const closed of [false, true]) {
      if (closed) await progress($, { finished: true })
      const t = await terminal($)
      expect(t.text).toMatch(/task 1/)
      expect(archiveKeys(t.buttons)).toEqual([])
      expect(t.buttons.some((b: any) => String(b.props.label) === ICON)).toBe(false)
      const d = await desktop($)
      expect(desktopRows(d).length).toBeGreaterThan(0)
      expect(archiveKeys(d.buttons)).toEqual([])
      expect(d.buttons.some((b: any) => String(b.props.label) === ICON)).toBe(false)
    }
  })
})

describe('the automatic archive', () => {
  test('closing the flow saves one full entry with every row, and the Archive tab keeps its move-to-Trash controls', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    clock.now = NOW + 300_000
    await progress($, { finished: true })
    const list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('finished')
    expect('partial' in list[0]).toBe(false)
    expect(ids(list[0])).toEqual(['w1', 'w2', 'w3'])
    expect(records(files, INDEX)!.map(r => [r.id, r.status, 'partial' in r])).toEqual([[ID, 'finished', false]])

    const key = keyOf(ID)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface, 80, 'archive')
      expect(await p.find({ type: 'Button', key: `archive-del-${key}` })).toBeDefined()
      await p.unmount()
    }
    await press($, `archive-del-${key}`, 'terminal', 'archive')
    expect((await terminal($, 80, 'archive')).buttons.some((b: any) => String(b.props.key) === `archive-trash-${key}`)).toBe(true)
    await press($, `archive-trash-${key}`, 'terminal', 'archive')
    expect(Object.keys(files).some(f => f.includes('/.trash/') && f.includes(key))).toBe(true)
  })
})
