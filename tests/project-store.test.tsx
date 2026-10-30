import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { fileOf, indexPath, markerPath, records, seed, sessionPaths, sessions, titles } from './archive-files'
import { fakeFs } from './fake-fs'
import type { Fail } from './fake-fs'
import { showTab } from './tabs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const HOUR = 3_600_000
const DIR = '/work/app/.claude/flowdeck'
const INDEX = indexPath(DIR)
const PLANS = `${DIR}/plans.json`
const IGNORE = `${DIR}/.gitignore`
// A session's own file in `archive/`.
const sessionFile = (e: { id: string; startedAt: number }, dir = DIR) => `${dir}/archive/${fileOf(e)}`
// The flow that `flow` finishes at that clock: its id is its start and the project.
const flowAt = (at: number, project = '/work/app') => ({ id: `${at}-${project}`, startedAt: at })
// Files as a save leaves them: each session in its file, the index listing them.
const seeded = (list: any[]): Record<string, string> => {
  const files: Record<string, string> = {}
  seed(files, DIR, list)
  return files
}

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
// The Archive tab.
const pane = async ($: any) => {
  await showTab($, 'archive')
  return $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
}
const archiveButtons = async ($: any): Promise<string[]> => {
  const p = await pane($)
  const all = await p.findAll({ type: 'Button' })
  await p.unmount()
  // the groups' fold keys: `archive-<keyOf(entry id)>`
  return all.map((b: any) => String(b.props.key)).filter((k: string) => /^archive-k[a-z0-9]+$/.test(k))
}
const DAMAGED = 'archive-index.json was damaged and is rebuilt from archive/; the damaged one is kept in .trash/damaged/'
const UNREADABLE = 'archive-index.json could not be read; showing the sessions found in archive/ (the index is untouched)'

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
  test('finishing a flow writes its session file, then the index, and a self-ignoring .gitignore once', async ($, on) => {
    const { store, files, writes, clock } = engine(on)
    await start($)
    await flow($)
    expect(titles(sessions(files, DIR))).toEqual(['Ship it'])
    expect(sessions(files, DIR)[0].project).toBe('/work/app')
    expect(sessionPaths(files, DIR)).toEqual([sessionFile(flowAt(NOW))])
    expect(titles(records(files, INDEX))).toEqual(['Ship it'])
    // the session's own file first, the index after it (flow-live.json, the shown flow's record, is written as it changes)
    expect(writes.filter(w => !w.endsWith('/flow-live.json'))).toEqual([IGNORE, sessionFile(flowAt(NOW)), INDEX])
    expect(writes).toContain(`${DIR}/flow-live.json`)
    expect(files[IGNORE]).toBe('*\n')
    clock.now = NOW + 60_000
    await flow($, 'Second')
    expect(titles(sessions(files, DIR))).toEqual(['Second', 'Ship it'])
    expect(titles(records(files, INDEX))).toEqual(['Second', 'Ship it'])
    expect(writes.filter(w => w === IGNORE)).toHaveLength(1)
    expect(writes.every(w => w.startsWith(`${DIR}/`))).toBe(true)
    expect('/work/app/.gitignore' in files).toBe(false)
    // no old archive files: nothing to import, no marker
    expect(markerPath(DIR) in files).toBe(false)
    expect(store.history).toBeUndefined()
  })

  test('an existing .gitignore is left as it is', async ($, on) => {
    const { files, writes } = engine(on, { files: { [IGNORE]: 'custom\n' } })
    await start($)
    await flow($)
    expect(files[IGNORE]).toBe('custom\n')
    expect(writes).not.toContain(IGNORE)
    expect(writes.filter(w => !w.endsWith('/flow-live.json'))).toEqual([sessionFile(flowAt(NOW)), INDEX])
  })

  test('two projects keep separate files and separate panel lists', async ($, on) => {
    const A = '/a/.claude/flowdeck'
    const B = '/b/.claude/flowdeck'
    const { files, clock } = engine(on, { store: { historyShown: true } })
    await start($, '/a')
    await flow($, 'Alpha')
    clock.now = NOW + 60_000
    await start($, '/b')
    await settle()
    expect(await archiveButtons($)).toEqual([])
    await flow($, 'Beta')
    expect(titles(sessions(files, A))).toEqual(['Alpha'])
    expect(titles(sessions(files, B))).toEqual(['Beta'])
    expect(titles(records(files, indexPath(A)))).toEqual(['Alpha'])
    expect(titles(records(files, indexPath(B)))).toEqual(['Beta'])
    expect(sessionPaths(files, B)).toEqual([sessionFile(flowAt(NOW + 60_000, '/b'), B)])
    expect(await archiveButtons($)).toEqual([`archive-${keyOf(sessions(files, B)[0].id)}`])
    await start($, '/a')
    await settle()
    expect(await archiveButtons($)).toEqual([`archive-${keyOf(sessions(files, A)[0].id)}`])
  })

  test('a restart reads the index, shows its sessions latest end first and reads only the open group’s file; it writes nothing', async ($, on) => {
    const { writes, fs } = engine(on, { store: { historyShown: true }, files: seeded([entry(2), entry(1)]) })
    await start($)
    await settle()
    expect(await archiveButtons($)).toEqual([`archive-${keyOf('e1')}`, `archive-${keyOf('e2')}`])
    expect(fs.reads).toContain(sessionFile(entry(1)))
    expect(fs.reads).not.toContain(sessionFile(entry(2)))
    expect(writes).toEqual([])
  })

  test('an index of 60 sessions keeps them all on the next save, which writes only the new session’s file', async ($, on) => {
    const many = Array.from({ length: 60 }, (_, i) => entry(i + 1))
    const { files, writes } = engine(on, { files: seeded(many) })
    await start($)
    await flow($)
    const saved = titles(records(files, INDEX))
    expect(saved).toHaveLength(61)
    expect(saved[0]).toBe('Ship it')
    expect(saved[60]).toBe('Flow 60')
    expect(sessionPaths(files, DIR)).toHaveLength(61)
    expect(writes.filter(w => w.startsWith(`${DIR}/archive/`))).toEqual([sessionFile(flowAt(NOW))])
  })

  test('a damaged index is kept in .trash/damaged/ and rebuilt from archive/, and the panel says so; this project’s store entries show, another’s do not', async ($, on) => {
    const kept = entry(1, '/work/app', 'Kept')
    const old = [entry(9, '/work/app', 'Mine'), entry(8, '/old/site', 'Other')]
    const before = JSON.stringify(old)
    const { files, store } = engine(on, { store: { historyShown: true, history: old }, files: { [INDEX]: 'nope', [sessionFile(kept)]: JSON.stringify(kept) } })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: DAMAGED })).toBeDefined()
    await p.unmount()
    expect(files[`${DIR}/.trash/damaged/archive-index-${NOW}.json`]).toBe('nope')
    expect(titles(records(files, INDEX))).toEqual(['Kept', 'Mine'])
    expect(await archiveButtons($)).toEqual([`archive-${keyOf('e1')}`, `archive-${keyOf('e9')}`])
    await flow($)
    expect(titles(records(files, INDEX))).toEqual(['Ship it', 'Kept', 'Mine'])
    expect(titles(sessions(files, DIR))).toEqual(['Ship it', 'Kept', 'Mine'])
    expect(JSON.stringify(store.history)).toBe(before)
  })

  test('an index that is there but cannot be read (oversized) is never written; the flow still gets its file and shows', async ($, on) => {
    const big = JSON.stringify({ version: 1, sessions: [] })
    const { files, fs, store } = engine(on, { store: { historyShown: true }, files: { [INDEX]: big }, tooBig: [INDEX] })
    await start($)
    await settle()
    let p = await pane($)
    expect(await p.find({ type: 'Text', text: /no archive yet/ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: UNREADABLE })).toBeDefined()
    await p.unmount()
    expect(String((await flow($)).result)).toContain('ok')
    expect(files[INDEX]).toBe(big)
    expect(fs.tried.map(t => t.path)).not.toContain(INDEX)
    expect(titles(sessions(files, DIR))).toEqual(['Ship it'])
    expect(store.history).toBeUndefined()
    expect(await archiveButtons($)).toEqual([`archive-${keyOf(flowAt(NOW).id)}`])
    p = await pane($)
    expect(await p.find({ type: 'Text', text: UNREADABLE })).toBeDefined()
    await p.unmount()
  })

  test('a missing index takes only this project’s entries from the old store into session files at load; the store stays untouched', async ($, on) => {
    const old = [entry(1, '/work/app', 'Mine'), entry(2, '/old/site', 'Other'), entry(3, '/work/app', 'Mine too')]
    const before = JSON.stringify(old)
    const { files, store, clock } = engine(on, { store: { historyShown: true, history: old } })
    await start($)
    await settle()
    expect(await archiveButtons($)).toEqual([`archive-${keyOf('e1')}`, `archive-${keyOf('e3')}`])
    expect(titles(sessions(files, DIR))).toEqual(['Mine', 'Mine too'])
    expect(titles(records(files, INDEX))).toEqual(['Mine', 'Mine too'])
    await flow($)
    expect(titles(records(files, INDEX))).toEqual(['Ship it', 'Mine', 'Mine too'])
    clock.now = NOW + 60_000
    await flow($, 'Second')
    expect(titles(records(files, INDEX))).toEqual(['Second', 'Ship it', 'Mine', 'Mine too'])
    expect(titles(sessions(files, DIR))).toEqual(['Second', 'Ship it', 'Mine', 'Mine too'])
    expect(JSON.stringify(store.history)).toBe(before)
  })

  test('store entries of this project that the index lacks are put into it once; the store is left as it is', async ($, on) => {
    const old = [entry(1, '/work/app', 'Mine'), entry(2, '/old/site', 'Other')]
    const before = JSON.stringify(old)
    const { files, store, clock, writes } = engine(on, { store: { history: old }, files: seeded([]) })
    await start($)
    await flow($)
    expect(titles(records(files, INDEX))).toEqual(['Ship it', 'Mine'])
    clock.now = NOW + 60_000
    await flow($, 'Again')
    expect(titles(records(files, INDEX))).toEqual(['Again', 'Ship it', 'Mine'])
    expect(writes.filter(w => w === sessionFile(old[0]!))).toHaveLength(1)
    expect(JSON.stringify(store.history)).toBe(before)
  })

  test('a failing write falls back to the shared store without throwing', async ($, on) => {
    const { store, files } = engine(on, { store: { historyShown: true }, fail: { write: true } })
    await start($)
    expect(String((await flow($)).result)).toContain('ok')
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    expect(sessionPaths(files, DIR)).toEqual([])
    expect(INDEX in files).toBe(false)
    expect(await archiveButtons($)).toEqual([`archive-${keyOf(flowAt(NOW).id)}`])
    expect(await planTool($, { id: 'work', title: 'x', stages: STAGES })).toBe('work: 0/2, running, active "write tests"')
    expect((store.plans as any).s).toHaveLength(1)
  })

  test('a flow neither the folder nor the store can take still shows for this session, and the panel says so', async ($, on) => {
    const { store, files, fail } = engine(on, { store: { historyShown: true }, fail: { write: true } })
    await start($)
    fail.store = true
    expect(String((await flow($)).result)).toContain('ok')
    fail.store = false
    expect(store.history).toBeUndefined()
    expect(sessionPaths(files, DIR)).toEqual([])
    expect(await archiveButtons($)).toEqual([`archive-${keyOf(flowAt(NOW).id)}`])
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: 'could not save "Ship it" anywhere; it shows for this session only' })).toBeDefined()
    await p.unmount()
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
  test('a flow that went to the store because the write failed gets its session file at the next load; the store keeps it', async ($, on) => {
    const { files, store, fail, clock } = engine(on, { store: { historyShown: true } })
    fail.write = true
    await start($)
    await flow($)
    expect(sessionPaths(files, DIR)).toEqual([])
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    const kept = JSON.stringify(store.history)
    fail.write = false
    clock.now = NOW + 60_000
    await start($)
    await settle()
    expect(sessionPaths(files, DIR)).toEqual([sessionFile(flowAt(NOW))])
    expect(titles(records(files, INDEX))).toEqual(['Ship it'])
    expect(await archiveButtons($)).toHaveLength(1)
    await flow($, 'Second')
    expect(titles(sessions(files, DIR))).toEqual(['Second', 'Ship it'])
    expect(titles(records(files, INDEX))).toEqual(['Second', 'Ship it'])
    expect(JSON.stringify(store.history)).toBe(kept)
    await start($)
    await settle()
    expect(await archiveButtons($)).toEqual([`archive-${keyOf(flowAt(NOW + 60_000).id)}`, `archive-${keyOf(flowAt(NOW).id)}`])
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
