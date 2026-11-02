import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/archive'
import { keyOfTranscript, projectByKey, projectKey } from '../hooks/project'
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
  /** folders that exist without files of their own in the fake fs */
  dirs?: string[]
  env?: Record<string, string>
}

function engine(on: any, opts: Opts = {}) {
  const store = opts.store ?? {}
  const fail = opts.fail ?? {}
  // fail.fs and fail.write are the fake fs's own switches
  const fs = fakeFs(on, { files: opts.files, tooBig: opts.tooBig, fail, dirs: opts.dirs })
  const { files, writes } = fs
  const clock = { now: NOW }
  on('env.get', (_$: any, e: any) => ({ value: opts.env?.[e.name ?? e.key ?? e.variable] }))
  on('classic.SessionStart', () => ({}))
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
    expect((store.history as any[]).map(e => e.title)).toEqual(['Ship it'])
    expect(store.plans).toBeUndefined()
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

// The Plans feature is gone (1.0.0035): an existing plans.json (and a session's plans-extra file) is never read or
// written, and its plans neither show nor reach the Archive; a flow's save leaves it exactly as it was.
describe('an old plans.json in the project folder', () => {
  test('is never read or written, its plans do not show, and the Archive holds only the flow', async ($, on) => {
    const mine = { id: 'work', title: 'Old plan', kind: 'plan', stages: [{ name: 'S', steps: [{ title: 'a', status: 'done', substeps: [] }] }], state: 'done', note: null, startedAt: 1, endedAt: 2 }
    const text = JSON.stringify({ s: [mine], other: [mine] })
    const side = `${DIR}/plans-extra-s.json`
    const { files, fs } = engine(on, { files: { [PLANS]: text, [side]: JSON.stringify([mine]) } })
    await start($)
    await settle()
    await flow($)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    await start($)
    await settle()
    const isPlansFile = (p: string) => p === PLANS || p === side
    expect(fs.reads.filter(isPlansFile)).toEqual([])
    expect(fs.writes.filter(isPlansFile)).toEqual([])
    expect(files[PLANS]).toBe(text)
    expect(files[side]).toBe(JSON.stringify([mine]))
    expect(files[IGNORE]).toBe('*\n')
    expect(titles(sessions(files, DIR))).toEqual(['Ship it'])
    const p = await pane($)
    expect(JSON.stringify(await p.drawn())).not.toContain('Old plan')
    await p.unmount()
  })
})

describe('the project folder a session saves under', () => {
  const APP = '/work/app'
  const both = [`archive-${keyOf('e1')}`, `archive-${keyOf('e2')}`]
  const savedUnder = (files: Record<string, string>, root: string) => sessions(files, `${root}/.claude/flowdeck`)
  // The transcript Claude Code keeps for session `s` of the project folder named `key`.
  const transcriptOf = (key: string) => `/Users/u/.claude/projects/${key}/s.jsonl`
  const APP_KEY = '-work-app'
  // Claude Code names the transcript at startup: before session.start reaches the mod, or after it.
  const startup = ($: any, cwd: string, transcript_path: unknown) => $.classic.SessionStart({ source: 'startup', session_id: 's', cwd, transcript_path } as any)
  const startWith = async ($: any, cwd: string, transcript: unknown, order: 'before' | 'after') => {
    if (order === 'before') await startup($, cwd, transcript)
    await start($, cwd)
    if (order === 'after') await startup($, cwd, transcript)
    await settle()
  }

  for (const order of ['before', 'after'] as const) {
    test(`a working folder below the project resolves to it by the transcript's key (transcript ${order} session.start)`, async ($, on) => {
      const files = seeded([entry(1), entry(2)])
      engine(on, { files })
      await startWith($, `${APP}/flowdeck-mod`, transcriptOf(APP_KEY), order)
      expect(await archiveButtons($)).toEqual(both)
      await flow($)
      expect(titles(savedUnder(files, APP))).toContain('Ship it')
      expect(savedUnder(files, APP).find(e => e.title === 'Ship it').project).toBe(APP)
      expect(Object.keys(files).filter(p => p.startsWith(`${APP}/flowdeck-mod/`))).toEqual([])
    })
  }

  test('a nested git repository with its own .claude/flowdeck does not take the session: the transcript names the parent', async ($, on) => {
    const child = `${APP}/flowdeck-mod`
    const { files } = engine(on, { dirs: [`${child}/.git`, `${child}/.claude/flowdeck`] })
    await startWith($, `${child}/hooks`, transcriptOf(APP_KEY), 'before')
    await flow($)
    expect(titles(savedUnder(files, APP))).toEqual(['Ship it'])
    expect(savedUnder(files, child)).toEqual([])
  })

  test('the working folder that is the project resolves to itself', async ($, on) => {
    const { files } = engine(on)
    await startWith($, APP, transcriptOf(APP_KEY), 'before')
    await flow($)
    expect(titles(savedUnder(files, APP))).toEqual(['Ship it'])
  })

  test('a working folder outside the project tree is itself', async ($, on) => {
    const { files } = engine(on, { files: seeded([entry(1), entry(2)]) })
    await startWith($, '/tmp', transcriptOf(APP_KEY), 'after')
    expect(await archiveButtons($)).toEqual([])
    await flow($)
    expect(titles(savedUnder(files, '/tmp'))).toEqual(['Ship it'])
  })

  test('with no transcript named a working folder below the project resolves to the project whose transcript file exists, and no child gets a .claude', async ($, on) => {
    const files = { ...seeded([entry(1), entry(2)]), '/Users/u/.claude/projects/-work-app/s.jsonl': '{}' }
    engine(on, { files, dirs: [DIR], env: { HOME: '/Users/u' } })
    await start($, `${APP}/flowdeck-mod`)
    expect(await archiveButtons($)).toEqual(both)
    await flow($)
    expect(titles(savedUnder(files, APP))).toContain('Ship it')
    expect(Object.keys(files).filter(p => p.startsWith(`${APP}/flowdeck-mod/`))).toEqual([])
  })

  test('with no transcript and no transcript file the working folder itself; its .claude markers are never looked for', async ($, on) => {
    const { files, fs } = engine(on, { files: seeded([entry(1), entry(2)]), dirs: [DIR, `${APP}/.git`] })
    await start($, `${APP}/src`)
    expect(await archiveButtons($)).toEqual([])
    await flow($)
    expect(titles(savedUnder(files, `${APP}/src`))).toEqual(['Ship it'])
    expect(fs.calls.filter(c => !c.path.endsWith('.jsonl') && !c.path.startsWith(`${APP}/src/.claude/flowdeck`))).toEqual([])
  })

  test('a failing store still takes the transcript’s project and never throws', async ($, on) => {
    const files = seeded([entry(1), entry(2)])
    engine(on, { files, dirs: [DIR], fail: { store: true } })
    await startWith($, `${APP}/src`, transcriptOf(APP_KEY), 'after')
    expect(await archiveButtons($)).toEqual(both)
  })

  test('resolving by the transcript makes no fs call: everything the start and a save touch is inside the project’s .claude/flowdeck', async ($, on) => {
    const { fs } = engine(on, { files: seeded([entry(1)]), dirs: [DIR] })
    await startWith($, `${APP}/a/b/c`, transcriptOf(APP_KEY), 'before')
    expect(fs.calls.length).toBeGreaterThan(0)
    await flow($)
    expect(fs.calls.filter(c => c.path !== DIR && !c.path.startsWith(`${DIR}/`))).toEqual([])
  })

  test('a malformed or missing transcript path never throws and falls to the working folder', async ($, on) => {
    const { files } = engine(on)
    for (const bad of [undefined, null, 42, '', '/', 'no-folder.jsonl', '//', '/x/', { path: '/a/b.jsonl' }]) {
      await startWith($, `${APP}/src`, bad, 'before')
      await startWith($, `${APP}/src`, bad, 'after')
    }
    expect(String((await flow($)).result)).toContain('ok')
    expect(titles(savedUnder(files, `${APP}/src`))).toEqual(['Ship it'])
    expect(savedUnder(files, APP)).toEqual([])
  })
})

describe('Claude Code’s project-folder key (project.ts)', () => {
  test('every character outside [A-Za-z0-9] becomes a dash, as the folders under ~/.claude/projects show', () => {
    expect(projectKey('/Users/user/www/paavu/claude/server-setup')).toBe('-Users-user-www-paavu-claude-server-setup')
    expect(projectKey('/private/var/folders/5b/r57vf_jx0p5bwvn5prqsyksm0000gn/T')).toBe('-private-var-folders-5b-r57vf-jx0p5bwvn5prqsyksm0000gn-T')
    expect(projectKey('/Users/u/.claude')).toBe('-Users-u--claude')
    expect(projectKey('/Users/u/My Projects/app_v2')).toBe('-Users-u-My-Projects-app-v2')
    expect(projectKey('/Users/u/café')).toBe('-Users-u-caf-')
    expect(projectKey('C:\\Users\\u\\app')).toBe('C--Users-u-app')
  })

  test('a key past 200 characters is cut there, then a dash and the hash of the whole path in base 36', () => {
    const long = `/Users/u/${'very-long-folder-name/'.repeat(10)}app`
    const key = projectKey(long)
    expect(key).toBe(`${long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-nxmrj9`)
    expect(projectByKey(`${long}/src`, `/c/projects/${key}/s.jsonl`)).toBe(long)
    expect(projectKey('/x'.repeat(100))).toHaveLength(200)
  })

  test('the transcript’s key is its folder’s name', () => {
    expect(keyOfTranscript('/Users/u/.claude/projects/-work-app/s.jsonl')).toBe('-work-app')
    expect(keyOfTranscript('C:\\Users\\u\\.claude\\projects\\C--app\\s.jsonl')).toBe('C--app')
    for (const bad of [undefined, null, 7, '', 's.jsonl', '/s.jsonl', '/a/', '//']) expect(keyOfTranscript(bad)).toBe('')
  })

  test('the project is the ancestor whose key equals the transcript’s exactly, the working folder first', () => {
    const t = (key: string) => `/c/projects/${key}/s.jsonl`
    // `/a/b-c` and `/a/b/c` share a key: each matches only itself, never the other spelling
    expect(projectByKey('/a/b-c/d', t('-a-b-c'))).toBe('/a/b-c')
    expect(projectByKey('/a/b/c', t('-a-b-c'))).toBe('/a/b/c')
    expect(projectByKey('/a/b.c/x', t('-a-b-c'))).toBe('/a/b.c')
    // a key that is a prefix of a folder's key is not that folder
    expect(projectByKey('/a/b-c/d', t('-a-b'))).toBeNull()
    expect(projectByKey('/a/b/c/d', t('-a-b'))).toBe('/a/b')
    expect(projectByKey('/a/b/c/', t('-a-b-c'))).toBe('/a/b/c/')
    expect(projectByKey('/a/b', t('-'))).toBe('/')
    expect(projectByKey('/tmp', t('-a-b'))).toBeNull()
    expect(projectByKey('', t('-a-b'))).toBeNull()
  })

  test('a key made from the composed (NFC) form of a decomposed path still matches it', () => {
    const decomposed = '/u/cafe\u0301'
    expect(projectByKey(`${decomposed}/x`, `/c/projects/${projectKey(decomposed.normalize('NFC'))}/s.jsonl`)).toBe(decomposed)
  })
})

describe('everything failing', () => {
  test('the tool calls and the turn never throw when fs, clock and store all fail', async ($, on) => {
    const { fail } = engine(on, { fail: { fs: true, store: true } })
    await start($)
    expect(String((await progress($, { title: 'T', total: 1, done: 0, phase: 'delegate', tasks: [{ title: 'a', tier: 'light' }] })).result)).toContain('ok')
    // From here the clock fails too, where saving reads it: recording the flow.
    fail.clock = true
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(String((await progress($, { finished: true })).result)).toContain('ok')
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  })
})
