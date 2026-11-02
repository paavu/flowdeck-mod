import { describe, expect, mock, test } from 'claude-code/testing'

import { dayId, entryDate, keyOf, snapshot } from '../hooks/archive'
import { dayKey } from '../hooks/time'
import type { AgentRun, ArchiveEntry, Flow } from '../types'
import { fileOf, indexPath, records, seed, sessionPaths } from './archive-files'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'
import type { Tab } from './tabs'

// The Finished tab keeps the rows of every flow finished on the same local date beside the shown flow's own, one list,
// latest first; the Archive lists those flows only once their day has passed, when they are merged into one session for
// that day. Times are local, so the date change is local midnight wherever the tests run.

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
// 23:58 local on Nov 2: midnight is two minutes away.
const NOW = new Date(2026, 10, 2, 23, 58).getTime()
const MIDNIGHT = new Date(2026, 10, 3, 0, 0).getTime()
const YESTERDAY = new Date(2026, 10, 1, 15, 0).getTime()
const PROJECT = '/work/app'
const DIR = `${PROJECT}/.claude/flowdeck`
const INDEX = indexPath(DIR)

function engine(on: any, opts: { files?: Record<string, string> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const fs = fakeFs(on, { files: opts.files })
  const store: Record<string, unknown> = {}
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'band below' }))
  // The clock moves on in ticks of 5 s, each running the mod's tick; a move to a time to look at waits for the merge
  // the tick may start.
  const at = { now: NOW }
  const move = async (ms: number, waits: number) => {
    at.now = ms
    await clock.set(ms)
    for (let i = 0; i < waits; i++) await settle()
  }
  return { fs, files: fs.files, at, to: (ms: number) => move(ms, 8), step: () => move(at.now + 5 * SEC, 1) }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-medium', description, tool_use_id: id } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const tasks = (...titles: string[]) => titles.map(title => ({ title, tier: 'medium' }))

// One flow run through: planned, each task done by a worker 5 s apart, accepted and finished.
async function flowDone($: any, env: ReturnType<typeof engine>, title: string, names: string[], ids: string[]) {
  await env.step()
  await progress($, { title, phase: 'delegate', tasks: tasks(...names) })
  for (const [i, name] of names.entries()) {
    await env.step()
    await spawn($, ids[i]!, `#${i + 1} ${name}`)
    await env.step()
    await complete($, ids[i]!)
  }
  await progress($, { done: names.map((_, i) => i + 1), finished: true })
}

// One tab as the terminal draws it: its texts, its buttons and the tab labels.
async function look($: any, tab: Tab, surface: 'terminal' | 'desktop' = 'terminal') {
  await showTab($, tab)
  const p = await $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  const texts = (await p.findAll({ type: 'Text' })).map((x: any) => String(x.text))
  const buttons = (await p.findAll({ type: 'Button' })).map((b: any) => ({ key: String(b.props.key), text: String(b.props.label ?? b.text).replace(/^● /, '') }))
  const alts = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt))
  await p.unmount()
  const label = (key: string) => buttons.find((b: { key: string }) => b.key === key)?.text
  return { text: texts.join('\n'), texts, alts, label, groups: buttons.filter((b: { key: string }) => /^archive-k[a-z0-9]+$/.test(b.key)) }
}

// What the band says: the terminal's label and percent.
async function bandSays($: any): Promise<string[]> {
  const b = await $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } } as any)
  const texts = (await b.findAll({ type: 'Text' })).map((x: any) => String(x.text))
  await b.unmount()
  return texts
}

// A saved flow, as a save leaves it: dated by its end (`day` set, as this release saves every flow).
const flow = (title: string, names: string[]): Flow => ({ title, total: names.length, done: names.length, running: 0, phase: 'close', isFinished: true, isLinked: true, tasks: names.map(t => ({ title: t, tier: 'medium', after: [] })), accepted: names.map((_, i) => i + 1) })
const run = (id: string, description: string, startedAt: number): AgentRun => ({ id, agentId: id, type: 'flowdeck-medium', description, model: 'claude-opus-5-5', effort: 'high', status: 'done', startedAt, endedAt: startedAt + MIN, contextTokens: 1000, contextMax: 100_000, tokens: 1000, costUsd: 0.1, steps: 1, round: 1 })
const saved = (title: string, names: string[], startedAt: number, endedAt: number): ArchiveEntry =>
  snapshot({ flow: flow(title, names), agents: names.map((n, i) => run(`${title}-${i}`, `#${i + 1} ${n}`, startedAt + i * MIN)), project: PROJECT, startedAt, endedAt, status: 'finished' })
// A flow an earlier release saved: no `day`, so it stays in the Archive as it is.
const undated = (e: ArchiveEntry): ArchiveEntry => {
  const { day: _, ...rest } = e
  return rest
}
const seeded = (list: ArchiveEntry[]): Record<string, string> => {
  const files: Record<string, string> = {}
  seed(files, DIR, list)
  return files
}
const recordOfId = (files: Record<string, string>, id: string) => (records(files, INDEX) ?? []).find((r: any) => r.id === id)

describe('the Finished tab keeps the day', () => {
  test("a flow finished earlier today stays in Finished, its rows with the shown flow's in one list, latest first; Finished (n) counts them all; the Archive does not list it", async ($, on) => {
    const env = engine(on)
    await start($)
    await flowDone($, env, 'Alpha', ['Alpha one', 'Alpha two'], ['a1', 'a2'])
    await env.step()
    await progress($, { title: 'Beta', phase: 'delegate', tasks: tasks('Beta one', 'Beta two') })
    await env.step()
    await spawn($, 'b1', '#1 Beta one')
    await env.step()
    await complete($, 'b1')
    await spawn($, 'b2', '#2 Beta two')
    const f = await look($, 'finished')
    expect(f.label('tab-finished')).toBe('Finished (3)')
    expect(f.label('tab-active')).toBe('Active (1)')
    // one list, latest completion first; the tasks numbered in the order the flows started
    const at = ['3. Beta one', '2. Alpha two', '1. Alpha one'].map(n => f.text.indexOf(n))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(f.text).not.toContain('Beta two')
    expect(f.text).not.toContain('No finished items yet')
    // the desktop draws the same rows
    const d = await look($, 'finished', 'desktop')
    expect(d.alts.filter(a => /^#\d+ (Alpha|Beta) /.test(a)).map(a => a.split(':')[0])).toEqual(['#3 Beta one', '#2 Alpha two', '#1 Alpha one'])
    // saved at once, as always, and marked with its day; the Archive lists it only once the day has passed
    const alpha = (records(env.files, INDEX) ?? []).find((r: any) => r.title === 'Alpha')
    expect(alpha).toMatchObject({ day: dayKey(NOW), pendingDay: true, itemCount: 2 })
    const a = await look($, 'archive')
    expect(a.label('tab-archive')).toBe('Archive (0)')
    expect(a.groups).toEqual([])
    expect(a.text).toContain('no archive yet')
  })

  test('a flow finished yesterday is not in Finished: it stays in the Archive as it was saved', async ($, on) => {
    const y = saved('Yesterday', ['Old one'], YESTERDAY, YESTERDAY + HOUR)
    const files = seeded([y])
    const before = files[INDEX]
    const env = engine(on, { files })
    await start($)
    await settle()
    const f = await look($, 'finished')
    expect(f.label('tab-finished')).toBe('Finished (0)')
    expect(f.text).toContain('No finished items yet')
    expect(f.text).not.toContain('Old one')
    const a = await look($, 'archive')
    expect(a.label('tab-archive')).toBe('Archive (1)')
    expect(a.groups.map((g: { key: string }) => g.key)).toEqual([`archive-${keyOf(y.id)}`])
    // the only flow of its day: nothing to merge, the index as it was
    expect(env.files[INDEX]).toBe(before)
  })

  test("the band counts the day's rows: 2 finished earlier and the 3rd of 6 running reads 3/8; two more tasks read 3/10", async ($, on) => {
    const env = engine(on)
    await start($)
    await flowDone($, env, 'Alpha', ['Alpha one', 'Alpha two'], ['a1', 'a2'])
    await env.step()
    await progress($, { title: 'Beta', phase: 'delegate', tasks: tasks('B1', 'B2', 'B3', 'B4', 'B5', 'B6') })
    await spawn($, 'b1', '#1 B1')
    let band = await bandSays($)
    expect(band).toContain('Tasks 3/8')
    expect(band).toContain('25%')
    let f = await look($, 'finished')
    expect([f.label('tab-active'), f.label('tab-finished')]).toEqual(['Active (6)', 'Finished (2)'])
    await progress($, { add: tasks('B7', 'B8') })
    band = await bandSays($)
    expect(band).toContain('Tasks 3/10')
    expect(band).toContain('20%')
    // the running task done: 3 of 10 done, nothing running
    await env.step()
    await complete($, 'b1')
    band = await bandSays($)
    expect(band).toContain('Tasks 3/10')
    expect(band).toContain('30%')
    f = await look($, 'finished')
    expect([f.label('tab-active'), f.label('tab-finished')]).toEqual(['Active (7)', 'Finished (3)'])
  })

  test("the shown flow's own saved entry is not listed twice", async ($, on) => {
    const env = engine(on)
    await start($)
    await flowDone($, env, 'Alpha', ['Alpha one', 'Alpha two'], ['a1', 'a2'])
    const f = await look($, 'finished')
    expect(f.label('tab-finished')).toBe('Finished (2)')
    expect(f.texts.filter(t => t.includes('Alpha one'))).toHaveLength(1)
    expect(f.texts.filter(t => t.includes('Alpha two'))).toHaveLength(1)
    expect(await bandSays($)).toContain('100%')
  })

  test("today's flows come from their session files, read once at the start and held; a redraw reads nothing again", async ($, on) => {
    const t1 = saved('Morning', ['M one'], NOW - 10 * HOUR, NOW - 9 * HOUR)
    const t2 = saved('Noon', ['N one', 'N two'], NOW - 8 * HOUR, NOW - 7 * HOUR)
    const env = engine(on, { files: seeded([t1, t2]) })
    await start($)
    await settle()
    const paths = [t1, t2].map(e => `${DIR}/archive/${fileOf(e)}`)
    for (const p of paths) expect(env.fs.reads).toContain(p)
    const reads = env.fs.reads.length
    const f = await look($, 'finished')
    expect(f.label('tab-finished')).toBe('Finished (3)')
    // Noon's tasks come after Morning's: Noon's #2 is task 3
    expect(f.text.indexOf('3. N two')).toBeLessThan(f.text.indexOf('2. N one'))
    expect(f.text.indexOf('2. N one')).toBeLessThan(f.text.indexOf('1. M one'))
    await look($, 'finished', 'desktop')
    expect(env.fs.reads.length).toBe(reads)
  })
})

describe('the date change', () => {
  test("at local midnight while the session runs, the day's flows leave Finished, the count and the band drop, and they become one Archive session", { timeoutMs: 15_000 }, async ($, on) => {
    const env = engine(on)
    await start($)
    await flowDone($, env, 'Alpha', ['Alpha one', 'Alpha two'], ['a1', 'a2'])
    await flowDone($, env, 'Beta', ['Beta one'], ['b1'])
    await env.step()
    await progress($, { title: 'Gamma', phase: 'delegate', tasks: tasks('G1', 'G2', 'G3') })
    await spawn($, 'c1', '#1 G1')
    await env.step()
    await complete($, 'c1')
    await spawn($, 'c2', '#2 G2')
    expect(env.at.now).toBeLessThan(MIDNIGHT)
    let f = await look($, 'finished')
    expect(f.label('tab-finished')).toBe('Finished (4)')
    let band = await bandSays($)
    expect(band).toContain('Tasks 5/6')
    const before = Object.fromEntries(sessionPaths(env.files, DIR).map(p => [p, env.files[p]]))
    const alpha = (records(env.files, INDEX) ?? []).find((r: any) => r.title === 'Alpha')
    const beta = (records(env.files, INDEX) ?? []).find((r: any) => r.title === 'Beta')

    await env.to(MIDNIGHT + 6 * SEC)
    f = await look($, 'finished')
    expect(f.label('tab-finished')).toBe('Finished (1)')
    expect(f.text).toContain('G1')
    expect(f.text).not.toMatch(/Alpha|Beta/)
    band = await bandSays($)
    expect(band).toContain('Tasks 2/3')
    expect(band).toContain('33%')
    // one session for the day: titled with its date, from the first start to the last end, every row
    const a = await look($, 'archive')
    expect(a.label('tab-archive')).toBe('Archive (1)')
    const id = dayId(dayKey(NOW), PROJECT)
    expect(a.groups.map((g: { key: string }) => g.key)).toEqual([`archive-${keyOf(id)}`])
    expect(a.groups[0].text).toMatch(/\(3\)$/)
    const day = recordOfId(env.files, id)
    expect(day).toMatchObject({ title: entryDate({ startedAt: NOW, endedAt: NOW }, undefined, true), startedAt: alpha.startedAt, endedAt: beta.endedAt, itemCount: 3, status: 'finished', day: dayKey(NOW) })
    expect(day.pendingDay).toBeUndefined()
    // the flows' own files stay where they were, unchanged; their records say where they went
    for (const [p, text] of Object.entries(before)) expect(env.files[p]).toBe(text)
    expect(recordOfId(env.files, alpha.id)).toMatchObject({ mergedInto: id })
    expect(recordOfId(env.files, beta.id)).toMatchObject({ mergedInto: id })
    expect(recordOfId(env.files, alpha.id).pendingDay).toBeUndefined()
  })

  test("a start on a later date merges each past day's flows into one session; an older flow without a day and a lone flow stay as they are; a restart lists the merged flows no more", { timeoutMs: 15_000 }, async ($, on) => {
    const y1 = saved('Y one', ['A1', 'A2'], YESTERDAY, YESTERDAY + HOUR)
    const y2 = saved('Y two', ['B1'], YESTERDAY + 2 * HOUR, YESTERDAY + 3 * HOUR)
    const old = undated(saved('Older', ['O1'], YESTERDAY + 4 * HOUR, YESTERDAY + 5 * HOUR))
    const lone = saved('Lone', ['L1'], YESTERDAY - 30 * HOUR, YESTERDAY - 29 * HOUR)
    const files = seeded([y1, y2, old, lone])
    const kept = Object.fromEntries(sessionPaths(files, DIR).map(p => [p, files[p]]))
    const oldRecord = recordOfId(files, old.id)
    const loneRecord = recordOfId(files, lone.id)
    const env = engine(on, { files })
    await start($)
    await settle()
    const id = dayId(dayKey(YESTERDAY), PROJECT)
    const a = await look($, 'archive')
    expect(a.label('tab-archive')).toBe('Archive (3)')
    expect(a.groups.map((g: { key: string }) => g.key)).toEqual([old.id, id, lone.id].map(x => `archive-${keyOf(x)}`))
    expect(recordOfId(env.files, old.id)).toEqual(oldRecord)
    expect(recordOfId(env.files, lone.id)).toEqual(loneRecord)
    const day = recordOfId(env.files, id)
    expect(day).toMatchObject({ startedAt: y1.startedAt, endedAt: y2.endedAt, itemCount: 3, taskCount: 3 })
    // its file: the flows one after another in the order they started, each run tied to its own task
    const merged = JSON.parse(env.files[`${DIR}/archive/${day.file}`]!)
    expect(merged.tasks.map((t: any) => t.title)).toEqual(['A1', 'A2', 'B1'])
    expect(merged.agents.map((r: any) => r.description)).toEqual(['#1 A1', '#2 A2', '#3 B1'])
    expect(merged.accepted).toEqual([1, 2, 3])
    expect(merged.mergedIds).toEqual([y1.id, y2.id])
    expect(Math.round(merged.cost * 100)).toBe(Math.round((y1.cost + y2.cost) * 100))
    for (const [p, text] of Object.entries(kept)) expect(env.files[p]).toBe(text)
    // opened, the session's rows carry their new numbers
    await showTab($, 'archive')
    const p = await $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
    await p.press({ key: `archive-${keyOf(id)}` })
    await p.unmount()
    expect((await look($, 'archive')).text).toContain('3. B1')
    // a restart heals against the folder: the merged flows' files are listed (marked), so none comes back
    const writes = env.fs.writes.length
    const index = env.files[INDEX]
    await start($)
    await settle()
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (3)')
    expect(env.files[INDEX]).toBe(index)
    expect(env.fs.writes.slice(writes).filter(w => w.includes('/archive/'))).toEqual([])
  })

  test('a session file that cannot be written leaves every flow as it was, and the merge is tried again later', { timeoutMs: 15_000 }, async ($, on) => {
    const y1 = saved('Y one', ['A1'], YESTERDAY, YESTERDAY + HOUR)
    const y2 = saved('Y two', ['B1'], YESTERDAY + 2 * HOUR, YESTERDAY + 3 * HOUR)
    const files = seeded([y1, y2])
    const index = files[INDEX]
    const env = engine(on, { files })
    env.fs.fail.write = (path: string) => path.includes('/archive/')
    await start($)
    await settle()
    expect(env.files[INDEX]).toBe(index)
    expect(sessionPaths(env.files, DIR)).toHaveLength(2)
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (2)')
    // the folder takes writes again: the next try, a minute on, merges them
    env.fs.fail.write = undefined
    await env.to(env.at.now + 30 * SEC)
    expect(env.files[INDEX]).toBe(index)
    await env.to(env.at.now + 35 * SEC)
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (1)')
    expect(recordOfId(env.files, y1.id)).toMatchObject({ mergedInto: dayId(dayKey(YESTERDAY), PROJECT) })
  })

  test('an index that cannot be written leaves both flows listed; the next try finds their session and only marks them', { timeoutMs: 15_000 }, async ($, on) => {
    const y1 = saved('Y one', ['A1'], YESTERDAY, YESTERDAY + HOUR)
    const y2 = saved('Y two', ['B1'], YESTERDAY + 2 * HOUR, YESTERDAY + 3 * HOUR)
    const files = seeded([y1, y2])
    const index = files[INDEX]
    const env = engine(on, { files })
    env.fs.fail.write = (path: string) => path === INDEX
    await start($)
    await settle()
    expect(env.files[INDEX]).toBe(index)
    expect(sessionPaths(env.files, DIR)).toHaveLength(3)
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (2)')
    env.fs.fail.write = undefined
    const writes = env.fs.writes.length
    await env.to(env.at.now + 65 * SEC)
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (1)')
    // no second session file for the day: the one written before is the one listed
    expect(sessionPaths(env.files, DIR)).toHaveLength(3)
    expect(env.fs.writes.slice(writes).filter(w => w.includes('/archive/'))).toEqual([])
    expect(recordOfId(env.files, y2.id)).toMatchObject({ mergedInto: dayId(dayKey(YESTERDAY), PROJECT) })
  })

  test('a damaged index rebuilt from the folder lists the merged flows again, and the next merge only marks them: still one session', { timeoutMs: 15_000 }, async ($, on) => {
    const y1 = saved('Y one', ['A1'], YESTERDAY, YESTERDAY + HOUR)
    const y2 = saved('Y two', ['B1'], YESTERDAY + 2 * HOUR, YESTERDAY + 3 * HOUR)
    const env = engine(on, { files: seeded([y1, y2]) })
    await start($)
    await settle()
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (1)')
    env.files[INDEX] = '{ not an index'
    await start($)
    await settle()
    expect((await look($, 'archive')).label('tab-archive')).toBe('Archive (1)')
    expect(sessionPaths(env.files, DIR)).toHaveLength(3)
    expect(recordOfId(env.files, y1.id)).toMatchObject({ mergedInto: dayId(dayKey(YESTERDAY), PROJECT) })
  })
})
