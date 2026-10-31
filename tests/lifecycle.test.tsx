import { describe, expect, test } from 'claude-code/testing'

import { IDLE_FINISH_MS, LIVE_STALE_MS } from '../hooks/live'
import { indexPath, records, sessionPaths, sessions } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'

// The flow's lifecycle, all of it from the mod itself: a task list or a worker starts a flow, it finishes by itself,
// flow-live.json keeps it across a restart, and the next session closes and archives the last one.

const NOW = Date.UTC(2026, 9, 30, 9, 0)
const MIN = 60_000
const DIR = '/work/app/.claude/flowdeck'
const LIVE = `${DIR}/flow-live.json`
const SURFACES = ['desktop', 'terminal'] as const

function engine(on: any, opts: { files?: Record<string, string>; sid?: string; storeFails?: boolean; noSettings?: boolean; rule?: string } = {}) {
  const fs = fakeFs(on, { files: opts.files ?? {} })
  const clock = { now: NOW }
  const session = { id: opts.sid ?? 's' }
  const logs: string[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => {
    if (opts.noSettings) throw new Error('no settings')
    return { value: {} }
  })
  on('clock.every', () => ({ value: undefined })) // the tick runs again at once: the clock decides what is due
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: session.id, cwd: e.cwd }))
  on('session.id', () => ({ value: session.id }))
  on('session.end', () => ({ sessionId: session.id }))
  on('classic.SessionStart', () => ({}))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => (logs.push(String(e.text)), { value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: e.key === 'rule' ? opts.rule : undefined }))
  on('store.set', () => {
    if (opts.storeFails) throw new Error('store down')
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'below' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  return { fs, files: fs.files, clock, session, logs }
}

const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 40))
const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const todo = ($: any, todos: [string, string][]) => $.tool.call({ tool: 'TodoWrite', todos: todos.map(([content, status]) => ({ content, status })) } as any)
const launch = async ($: any, id: string, description: string, tier = 'light') => {
  await $.tool.call({ tool: 'Agent', subagent_type: `flowdeck-${tier}`, description, prompt: 'p' } as any)
  await $.agent.spawn({ subagentType: `flowdeck-${tier}`, description, tool_use_id: id } as any)
}
const ended = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const mainTurnEnds = ($: any) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
const steps = ($: any, agentId: string, titles: string[]) => $.tool.call({ tool: 'mcp__flowdeck__step', agentId, steps: titles.map(title => ({ title })) } as any)

// The band's flow row as the desktop says it (`<where the flow is>: <label>, <percent>`: the running or next task, else FlowDeck; never the flow's title), '' with no flow.
const bandSays = async ($: any): Promise<string> => {
  const b = await $.ui.mount({ plugin: 'flowdeck', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } } as any)
  const alts = (await b.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt ?? ''))
  await b.unmount()
  return alts.find((a: string) => /: .*%$/.test(a)) ?? ''
}
const paneText = async ($: any, surface: 'desktop' | 'terminal' = 'terminal') => {
  const p = await $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  const texts = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const alts = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt ?? ''))
  await p.unmount()
  return [...texts, ...alts].join('\n')
}
// Whether a mounted pane draws `re` anywhere: its texts, its drawings' alt texts and sources.
const paneHas = async ($: any, surface: 'desktop' | 'terminal', re: RegExp): Promise<boolean> => {
  const p = await $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  const drawn = JSON.stringify(await p.drawn())
  await p.unmount()
  return re.test(drawn)
}
const live = (files: Record<string, string>): any => (LIVE in files ? JSON.parse(files[LIVE]!) : undefined)
// The shown flow's name, as flow-live.json keeps it (the panel and the band no longer show it).
const flowName = async (files: Record<string, string>): Promise<string | undefined> => {
  await settle()
  return live(files)?.sessions?.s?.flow?.title
}
const archived = (files: Record<string, string>): any[] => sessions(files, DIR)

const FLOW = (over: Record<string, unknown> = {}) => ({
  title: 'Old work',
  total: 2,
  done: 1,
  running: 0,
  phase: 'delegate',
  isFinished: false,
  isLinked: true,
  tasks: [
    { title: 'first', tier: 'light', after: [] },
    { title: 'second', tier: 'medium', after: [1] },
  ],
  accepted: [1],
  ...over,
})
const RUN = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  agentId: 'r1',
  type: 'flowdeck-light',
  description: 'first',
  model: 'claude-opus-5-5',
  status: 'done',
  startedAt: NOW - 50 * MIN,
  endedAt: NOW - 40 * MIN,
  contextTokens: 0,
  contextMax: 1,
  tokens: 1000,
  costUsd: 0.5,
  steps: 1,
  round: 1,
  ...over,
})
// A record as an earlier session left it: the flow, a done run and a run still going, its last activity 30 minutes ago.
const record = (sid: string, over: Record<string, unknown> = {}) => ({
  sessionId: sid,
  flow: FLOW(),
  agents: [RUN(), RUN({ id: 'r2', agentId: 'r2', description: 'second', type: 'flowdeck-medium', status: 'running', startedAt: NOW - 35 * MIN, endedAt: undefined })],
  meta: { startedAt: NOW - 60 * MIN, project: '/work/app' },
  lastActivityAt: NOW - 30 * MIN,
  beatAt: NOW - 29 * MIN,
  ...over,
})
const seedLive = (recs: any[]): Record<string, string> => ({ [LIVE]: JSON.stringify({ version: 1, sessions: Object.fromEntries(recs.map(r => [r.sessionId, r])) }) })

describe('every task goes through flowdeck', () => {
  test('a task list with no flow starts one named after its first item, the items mirrored as its tasks', async ($, on) => {
    const { files } = engine(on)
    await start($)
    expect(await bandSays($)).toBe('')
    await todo($, [
      ['Write the migration for the lifecycle that keeps every flow across restarts', 'in_progress'],
      ['Update docs', 'pending'],
    ])
    expect(await bandSays($)).toBe('Write the migration for the lifecycle that keeps every flow across restarts: Tasks 0/2, 0%')
    expect(await flowName(files)).toBe('Write the migration for the lifecycle that…')
    expect(await paneText($)).toContain('2. Update docs')
    await todo($, [
      ['Write the migration for the lifecycle that keeps every flow across restarts', 'completed'],
      ['Update docs', 'in_progress'],
    ])
    expect(await bandSays($)).toMatch(/: Tasks 1\/2, 50%$/)
  })

  test('a worker started with no flow starts one named after its description, without its task number', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await launch($, 'w1', '#3 History module')
    expect(await bandSays($)).toMatch(/^History module: /)
    expect(await flowName(files)).toBe('History module')
    expect(await paneText($)).toContain('History module')
    // a plan sent after it joins that flow: renamed, its tasks numbered from 1
    expect(await progress($, { title: 'Archive work', phase: 'delegate', tasks: [{ title: 'History module', tier: 'light' }, { title: 'Docs', tier: 'light' }] })).toBe('ok: Tasks 0/2')
    expect(await flowName(files)).toBe('Archive work')
  })

  test('a worker of another kind, or a worker\'s own task list, starts no flow', async ($, on) => {
    engine(on)
    await start($)
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'look', prompt: 'p' } as any)
    await $.tool.call({ tool: 'TodoWrite', agentId: 'w9', todos: [{ content: 'a step', status: 'pending' }] } as any)
    expect(await bandSays($)).toBe('')
  })

  test('the flow rule in the system prompt names the progress tool and the reporting duties', async ($, on) => {
    engine(on, { rule: 'on' })
    on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'engine', scope: 'shared' }] }))
    const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
    const rule = r.sections.find((s: any) => s.id === 'flowdeck:flow-rule')
    expect(rule?.scope).toBe('session')
    for (const word of ['mcp__flowdeck__progress', 'mcp__flowdeck__step', 'tasks [{title, tier, after, goal}]', '`after`', '`add`', 'done: [n]', 'result, feedback', '#<n> <title>', 'never leave', 'one-step edit']) {
      expect(rule.text).toContain(word)
    }
    // Trimmed in 1.0.0037 to about half of the 896 characters it had.
    expect(rule.text.length).toBeLessThan(560)
  })
})

describe('a flow finishes by itself', () => {
  const plan2 = ($: any) => progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }, { title: 'two', tier: 'light' }] })

  test('when every task is done, no run goes and the main turn ends: finished, archived once, still shown', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan2($)
    await launch($, 'w1', '#1 one')
    clock.now = NOW + MIN
    await ended($, 'w1')
    await progress($, { done: [2] })
    // a subagent's turn end is not the main turn's
    await ended($, 'w1')
    expect(await bandSays($)).toMatch(/^FlowDeck: Tasks/)
    clock.now = NOW + 2 * MIN
    await mainTurnEnds($)
    expect(await bandSays($)).toBe('FlowDeck: Done, 100%')
    const list = archived(files)
    expect(list.map(e => [e.title, e.status, e.endedAt])).toEqual([['Ship', 'finished', NOW + 2 * MIN]])
    // shown in the Finished tab for review, and saved once
    await showTab($, 'finished')
    expect(await paneText($)).toContain('1. one')
    await mainTurnEnds($)
    expect(sessionPaths(files, DIR)).toHaveLength(1)
    expect(live(files).sessions.s.flow.isFinished).toBe(true)
  })

  test('an Incomplete run, a failed run or a run still going holds it open; so does a flow without tasks', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await plan2($)
    await progress($, { done: [2] })
    await launch($, 'w1', '#1 one')
    await mainTurnEnds($)
    expect(await bandSays($)).not.toMatch(/Done/) // w1 runs
    await steps($, 'w1', ['read', 'write'])
    await ended($, 'w1')
    await mainTurnEnds($)
    expect(await bandSays($)).not.toMatch(/Done/) // w1 is Incomplete: 1 of 2 steps
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, agentId: 'w1' } as any)
    await mainTurnEnds($)
    expect(await bandSays($)).not.toMatch(/Done/) // failed
    expect(archived(files)).toEqual([])
    await progress($, { done: [1] }) // accepted: the task is done whatever its run says
    await mainTurnEnds($)
    expect(await bandSays($)).toBe('FlowDeck: Done, 100%')
  })

  test('a flow without tasks never finishes at a turn end', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await launch($, 'w1', 'loose job')
    await ended($, 'w1')
    await mainTurnEnds($)
    expect(await bandSays($)).toMatch(/^FlowDeck: /)
    expect(await flowName(files)).toBe('loose job')
    expect(await bandSays($)).not.toMatch(/Done/)
  })

  test('a finished flow is replaced by the next task: a new flow, the old one archived once', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await todo($, [['first job', 'pending']])
    await todo($, [['first job', 'completed']])
    await mainTurnEnds($)
    expect(await bandSays($)).toBe('FlowDeck: Done, 100%')
    clock.now = NOW + 10 * MIN
    await todo($, [['second job', 'pending']])
    expect(await bandSays($)).toBe('second job: Tasks 0/1, 0%')
    expect(await flowName(files)).toBe('second job')
    expect(archived(files).map(e => e.title)).toEqual(['first job'])
    expect(await paneText($)).not.toContain('first job')
    await todo($, [['second job', 'completed']])
    await mainTurnEnds($)
    expect(archived(files).map(e => e.title)).toEqual(['second job', 'first job'])
    expect(records(files, indexPath(DIR))?.map(r => r.title)).toEqual(['second job', 'first job'])
  })

  test(`idle for ${IDLE_FINISH_MS / MIN} minutes with nothing running or queued: finished, dated by its last activity`, async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await progress($, { title: 'Idle', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    await launch($, 'w1', '#1 one')
    await steps($, 'w1', ['a', 'b'])
    clock.now = NOW + MIN
    await ended($, 'w1') // Incomplete: the turn end does not finish it
    await mainTurnEnds($)
    await settle()
    const at = live(files).sessions.s.lastActivityAt
    expect(at).toBe(NOW + MIN)
    clock.now = at + IDLE_FINISH_MS - 10_000
    await settle()
    expect(await bandSays($)).not.toMatch(/Done/)
    clock.now = at + IDLE_FINISH_MS + 10_000
    await settle()
    expect(await bandSays($)).toBe('FlowDeck: Done, 100%')
    expect(archived(files).map(e => [e.title, e.status, e.endedAt])).toEqual([['Idle', 'finished', at]])
  })

  test('a queued task or a running worker keeps an idle flow open', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Waiting', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }, { title: 'two', tier: 'light' }] })
    await settle()
    clock.now = NOW + 2 * IDLE_FINISH_MS
    await settle()
    expect(await bandSays($)).not.toMatch(/Done/) // two tasks queued
    await launch($, 'w1', '#1 one')
    await launch($, 'w2', '#2 two')
    clock.now = NOW + 5 * IDLE_FINISH_MS
    await settle()
    expect(await bandSays($)).not.toMatch(/Done/) // two runs going
  })
})

// Phase one writes the file, phase two (the next test, a new process) reads it.
let handoff: Record<string, string> = {}

describe('flow-live.json', () => {
  test('holds the shown flow per session: version, owner, flow, runs, meta, last activity and heartbeat', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    expect(LIVE in files).toBe(false)
    await progress($, { title: 'Kept', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }, { title: 'two', tier: 'light' }] })
    await launch($, 'w1', '#1 one')
    clock.now = NOW + MIN
    await settle() // the tick writes what changed
    const f = live(files)
    expect(f.version).toBe(1)
    expect(Object.keys(f.sessions)).toEqual(['s'])
    const rec = f.sessions.s
    expect(rec.sessionId).toBe('s')
    expect(rec.flow.title).toBe('Kept')
    expect(rec.flow.tasks.map((t: any) => t.title)).toEqual(['one', 'two'])
    expect(rec.agents.map((a: any) => [a.id, a.status])).toEqual([['w1', 'running']])
    expect(rec.meta).toEqual({ startedAt: NOW, project: '/work/app' })
    expect(rec.lastActivityAt).toBe(NOW + MIN)
    expect(rec.beatAt).toBe(NOW + MIN)
    expect(rec.endedAt).toBeUndefined()
    // nothing changed: written again only as the heartbeat, its activity kept
    clock.now = NOW + 3 * MIN
    await settle()
    expect(live(files).sessions.s.lastActivityAt).toBe(NOW + MIN)
    expect(live(files).sessions.s.beatAt).toBe(NOW + 3 * MIN)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(live(files).sessions.s.endedAt).toBe(NOW + 3 * MIN)
    handoff = { ...files }
  })

  test('the same session started again (a resume in a new process) gets its flow back; its running run reads Running at finish', async ($, on) => {
    expect(LIVE in handoff).toBe(true)
    const { files, clock } = engine(on, { files: { ...handoff } })
    clock.now = NOW + 20 * MIN
    await start($)
    expect(await bandSays($)).toMatch(/^two: /)
    for (const surface of SURFACES) {
      await showTab($, 'finished')
      expect(await paneHas($, surface, /Running at finish/)).toBe(true)
      await showTab($, 'active')
      expect(await paneText($, surface)).toContain('2. two') // still queued
      expect(await paneHas($, surface, /Running at finish|Running ·/)).toBe(false)
    }
    await settle()
    const rec = live(files).sessions.s
    expect(rec.endedAt).toBeUndefined()
    expect(rec.agents[0].endedAt).toBe(NOW + MIN) // ended when the session's last activity was
    expect(rec.agents[0].status).toBe('running')
    expect(archived(files).map(e => e.status)).toEqual(['open']) // the session end's entry, until the flow ends
  })

  test('another session\'s record is closed: finished at its last activity, its running run ended then, archived, taken out of the file', async ($, on) => {
    const { files } = engine(on, { files: seedLive([record('old', { endedAt: NOW - 28 * MIN })]) })
    await start($)
    const list = archived(files)
    expect(list.map(e => [e.title, e.status, e.endedAt])).toEqual([['Old work', 'finished', NOW - 30 * MIN]])
    expect(list[0].agents.map((a: any) => [a.id, a.status, a.endedAt])).toEqual([
      ['r1', 'done', NOW - 40 * MIN],
      ['r2', 'running', NOW - 30 * MIN],
    ])
    expect(list[0].id).toBe(`${NOW - 60 * MIN}-/work/app`)
    expect(live(files).sessions).toEqual({})
    expect(live(files).version).toBe(1)
    // the panel starts clean; the Archive draws the run as Running at finish
    expect(await bandSays($)).toBe('')
    await showTab($, 'archive')
    for (const surface of SURFACES) expect(await paneHas($, surface, /Running at finish/)).toBe(true)
  })

  test('a record whose session stopped writing it is closed too; one written a moment ago is left until it goes stale', async ($, on) => {
    const { files, clock } = engine(on, {
      files: seedLive([record('gone', { beatAt: NOW - LIVE_STALE_MS - 1000 }), record('alive', { beatAt: NOW - 10_000, flow: FLOW({ title: 'Elsewhere' }), meta: { startedAt: NOW - 5 * MIN, project: '/work/app' } })]),
    })
    await start($)
    expect(archived(files).map(e => e.title)).toEqual(['Old work'])
    expect(Object.keys(live(files).sessions)).toEqual(['alive'])
    clock.now = NOW + LIVE_STALE_MS + 1000
    await settle()
    expect(archived(files).map(e => e.title).sort()).toEqual(['Elsewhere', 'Old work'])
    expect(live(files).sessions).toEqual({})
  })

  test('a reload keeps the flow the panel holds: its own record never overwrites it', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await progress($, { title: 'Held', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    const stale = { ...live(files) }
    stale.sessions = { s: { ...stale.sessions.s, flow: { ...stale.sessions.s.flow, title: 'Stale' } } }
    files[LIVE] = JSON.stringify(stale)
    await start($) // /reload-plugins runs session.start again; the held values stay
    expect(await bandSays($)).toMatch(/^one: /)
    expect(archived(files)).toEqual([])
    await progress($, { finished: true })
    expect(archived(files).map(e => e.title)).toEqual(['Held'])
  })

  test('starting twice archives nothing twice', async ($, on) => {
    const { files } = engine(on, { files: seedLive([record('old', { endedAt: NOW - 28 * MIN })]) })
    await start($)
    await start($) // a reload runs session.start again
    await $.classic.SessionStart({ source: 'resume', session_id: 's', transcript_path: '/t/s.jsonl' } as any)
    expect(sessionPaths(files, DIR)).toHaveLength(1)
    expect(records(files, indexPath(DIR))).toHaveLength(1)
  })

  test('a record closed while its archive save is refused stays in the file for the next start', async ($, on) => {
    const { files, fs } = engine(on, { files: seedLive([record('old', { endedAt: NOW - 28 * MIN })]), storeFails: true })
    fs.fail.write = (path: string) => path.includes('/archive') // the session file cannot be written, nor the store
    await start($)
    expect(Object.keys(live(files).sessions)).toEqual(['old'])
    fs.fail.write = undefined
  })

  test('a damaged file is never written over, and says so once in the transcript and on the panel', async ($, on) => {
    const text = 'not json {'
    const { files, logs, fs, clock } = engine(on, { files: { [LIVE]: text } })
    await start($)
    await progress($, { title: 'New', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    await todo($, [['more', 'pending']])
    clock.now = NOW + 5 * MIN
    await settle()
    expect(files[LIVE]).toBe(text)
    expect(fs.tried.some(t => t.path === LIVE)).toBe(false)
    const said = logs.filter(l => /flow-live\.json/.test(l))
    expect(said.length).toBeGreaterThan(0)
    expect(new Set(said).size).toBe(said.length) // each reason once
    expect(said[0]).toMatch(/^flowdeck: flow-live\.json holds no flowdeck state.*\(v\d+\.\d+\.\d{4}\)$/)
    expect(await paneText($)).toMatch(/flow-live\.json holds no flowdeck state/)
    expect(await bandSays($)).toMatch(/^one: /) // the panel works without it
  })

  test('a file that cannot be read, or whose existence cannot be told, is left as it is', async ($, on) => {
    const { files, fs } = engine(on, { files: { [LIVE]: '{"version":1,"sessions":{}}' } })
    fs.unreadable.add(LIVE)
    await start($)
    await progress($, { title: 'New', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    expect(fs.tried.some(t => t.path === LIVE)).toBe(false)
    expect(await paneText($)).toMatch(/flow-live\.json could not be read/)
    expect(files[LIVE]).toBe('{"version":1,"sessions":{}}')
  })

  test('a file that holds no flowdeck state is left as it is', async ($, on) => {
    const { files } = engine(on, { files: { [LIVE]: '[1, 2]' } })
    await start($)
    await progress($, { title: 'New', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    expect(files[LIVE]).toBe('[1, 2]')
  })

  test('another session\'s record it cannot read and fields it does not know are written back as they were', async ($, on) => {
    const seeded = JSON.parse(seedLive([])[LIVE]!)
    seeded.extra = { kept: true }
    seeded.sessions.weird = 'not a record'
    const { files } = engine(on, { files: { [LIVE]: JSON.stringify(seeded) } })
    await start($)
    await progress($, { title: 'Mine', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    const f = live(files)
    expect(f.extra).toEqual({ kept: true })
    expect(f.sessions.weird).toBe('not a record')
    expect(f.sessions.s.flow.title).toBe('Mine')
  })
})

describe('a new session in the same process', () => {
  test('/clear closes the flow shown (dated by its last activity) and the panel starts clean', async ($, on) => {
    const { files, clock, session } = engine(on)
    await start($)
    await progress($, { title: 'Before clear', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    clock.now = NOW + 5 * MIN
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    session.id = 's2'
    await $.classic.SessionStart({ source: 'clear', session_id: 's2', transcript_path: '/t/s2.jsonl' } as any)
    expect(await bandSays($)).toBe('')
    const list = archived(files)
    expect(list.map(e => [e.title, e.status, e.endedAt])).toEqual([['Before clear', 'finished', NOW]])
    expect(live(files).sessions).toEqual({})
    // the new session's own flow is written under its id
    await todo($, [['after clear', 'pending']])
    expect(Object.keys(live(files).sessions)).toEqual(['s2'])
  })

  test('a /compact keeps the session and its flow', async ($, on) => {
    const { files } = engine(on)
    await start($)
    await progress($, { title: 'Compacted', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    await $.classic.SessionStart({ source: 'compact', session_id: 's' } as any)
    expect(await bandSays($)).toMatch(/^one: /)
    expect(archived(files)).toEqual([])
  })
})

// The Plans feature is gone (1.0.0035): the plans files an older flowdeck left are never read, written or archived.
describe('plans files an older flowdeck left', () => {
  const plan = (id: string, state: string) => ({ id, title: `Plan ${id}`, kind: 'todo', stages: [{ name: 'todo', steps: [{ title: 'a', status: state === 'done' ? 'done' : 'active', substeps: [] }] }], state, note: null, startedAt: NOW - 90 * MIN, endedAt: state === 'done' ? NOW - 80 * MIN : null })

  test('plans.json and the plans-extra files are left exactly as they are: never read, written or archived', async ($, on) => {
    const plans = JSON.stringify({ other: [plan('p1', 'done'), plan('p2', 'running')], s: [plan('p3', 'running')] })
    const side = JSON.stringify([plan('p4', 'done')])
    const { fs, files } = engine(on, { files: { [`${DIR}/plans.json`]: plans, [`${DIR}/plans-extra-third.json`]: side } })
    await start($)
    await settle()
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] })
    await mainTurnEnds($)
    await settle()
    const isPlansFile = (p: string) => /\/plans(-extra-[^/]+)?\.json$/.test(p)
    expect(fs.reads.filter(isPlansFile)).toEqual([])
    expect(fs.writes.filter(isPlansFile)).toEqual([])
    expect(files[`${DIR}/plans.json`]).toBe(plans)
    expect(files[`${DIR}/plans-extra-third.json`]).toBe(side)
    expect(archived(files).filter(e => /^Plan p/.test(e.title))).toEqual([])
  })
})

describe('with an empty store and no settings, as on a new machine', () => {
  test('the whole lifecycle runs from the mod alone', async ($, on) => {
    const { files, clock, session } = engine(on, { noSettings: true })
    on('prompt.compose', () => ({ sections: [] }))
    await start($)
    const compose = () => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
    // A fresh install has made no choice: nothing goes into the system prompt until the user turns tracking on.
    expect((await compose()).sections.map((s: any) => s.id)).toEqual([])
    // a task list starts the flow; a worker does one task, the list completes the other
    await todo($, [['Build the thing', 'in_progress'], ['Check the thing', 'pending']])
    await launch($, 'w1', 'Build the thing', 'medium')
    await steps($, 'w1', ['code', 'test'])
    await $.tool.call({ tool: 'mcp__flowdeck__step', agentId: 'w1', done: ['code', 'test'] } as any)
    clock.now = NOW + MIN
    await ended($, 'w1')
    await todo($, [['Build the thing', 'completed'], ['Check the thing', 'completed']])
    expect(await bandSays($)).toBe('FlowDeck: Tasks 2/2, 100%')
    clock.now = NOW + 2 * MIN
    await mainTurnEnds($)
    expect(await bandSays($)).toBe('FlowDeck: Done, 100%')
    expect(archived(files).map(e => [e.title, e.status, e.agents.length])).toEqual([['Build the thing', 'finished', 1]])
    expect(files[`${DIR}/.gitignore`]).toBe('*\n')
    expect(live(files).sessions.s.flow.isFinished).toBe(true)
    // the session ends; a /clear starts the next one, which finds the finished flow archived already
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    expect(live(files).sessions.s.endedAt).toBe(NOW + 2 * MIN)
    session.id = 'next'
    await $.classic.SessionStart({ source: 'clear', session_id: 'next' } as any)
    expect(live(files).sessions).toEqual({})
    expect(sessionPaths(files, DIR)).toHaveLength(1)
    expect(await bandSays($)).toBe('')
    for (const surface of SURFACES) expect(await paneText($, surface)).toMatch(/v\d+\.\d+\.\d{4}/)
    await $.command.run({ command: 'flowdeck-rule', args: 'on' } as any)
    expect((await compose()).sections.map((s: any) => s.id)).toEqual(['flowdeck:flow-rule'])
  })
})
