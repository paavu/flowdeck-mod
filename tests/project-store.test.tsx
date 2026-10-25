import { describe, expect, test } from 'claude-code/testing'

import { fakeFs } from './fake-fs'
import type { Fail } from './fake-fs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HOUR = 3_600_000
const DIR = '/work/app/.claude/flowdeck'
const HISTORY = `${DIR}/history.json`
const PLANS = `${DIR}/plans.json`
const IGNORE = `${DIR}/.gitignore`

type Opts = {
  store?: Record<string, unknown>
  files?: Record<string, string>
  tooBig?: string[]
  fail?: Fail & { store?: boolean; clock?: boolean }
  sessionId?: string
}

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const fail = opts.fail ?? {}
  // fail.fs and fail.write are the fake fs's own switches
  const fs = fakeFs(on, { files: opts.files, tooBig: opts.tooBig, fail })
  const { files, writes } = fs
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => {
    if (fail.clock) throw new Error('clock down')
    return { value: clock.now }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: opts.sessionId ?? 's', cwd: e.cwd }))
  on('session.id', () => ({ value: opts.sessionId ?? 's' }))
  on('session.end', () => ({ sessionId: opts.sessionId ?? 's' }))
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
  return { store, files, writes, clock, fail, fs }
}

const start = ($: any, cwd = '/work/app') => $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const flow = async ($: any, title = 'Ship it') => {
  await progress($, { title, total: 2, done: 1, phase: 'delegate', tasks: [{ title: 'write tests', tier: 'careful' }, { title: 'wire it', tier: 'medium' }] })
  return progress($, { finished: true })
}
const planTool = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__plan', ...input } as any)).result)
const STAGES = [{ name: 'Build', steps: [{ title: 'write tests' }, { title: 'wire tool' }] }]
const pane = ($: any) => $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const archiveButtons = async ($: any): Promise<string[]> => {
  const p = await pane($)
  const all = await p.findAll({ type: 'Button' })
  await p.unmount()
  return all.map((b: any) => JSON.stringify(b)).filter((s: string) => /Flow |Ship it|Alpha|Beta|Mine|Other/.test(s))
}
const titles = (text: string | undefined): string[] => (JSON.parse(text ?? '[]') as any[]).map(e => e.title)
const WARNING = 'history.json could not be read; showing recovered entries (the file is untouched)'

const entry = (i: number, project = '/work/app', title = `Flow ${i}`) => ({
  id: `e${i}`,
  project,
  title,
  startedAt: NOW - 2 * HOUR - i,
  endedAt: NOW - HOUR - i,
  status: 'finished',
  done: 1,
  total: 2,
  tasks: [{ title: 'write tests', tier: 'careful' }],
  cost: 1.5,
  tokens: 12_000,
  time: 30 * 60_000,
})

describe('the archive in the project folder', () => {
  test('finishing a flow writes the entry to the project file and a self-ignoring .gitignore once', async ($, on) => {
    const { store, files, writes, clock } = engine(on)
    await start($)
    await flow($)
    expect(titles(files[HISTORY])).toEqual(['Ship it'])
    expect(JSON.parse(files[HISTORY])[0].project).toBe('/work/app')
    expect(files[IGNORE]).toBe('*\n')
    clock.now = NOW + 60_000
    await flow($, 'Second')
    expect(titles(files[HISTORY])).toEqual(['Second', 'Ship it'])
    expect(writes.filter(w => w === IGNORE)).toHaveLength(1)
    expect(writes.every(w => w.startsWith(`${DIR}/`))).toBe(true)
    expect('/work/app/.gitignore' in files).toBe(false)
    expect(store.history).toBeUndefined()
  })

  test('an existing .gitignore is left as it is', async ($, on) => {
    const { files, writes } = engine(on, { files: { [IGNORE]: 'custom\n' } })
    await start($)
    await flow($)
    expect(files[IGNORE]).toBe('custom\n')
    expect(writes).not.toContain(IGNORE)
    expect(writes).toContain(HISTORY)
  })

  test('two projects keep separate files and separate panel lists', async ($, on) => {
    const { files, clock } = engine(on, { store: { historyShown: true } })
    await start($, '/a')
    await flow($, 'Alpha')
    clock.now = NOW + 60_000
    await start($, '/b')
    await settle()
    expect(await archiveButtons($)).toEqual([])
    await flow($, 'Beta')
    expect(titles(files['/a/.claude/flowdeck/history.json'])).toEqual(['Alpha'])
    expect(titles(files['/b/.claude/flowdeck/history.json'])).toEqual(['Beta'])
    const b = await archiveButtons($)
    expect(b).toHaveLength(1)
    expect(b[0]).toContain('Beta')
    await start($, '/a')
    await settle()
    const a = await archiveButtons($)
    expect(a).toHaveLength(1)
    expect(a[0]).toContain('Alpha')
  })

  test('a restart reads the file and the panel shows it', async ($, on) => {
    engine(on, { store: { historyShown: true }, files: { [HISTORY]: JSON.stringify([entry(2), entry(1)]) } })
    await start($)
    await settle()
    const list = await archiveButtons($)
    expect(list).toHaveLength(2)
    expect(list[0]).toContain('Flow 2')
  })

  test('a file of 60 entries keeps them all on the next save', async ($, on) => {
    const many = Array.from({ length: 60 }, (_, i) => entry(i + 1))
    const { files } = engine(on, { files: { [HISTORY]: JSON.stringify(many) } })
    await start($)
    await flow($)
    const saved = titles(files[HISTORY])
    expect(saved).toHaveLength(61)
    expect(saved[0]).toBe('Ship it')
    expect(saved[60]).toBe('Flow 60')
  })

  test('a corrupt file is kept as it is and the panel says so; this project’s store entries still show, and the next flow goes to a side file and the store', async ($, on) => {
    const { files, store } = engine(on, { store: { historyShown: true, history: [entry(9, '/work/app', 'Mine'), entry(8, '/old/site', 'Other')] }, files: { [HISTORY]: 'nope' } })
    await start($)
    await settle()
    let p = await pane($)
    expect(await p.find({ type: 'Text', text: WARNING })).toBeDefined()
    await p.unmount()
    const shown = await archiveButtons($)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain('Mine')
    await flow($)
    expect(files[HISTORY]).toBe('nope')
    expect(titles(files[`${DIR}/history-extra-${NOW}.json`])).toEqual(['Ship it'])
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it', 'Mine', 'Other'])
    p = await pane($)
    expect(await p.find({ type: 'Text', text: WARNING })).toBeDefined()
    await p.unmount()
    expect((await archiveButtons($)).map(b => (b.includes('Ship it') ? 'Ship it' : 'Mine'))).toEqual(['Ship it', 'Mine'])
  })

  test('a file that is there but cannot be read (oversized) is never overwritten', async ($, on) => {
    const big = JSON.stringify([entry(1)])
    const { files } = engine(on, { store: { historyShown: true }, files: { [HISTORY]: big }, tooBig: [HISTORY, PLANS] })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: WARNING })).toBeDefined()
    await p.unmount()
    expect(String((await flow($)).result)).toContain('ok')
    expect(files[HISTORY]).toBe(big)
    expect(titles(files[`${DIR}/history-extra-${NOW}.json`])).toEqual(['Ship it'])
  })

  test('a missing file imports only this project’s entries from the old store, which stays untouched', async ($, on) => {
    const old = [entry(1, '/work/app', 'Mine'), entry(2, '/old/site', 'Other'), entry(3, '/work/app', 'Mine too')]
    const before = JSON.stringify(old)
    const { files, store, clock } = engine(on, { store: { historyShown: true, history: old } })
    await start($)
    await settle()
    const shown = await archiveButtons($)
    expect(shown).toHaveLength(2)
    expect(shown.some(s => s.includes('Other'))).toBe(false)
    await flow($)
    expect(titles(files[HISTORY])).toEqual(['Ship it', 'Mine', 'Mine too'])
    clock.now = NOW + 60_000
    await flow($, 'Second')
    expect(titles(files[HISTORY])).toEqual(['Second', 'Ship it', 'Mine', 'Mine too'])
    expect(JSON.stringify(store.history)).toBe(before)
  })

  test('store entries of this project that the file lacks are merged back into it; the store is left as it is', async ($, on) => {
    const old = [entry(1, '/work/app', 'Mine'), entry(2, '/old/site', 'Other')]
    const before = JSON.stringify(old)
    const { files, store, clock } = engine(on, { store: { history: old }, files: { [HISTORY]: '[]' } })
    await start($)
    await flow($)
    expect(titles(files[HISTORY])).toEqual(['Ship it', 'Mine'])
    clock.now = NOW + 60_000
    await flow($, 'Again')
    expect(titles(files[HISTORY])).toEqual(['Again', 'Ship it', 'Mine'])
    expect(JSON.stringify(store.history)).toBe(before)
  })

  test('a failing write falls back to the shared store without throwing', async ($, on) => {
    const { store, files } = engine(on, { store: { historyShown: true }, fail: { write: true } })
    await start($)
    expect(String((await flow($)).result)).toContain('ok')
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    expect(HISTORY in files).toBe(false)
    const shown = await archiveButtons($)
    expect(shown).toHaveLength(1)
    expect(await planTool($, { id: 'work', title: 'x', stages: STAGES })).toBe('work: 0/2, running, active "write tests"')
    expect((store.plans as any).s).toHaveLength(1)
  })

  test('an empty working folder uses the shared store', async ($, on) => {
    const { store, writes } = engine(on)
    await start($, '')
    await flow($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    expect((store.plans as any).s).toHaveLength(1)
    expect(writes).toEqual([])
  })
  test('a flow that went to the store because the write failed comes back into the file with the next save; the store keeps it', async ($, on) => {
    const { files, store, fail, clock } = engine(on, { store: { historyShown: true } })
    fail.write = true
    await start($)
    await flow($)
    expect(HISTORY in files).toBe(false)
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    const kept = JSON.stringify(store.history)
    fail.write = false
    clock.now = NOW + 60_000
    await start($)
    await settle()
    expect(await archiveButtons($)).toHaveLength(1)
    await flow($, 'Second')
    expect(titles(files[HISTORY])).toEqual(['Second', 'Ship it'])
    expect(JSON.stringify(store.history)).toBe(kept)
    await start($)
    await settle()
    const p = await pane($)
    const groups = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key)).filter((k: string) => /^archive-\d+-\/work\/app$/.test(k))
    await p.unmount()
    expect(groups).toEqual([`archive-${NOW + 60_000}-/work/app`, `archive-${NOW}-/work/app`])
  })
})

describe('plans in the project folder', () => {
  test('plans save to plans.json under the session id and come back on restart', async ($, on) => {
    const { files, store } = engine(on, { sessionId: 'abc' })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    await planTool($, { id: 'work', next: true })
    const saved = JSON.parse(files[PLANS])
    expect(Object.keys(saved)).toEqual(['abc'])
    expect(saved.abc[0].id).toBe('work')
    expect(files[IGNORE]).toBe('*\n')
    expect(store.plans).toBeUndefined()
    await start($)
    expect(await planTool($, { id: 'work', next: true })).toBe('work: 2/2, done')
  })

  test('plans are not imported from the old store, but a missing file still loads them from it', async ($, on) => {
    const mine = { id: 'mine', title: 't', kind: 'plan', stages: [{ name: 'S', steps: [{ title: 'a', status: 'active', substeps: [] }] }], state: 'running', note: null, startedAt: 1 }
    const { files, store } = engine(on, { store: { plans: { s: [mine], other: [mine] } } })
    await start($)
    expect(await planTool($, { id: 'mine', next: true })).toBe('mine: 1/1, done')
    expect(Object.keys(JSON.parse(files[PLANS]))).toEqual(['s'])
    expect(Object.keys(store.plans as object)).toEqual(['s', 'other'])
  })

  test('25 sessions in the file are all kept: none is dropped for age, and each stays exactly as it was', async ($, on) => {
    const plans: Record<string, unknown> = {}
    for (let i = 0; i < 25; i++) plans[`old${i}`] = [{ id: 'p', title: 't', kind: 'plan', stages: [], state: 'done', note: null, startedAt: i }]
    plans.odd = 'not a list' // kept too: it is not this session's
    const { files } = engine(on, { files: { [PLANS]: JSON.stringify(plans) } })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    const saved = JSON.parse(files[PLANS])
    expect(Object.keys(saved)).toHaveLength(27)
    expect(saved.s).toHaveLength(1)
    delete saved.s
    expect(saved).toEqual(plans)
  })

  test('a corrupt plans.json is never overwritten: this session’s plans go to its side file and come back from it on restart', async ($, on) => {
    const { files } = engine(on, { files: { [PLANS]: 'nope' } })
    await start($)
    expect(await planTool($, { id: 'work', title: 'x', stages: STAGES })).toBe('work: 0/2, running, active "write tests"')
    await planTool($, { id: 'work', next: true })
    expect(files[PLANS]).toBe('nope')
    expect(JSON.parse(files[`${DIR}/plans-extra-s.json`])[0].id).toBe('work')
    await start($)
    expect(await planTool($, { id: 'work', next: true })).toBe('work: 2/2, done')
    expect(files[PLANS]).toBe('nope')
  })

  test('a plans.json that is there but cannot be read is never written; once a session has its side file, only that is written', async ($, on) => {
    const { files, fs } = engine(on, { files: { [PLANS]: '{}' }, tooBig: [PLANS] })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    expect(files[PLANS]).toBe('{}')
    fs.tooBig.clear()
    await planTool($, { id: 'work', next: true })
    expect(files[PLANS]).toBe('{}')
    expect(JSON.parse(files[`${DIR}/plans-extra-s.json`])[0].stages[0].steps.map((st: any) => st.status)).toEqual(['done', 'active'])
  })

  test('when stat, the listing and `exists` all fail, neither plans.json nor a side file is written: the store keeps the plans', async ($, on) => {
    const { files, fs, store } = engine(on, { files: { [PLANS]: '{"other":[]}' }, sessionId: 'abc' })
    fs.unreadable.add(PLANS)
    Object.assign(fs.fail, { stat: true, list: true, exists: true })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    expect(files[PLANS]).toBe('{"other":[]}')
    expect(Object.keys(files)).toEqual([PLANS])
    expect((store.plans as any).abc).toHaveLength(1)
  })

  test('a plans.json that would pass the byte limit is left as it is and the plans go to the side file', async ($, on) => {
    // 1,300,000 Cyrillic characters: 2,600,000 bytes, over the 2,500,000-byte limit though not in characters
    const plans = { old: [{ id: 'p', title: 't', kind: 'plan', stages: [], state: 'done', note: 'Ж'.repeat(1_300_000), startedAt: 1 }] }
    const text = JSON.stringify(plans)
    const { files, fs } = engine(on, { files: { [PLANS]: text } })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    expect(files[PLANS]).toBe(text)
    expect(JSON.parse(files[`${DIR}/plans-extra-s.json`])[0].id).toBe('work')
    expect(Math.max(...fs.tried.map(t => t.bytes))).toBeLessThan(2_500_000)
  })

  test('a side file of this session that does not parse is never written over either: the store keeps the plans', async ($, on) => {
    const side = `${DIR}/plans-extra-s.json`
    const { files, store } = engine(on, { files: { [PLANS]: 'nope', [side]: 'broken' } })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    expect(files[side]).toBe('broken')
    expect(files[PLANS]).toBe('nope')
    expect((store.plans as any).s).toHaveLength(1)
  })

  test('a session id that is no plain file name gets its own safe side file name', async ($, on) => {
    const { files } = engine(on, { files: { [PLANS]: 'nope' }, sessionId: 'a/b_c' })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    expect(Object.keys(files).filter(f => f.includes('plans-extra-'))).toEqual([`${DIR}/plans-extra-a_002fb_005fc.json`])
  })

  test('a corrupt plans file reads as empty', async ($, on) => {
    engine(on, { files: { [PLANS]: 'nope' } })
    await start($)
    expect(await planTool($, { id: 'work', next: true })).toMatch(/^flowdeck plan: no plan "work" yet/)
    expect(await planTool($, { id: 'work', title: 'x', stages: STAGES })).toBe('work: 0/2, running, active "write tests"')
  })
})

describe('everything failing', () => {
  test('the tool calls and the turn never throw when fs, clock and store all fail', async ($, on) => {
    const { fail } = engine(on, { fail: { fs: true, store: true } })
    await start($)
    expect(String((await progress($, { title: 'T', total: 1, done: 0, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })).result)).toContain('ok')
    expect(await planTool($, { id: 'work', title: 'x', stages: [{ name: 'S', steps: [{ title: 'a' }] }] })).toContain('work')
    expect(await planTool($, { id: 'work', done: ['a'], state: 'running' })).toContain('work')
    // From here the clock fails too, where saving reads it: recording the flow and closing the plan.
    fail.clock = true
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(String((await progress($, { finished: true })).result)).toContain('ok')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  })
})
