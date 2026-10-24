import { describe, expect, test } from 'claude-code/testing'

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
  fail?: { fs?: boolean; write?: boolean; store?: boolean; clock?: boolean }
  sessionId?: string
}

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const files = opts.files ?? {}
  const fail = opts.fail ?? {}
  const writes: string[] = []
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
  on('fs.read', (_$: any, e: any) => {
    if (fail.fs) throw new Error('fs down')
    if (opts.tooBig?.includes(e.path)) throw new Error('over 4 MiB')
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.write', (_$: any, e: any) => {
    if (fail.fs || fail.write) throw new Error('EACCES')
    writes.push(e.path)
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_$: any, e: any) => {
    if (fail.fs || !(e.path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_$: any, e: any) => {
    const pre = `${String(e.path).replace(/\/$/, '')}/`
    const names = Object.keys(files).filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/'))
    if (fail.fs || !names.length) throw new Error('ENOENT')
    return { value: names.map(p => ({ name: p.slice(pre.length), kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return { store, files, writes, clock, fail }
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
const historyButtons = async ($: any): Promise<string[]> => {
  const p = await pane($)
  const all = await p.findAll({ type: 'Button' })
  await p.unmount()
  return all.map((b: any) => JSON.stringify(b)).filter((s: string) => /Flow |Ship it|Alpha|Beta|Mine|Other/.test(s))
}
const titles = (text: string | undefined): string[] => (JSON.parse(text ?? '[]') as any[]).map(e => e.title)

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

describe('history in the project folder', () => {
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
    expect(writes).toEqual([HISTORY])
  })

  test('two projects keep separate files and separate panel lists', async ($, on) => {
    const { files, clock } = engine(on, { store: { historyShown: true } })
    await start($, '/a')
    await flow($, 'Alpha')
    clock.now = NOW + 60_000
    await start($, '/b')
    await settle()
    expect(await historyButtons($)).toEqual([])
    await flow($, 'Beta')
    expect(titles(files['/a/.claude/flowdeck/history.json'])).toEqual(['Alpha'])
    expect(titles(files['/b/.claude/flowdeck/history.json'])).toEqual(['Beta'])
    const b = await historyButtons($)
    expect(b).toHaveLength(1)
    expect(b[0]).toContain('Beta')
    await start($, '/a')
    await settle()
    const a = await historyButtons($)
    expect(a).toHaveLength(1)
    expect(a[0]).toContain('Alpha')
  })

  test('a restart reads the file and the panel shows it', async ($, on) => {
    engine(on, { store: { historyShown: true }, files: { [HISTORY]: JSON.stringify([entry(2), entry(1)]) } })
    await start($)
    await settle()
    const list = await historyButtons($)
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

  test('a corrupt file shows no history, is kept as it is, and the next flow goes to a side file and the store', async ($, on) => {
    const { files, store } = engine(on, { store: { historyShown: true, history: [entry(9, '/work/app', 'Mine')] }, files: { [HISTORY]: 'nope' } })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: /no history yet/ })).toBeDefined()
    await p.unmount()
    await flow($)
    expect(files[HISTORY]).toBe('nope')
    expect(titles(files[`${DIR}/history-extra-${NOW}.json`])).toEqual(['Ship it'])
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it', 'Mine'])
  })

  test('a file that is there but cannot be read (oversized) is never overwritten', async ($, on) => {
    const big = JSON.stringify([entry(1)])
    const { files } = engine(on, { store: { historyShown: true }, files: { [HISTORY]: big }, tooBig: [HISTORY, PLANS] })
    await start($)
    await settle()
    const p = await pane($)
    expect(await p.find({ type: 'Text', text: /no history yet/ })).toBeDefined()
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
    const shown = await historyButtons($)
    expect(shown).toHaveLength(2)
    expect(shown.some(s => s.includes('Other'))).toBe(false)
    await flow($)
    expect(titles(files[HISTORY])).toEqual(['Ship it', 'Mine', 'Mine too'])
    clock.now = NOW + 60_000
    await flow($, 'Second')
    expect(titles(files[HISTORY])).toEqual(['Second', 'Ship it', 'Mine', 'Mine too'])
    expect(JSON.stringify(store.history)).toBe(before)
  })

  test('an existing file is not re-imported from the old store', async ($, on) => {
    const { files } = engine(on, { store: { history: [entry(1, '/work/app', 'Mine')] }, files: { [HISTORY]: '[]' } })
    await start($)
    await flow($)
    expect(titles(files[HISTORY])).toEqual(['Ship it'])
  })

  test('a failing write falls back to the shared store without throwing', async ($, on) => {
    const { store, files } = engine(on, { store: { historyShown: true }, fail: { write: true } })
    await start($)
    expect(String((await flow($)).result)).toContain('ok')
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    expect(HISTORY in files).toBe(false)
    const shown = await historyButtons($)
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

  test('25 sessions in the file keep the 20 most recent', async ($, on) => {
    const plans: Record<string, unknown> = {}
    for (let i = 0; i < 25; i++) plans[`old${i}`] = [{ id: 'p', title: 't', kind: 'plan', stages: [], state: 'done', note: null, startedAt: i }]
    const { files } = engine(on, { files: { [PLANS]: JSON.stringify(plans) } })
    await start($)
    await planTool($, { id: 'work', title: 'x', stages: STAGES })
    const keys = Object.keys(JSON.parse(files[PLANS]))
    expect(keys).toHaveLength(20)
    expect(keys).toContain('s')
    expect(keys).not.toContain('old5')
    expect(keys).toContain('old24')
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
