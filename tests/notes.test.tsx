import { describe, expect, test } from 'claude-code/testing'

import { jsonBytes, parseSession, snapshot, WRITE_MAX } from '../hooks/archive'
import { applyNotes, briefOf, cells, cleanText, fallbackBrief, NOTE_ICON, NOTE_X, noteOf, noteParts, noteRows, noteSvgBody, wrapNote } from '../hooks/notes'
import { textWidth } from '../hooks/plan-view'
import { asAgents, asFlow, asPanel } from '../hooks/shapes'
import type { AgentRun } from '../types'
import { laterDay, showTab } from './tabs'
import type { Tab } from './tabs'

const NOW = Date.UTC(2026, 9, 31, 10, 0)
const STEP_LINE = 'Before your final report, close your step list with `mcp__flowdeck__step`: every step `done` or `failed` (a skipped step too, with a note saying so); none left pending or active.'
const PROMPT = [
  '## Task',
  '',
  'Repo: /work/app (a web app, 1.2.0003, git-clean). Read README.md and docs/design.md first. Use the search tools for reading; edit with Edit/Write. Never delete files (no rm). No commit/push/tag (orchestrator does it). Comments sparingly. 24-hour time everywhere.',
  '',
  '',
  '**FEATURE**: add a **retry** button to the upload dialog.',
  '- keep the dialog width',
  '',
  STEP_LINE,
].join('\n')

describe('note texts', () => {
  test('cleanText: whitespace and control characters collapse, caps hold in characters, a cut ends in …', () => {
    expect(cleanText('  a\n\tb\u0000  c  ', 300)).toBe('a b c')
    expect(cleanText(5, 300)).toBe('')
    const long = 'word '.repeat(100)
    const cut = cleanText(long, 300)
    expect([...cut].length).toBeLessThanOrEqual(300)
    expect(cut.endsWith('…')).toBe(true)
    expect(cleanText('日本語'.repeat(200), 300)).toHaveLength(300)
    expect([...cleanText('😀'.repeat(400), 300)].length).toBe(300)
  })

  test('noteOf: only string parts, cleaned and capped; anything else is no note', () => {
    expect(noteOf(null)).toEqual({})
    expect(noteOf([1])).toEqual({})
    expect(noteOf({ goal: 7, brief: ['x'], result: '  ', feedback: { a: 1 } })).toEqual({})
    expect(noteOf({ goal: ' a\nb ', result: 'r', extra: 'x' })).toEqual({ goal: 'a b', result: 'r' })
    const n = noteOf({ goal: 'g'.repeat(900), brief: 'b '.repeat(900), result: 'r'.repeat(900), feedback: 'f'.repeat(900) })
    expect([...n.goal!].length).toBeLessThanOrEqual(300)
    expect([...n.brief!].length).toBeLessThanOrEqual(600)
    expect([...n.result!].length).toBeLessThanOrEqual(300)
    expect([...n.feedback!].length).toBeLessThanOrEqual(300)
    expect(noteParts({ feedback: 'f', goal: 'g' }).map(p => p.label)).toEqual(['Goal', 'Feedback'])
  })

  test('applyNotes: by number, a part sent replaces, empty clears, a part left out stays, unknown numbers come back', () => {
    const tasks = [{ title: 'a', goal: 'old' }, { title: 'b' }]
    const r = applyNotes(tasks, [{ task: 1, goal: 'new', result: 'did it' }, { task: 2, feedback: 'ok' }, { task: 9, goal: 'x' }, { task: 0 }, { task: 'two' }, 'junk'])
    expect(r.tasks).toEqual([{ title: 'a', goal: 'new', result: 'did it' }, { title: 'b', feedback: 'ok' }])
    expect(r.unknown).toEqual([9, 0])
    const cleared = applyNotes(r.tasks, [{ task: 1, goal: '', result: '   ' }]).tasks
    expect(cleared[0]).toEqual({ title: 'a' })
    // a brief is the mod's own: notes never set it
    expect(applyNotes(tasks, [{ task: 2, brief: 'x' }]).tasks[1]).toEqual({ title: 'b' })
    expect(applyNotes(tasks, undefined).tasks).toBe(tasks)
  })

  test('briefOf: headings, blank runs and the standard boilerplate dropped, emphasis and list marks off, the task text kept', () => {
    const b = briefOf(PROMPT)
    expect(b).toBe('FEATURE: add a retry button to the upload dialog. keep the dialog width')
    for (const gone of ['Repo:', 'search tools', 'no rm', 'commit', 'sparingly', '24-hour', 'mcp__flowdeck__step', '##', '**']) expect(b).not.toContain(gone)
    expect(briefOf(STEP_LINE)).toBe('')
    expect(briefOf(undefined)).toBe('')
    const long = briefOf(`Build the thing. ${'Then more detail follows here. '.repeat(60)}`)
    expect([...long].length).toBeLessThanOrEqual(600)
    expect(long.startsWith('Build the thing.')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
  })

  test('fallbackBrief: the description without its #n, nothing when it only repeats the title', () => {
    expect(fallbackBrief('#2 wire up the tool', 'Wire it')).toBe('wire up the tool')
    expect(fallbackBrief('#2 Wire it', 'Wire it')).toBe('')
    expect(fallbackBrief(undefined, 'x')).toBe('')
  })

  test('wrapping stays inside the width at several widths, long words broken, on both surfaces', () => {
    const text = cleanText(`${'supercalifragilisticexpialidocious'.repeat(4)} short words follow, then 長い日本語のテキストが続きます。 and more words to wrap ${'x'.repeat(80)}`, 600)
    for (const W of [240, 360, 600, 900]) {
      const d = noteSvgBody(W, noteParts({ goal: text, brief: text }))
      expect(d.lines.length).toBeGreaterThan(2)
      for (const l of d.lines) expect(textWidth(l, 11)).toBeLessThanOrEqual(W - 22 - NOTE_X)
      expect(d.body).not.toContain('NaN')
      expect(d.height).toBeGreaterThan(30)
      // every word of the text is drawn
      expect(d.lines.join('').replace(/\s/g, '')).toContain(text.replace(/\s/g, '').slice(0, 200))
    }
    for (const cols of [24, 40, 80, 120]) {
      for (const r of noteRows(noteParts({ goal: text }), cols)) expect(cells(r.text)).toBeLessThanOrEqual(cols - 1)
    }
    expect(wrapNote('', 100, s => s.length)).toEqual([])
  })
})

describe('notes in held and saved shapes', () => {
  test('a flow, run or panel held from before notes reads as no note; odd parts are dropped', () => {
    const old = { title: 'x', total: 1, done: 0, running: 0, phase: 'delegate', isFinished: false, isLinked: true, tasks: [{ title: 'a', tier: 'medium', after: [] }] }
    expect(asFlow(old)?.tasks[0]).toEqual({ title: 'a', tier: 'medium', after: [] })
    expect(asFlow({ ...old, tasks: [{ title: 'a', tier: 'medium', goal: 3, result: 'r\n r' }] })?.tasks[0]).toEqual({ title: 'a', tier: 'medium', after: [], result: 'r r' })
    expect(asAgents([{ id: 'w', status: 'done', startedAt: 1, brief: 4 }])[0]?.brief).toBeUndefined()
    expect(asPanel({}).openNotes).toEqual([])
    expect(asPanel({ openNotes: ['a', 3] }).openNotes).toEqual(['a'])
  })

  test('the archive keeps every note part and a run’s brief; an older entry reads as no note', () => {
    const flow = { title: 'F', total: 1, done: 1, running: 0, phase: 'close' as const, isFinished: true, isLinked: true, tasks: [{ title: 'a', tier: 'light', after: [], goal: 'g', brief: 'b', result: 'r', feedback: 'f' }], accepted: [1] }
    const run: AgentRun = { id: 'w', type: 'flowdeck-light', description: 'x', model: 'm', status: 'done', startedAt: NOW, endedAt: NOW + 1, contextTokens: 0, contextMax: 0, tokens: 0, costUsd: 0, steps: 0, round: 1, brief: 'run brief' }
    const e = snapshot({ flow, agents: [run], project: '', startedAt: NOW - 10, endedAt: NOW + 5, status: 'finished' })
    const back = parseSession(JSON.parse(JSON.stringify(e)))!
    expect(back.tasks[0]).toEqual({ title: 'a', tier: 'light', after: [], goal: 'g', brief: 'b', result: 'r', feedback: 'f' })
    expect(back.agents?.[0]?.brief).toBe('run brief')
    const raw = JSON.parse(JSON.stringify(e))
    raw.tasks = [{ title: 'a', tier: 'light' }]
    delete raw.agents[0].brief
    const older = parseSession(raw)!
    expect(older.tasks[0]).toEqual({ title: 'a', tier: 'light' })
    expect(older.agents?.[0]?.brief).toBeUndefined()
  })

  test('the session size guard holds: a flow at every cap, notes full of 3-byte text, stays far below a file’s limit', () => {
    const wide = (n: number) => '語'.repeat(n)
    const tasks = Array.from({ length: 150 }, (_, i) => ({ title: `${wide(300)}${i}`, tier: 'medium', after: [], goal: wide(900), brief: wide(900), result: wide(900), feedback: wide(900) }))
    const items = Array.from({ length: 20 }, (_, i) => ({ title: `${wide(100)}${i}`, status: 'done' as const, startedAt: NOW, doneAt: NOW + 1 }))
    const runs: AgentRun[] = Array.from({ length: 120 }, (_, i) => ({ id: `w${i}`, type: 'flowdeck-medium', description: wide(400), model: 'm', status: 'done', startedAt: NOW + i, endedAt: NOW + i + 1, contextTokens: 0, contextMax: 0, tokens: 0, costUsd: 0, steps: 0, round: 1, items, stepNote: wide(400), brief: wide(2000) }))
    const flow = { title: wide(400), total: 150, done: 0, running: 0, phase: 'delegate' as const, isFinished: false, isLinked: true, tasks }
    const e = snapshot({ flow, agents: runs, project: '/work', startedAt: NOW, endedAt: NOW + 9, status: 'open' })
    expect(e.tasks).toHaveLength(100)
    expect(e.agents).toHaveLength(60)
    expect([...e.tasks[0]!.brief!].length).toBeLessThanOrEqual(600)
    expect([...e.agents![0]!.brief!].length).toBeLessThanOrEqual(600)
    expect(jsonBytes(e)).toBeLessThan(WRITE_MAX / 3)
  })
})

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store: Record<string, unknown> = opts.store ?? {}
  const clock = { now: NOW }
  const registered: any[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', (_$: any, e: any) => {
    registered.push(e)
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
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { clock, registered }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const progress = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)).result)
const spawn = ($: any, id: string, description: string, prompt?: string) => $.agent.spawn({ subagentType: 'flowdeck-medium', description, tool_use_id: id, ...(prompt === undefined ? {} : { prompt }) } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)
const mount = ($: any, surface: 'terminal' | 'desktop', cols = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: cols } } as any)
// One tab's Texts, Buttons and Svgs on a surface.
async function look($: any, tab: Tab, surface: 'terminal' | 'desktop' = 'terminal', cols = 80) {
  await showTab($, tab)
  const p = await mount($, surface, cols)
  const texts = (await p.findAll({ type: 'Text' })).map((x: any) => x.text)
  const buttons = await p.findAll({ type: 'Button' })
  const svgs = surface === 'desktop' ? await p.findAll({ type: 'Svg' }) : []
  await p.unmount()
  return { text: texts.join('\n'), keys: buttons.map((b: any) => String(b.props.key)), buttons, svgs }
}
async function press($: any, tab: Tab, key: string, surface: 'terminal' | 'desktop' = 'terminal') {
  await showTab($, tab)
  const p = await mount($, surface)
  await p.press({ key })
  await p.unmount()
}
const noteKeys = (keys: string[]) => keys.filter(k => /(^|-)note-/.test(k))

const PLAN = [
  { title: 'Read code', tier: 'light', goal: 'Find where uploads fail.' },
  { title: 'Wire it', tier: 'medium', goal: 'Add a retry button to the upload dialog.', after: [1] },
  { title: 'Docs', tier: 'light' },
]

describe('the progress tool takes notes', () => {
  test('goal on tasks and add is stored, cleaned and capped; the schema and description say the rule', async ($, on) => {
    const { registered } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [...PLAN.slice(0, 2), { title: 'Docs', tier: 'light', goal: `  ${'long goal text '.repeat(40)}` }] })
    await progress($, { add: [{ title: 'Polish', tier: 'light', goal: 'Tidy\nthe   copy.' }, { title: 'Bare', tier: 'light' }] })
    let t = await look($, 'active')
    expect(noteKeys(t.keys)).toEqual(['note-task-1', 'note-task-2', 'note-task-3', 'note-task-4'])
    for (const n of [3, 4]) await press($, 'active', `note-task-${n}`)
    t = await look($, 'active')
    const goal = t.text.split('\n').find(l => l.startsWith('   long goal'))!
    expect(t.text).toContain('   Tidy the copy.')
    expect(t.text.match(/^ {3}Goal$/gm)).toHaveLength(2)
    // the capped goal, wrapped: its lines hold at most 300 characters and end in …
    const lines = t.text.split('\n')
    const from = lines.indexOf(goal)
    const goalText = lines.slice(from, lines.indexOf('   Goal', from) > 0 ? lines.indexOf('   Goal', from) : from + 6).filter(l => l.startsWith('   ') && !/^ {3}(Goal|5\.)/.test(l)).map(l => l.trim()).join(' ')
    expect(goalText.length).toBeLessThanOrEqual(300)
    expect(goalText).toContain('…')
    const schema = registered.find(r => r.name === 'progress')
    expect(schema.inputSchema.properties.tasks.items.properties.goal.type).toBe('string')
    expect(schema.inputSchema.properties.add.items.properties.goal.type).toBe('string')
    expect(Object.keys(schema.inputSchema.properties.notes.items.properties).sort()).toEqual(['feedback', 'goal', 'result', 'task'])
    for (const word of ['goal', 'result', 'feedback', 'brief']) expect(schema.description).toContain(word)
  })

  test('notes by number replace, clear and keep; unknown numbers are ignored with a short line; done goes with them', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    expect(await progress($, { notes: [{ task: 3, goal: 'Explain the retry.' }, { task: 7, result: 'x' }] })).toBe('ok: Tasks 0/3\nnotes ignored for unknown tasks: 7')
    expect(await progress($, { notes: [{ task: 1, goal: '' }] })).toBe('ok: Tasks 0/3')
    let t = await look($, 'active')
    expect(noteKeys(t.keys)).toEqual(['note-task-2', 'note-task-3'])
    // accepted with its result and feedback in one call
    expect(await progress($, { done: [2], notes: [{ task: 2, result: 'Retry button added.', feedback: 'Checked both surfaces; copy needs review.' }] })).toBe('ok: Tasks 1/3')
    await press($, 'finished', 'note-task-2')
    t = await look($, 'finished')
    expect(t.text).toMatch(/ {3}Goal\n {3}Add a retry button to the upload dialog\.\n {3}Result\n {3}Retry button added\.\n {3}Feedback\n {3}Checked both surfaces; copy needs review\./)
    // a part left out stays, one sent again replaces it
    await progress($, { notes: [{ task: 2, feedback: 'Copy reviewed.' }] })
    t = await look($, 'finished')
    expect(t.text).toContain('   Retry button added.')
    expect(t.text).toContain('   Copy reviewed.')
    expect(t.text).not.toContain('copy needs review')
  })

  test('a finished flow takes no notes and says so', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    await progress($, { finished: true, notes: [{ task: 1, result: 'done' }] })
    expect(await progress($, { notes: [{ task: 1, feedback: 'late' }] })).toBe('ok: Done\nnotes ignored: the flow is finished')
  })
})

describe('the brief from the delegation prompt', () => {
  test('taken when the worker starts and is linked: boilerplate gone, the task text kept; a return round replaces it until accepted', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    await spawn($, 'w2', '#2 Wire it', PROMPT)
    await press($, 'active', 'note-w2')
    let t = await look($, 'active')
    expect(t.text).toContain('   Brief\n   FEATURE: add a retry button to the upload dialog. keep the dialog width')
    expect(t.text).not.toContain('search tools')
    clock.now = NOW + 60_000
    await complete($, 'w2')
    clock.now = NOW + 70_000
    await spawn($, 'w2b', '#2 Wire it', 'Fix the two defects: the button is unlabeled.')
    await press($, 'active', 'note-w2b') // each row opens on its own
    t = await look($, 'active')
    expect(t.text).toContain('   Fix the two defects: the button is unlabeled.')
    clock.now = NOW + 80_000
    await complete($, 'w2b')
    await progress($, { done: [2] })
    clock.now = NOW + 90_000
    await spawn($, 'w2c', '#2 Wire it', 'A third prompt after acceptance.')
    t = await look($, 'finished')
    expect(t.text).toContain('   Fix the two defects: the button is unlabeled.')
    expect(t.text).not.toContain('A third prompt')
  })

  test('without a prompt the description stands in, unless it is the title; a run linked to no task keeps its own brief', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Read code', tier: 'light' }, { title: 'Wire it', tier: 'medium' }, { title: 'Docs', tier: 'medium' }] })
    await spawn($, 'w1', '#1 Read code')
    await spawn($, 'w2', '#2 wire up the retry')
    await spawn($, 'w9', 'Unrelated chore', 'Look at the logs of the nightly job.')
    const t = await look($, 'active')
    expect(noteKeys(t.keys).sort()).toEqual(['note-w2', 'note-w9'])
    await press($, 'active', 'note-w2')
    await press($, 'active', 'note-w9')
    const o = await look($, 'active')
    expect(o.text).toContain('   Brief\n   wire up the retry')
    expect(o.text).toContain('   Brief\n   Look at the logs of the nightly job.')
  })
})

describe('the note button and panel', () => {
  test('only rows with a note have the button, on queued, running, finished and accepted rows of both surfaces', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [...PLAN, { title: 'Lone', tier: 'heavy', goal: 'Done by hand.' }] })
    await spawn($, 'w1', '#1 Read code')
    clock.now = NOW + 30_000
    await complete($, 'w1')
    await spawn($, 'w2', '#2 Wire it')
    await progress($, { done: [4] })
    for (const surface of ['terminal', 'desktop'] as const) {
      const a = await look($, 'active', surface)
      expect(noteKeys(a.keys)).toEqual(['note-w2']) // task 3 has no note
      const f = await look($, 'finished', surface)
      expect(noteKeys(f.keys).sort()).toEqual(['note-task-4', 'note-w1'])
      for (const b of [...a.buttons, ...f.buttons].filter((x: any) => /note-/.test(String(x.props.key)))) {
        expect(b.props.label).toBe(NOTE_ICON)
        expect(b.props.plain).toBe(true)
        expect(b.props.dimColor).toBe(true)
      }
      expect(new Set([...a.keys]).size).toBe(a.keys.length)
    }
    // the terminal row: the button right after the name, before the state glyph
    await showTab($, 'finished')
    const p = await mount($, 'terminal')
    const tree = JSON.stringify(await p.drawn())
    await p.unmount()
    const at = (s: string) => tree.indexOf(s)
    expect(at('"note-w1"')).toBeGreaterThan(at('1. Read code'))
  })

  test('the icon is the circled i', () => {
    expect(NOTE_ICON).toBe('ⓘ')
  })

  test('an opened note sits under the title, before the worker line, the bar and the steps, on both surfaces', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Alpha', tier: 'light', goal: 'Qgoal alpha.' }, { title: 'Beta', tier: 'medium', goal: 'Qgoal beta.' }, { title: 'Gamma', tier: 'heavy', goal: 'Qgoal gamma.' }, { title: 'Delta', tier: 'heavy', goal: 'Qgoal delta.' }] })
    await spawn($, 'w2', '#2 Beta')
    clock.now = NOW + 30_000
    await complete($, 'w2')
    await spawn($, 'w3', '#3 Gamma')
    await progress($, { done: [4] })
    const order = async (tab: Tab, surface: 'terminal' | 'desktop', keys: string[], marks: string[][]) => {
      await showTab($, tab)
      for (const k of keys) {
        const q = await mount($, surface)
        await q.press({ key: k })
        await q.unmount()
      }
      const p = await mount($, surface)
      const tree = JSON.stringify(await p.drawn())
      await p.unmount()
      for (const [title, note, worker] of marks) {
        const t = tree.indexOf(title!)
        const n = tree.indexOf(note!)
        const w = tree.indexOf(worker!, n)
        if (t < 0 || n < t || w < n) throw new Error(`${surface} ${tab} ${title} ${t}/${n}/${w}`)
      }
    }
    await order('active', 'terminal', ['note-w3', 'note-task-1'], [['Gamma', 'Qgoal gamma', 'medium ·'], ['Alpha', 'Qgoal alpha', 'light']])
    await order('finished', 'terminal', ['note-w2', 'note-task-4'], [['Beta', 'Qgoal beta', 'medium'], ['Delta', 'Qgoal delta', 'heavy']])
    // the open state is shared by both surfaces, so the desktop draws the notes the terminal opened
    await order('active', 'desktop', [],[['Gamma', 'Qgoal gamma', 'Opus 5.5'], ['Alpha', 'Qgoal alpha', 'light']])
    await order('finished', 'desktop', [],[['Beta', 'Qgoal beta', 'Opus 5.5'], ['Delta', 'Qgoal delta', 'heavy']])
  })

  test('pressing toggles the panel; the open state survives a redraw and a reload', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: PLAN })
    expect((await look($, 'active')).text).not.toMatch(/^ {3}Goal$/m)
    await press($, 'active', 'note-task-1')
    expect((await look($, 'active')).text).toMatch(/^ {3}Goal\n {3}Find where uploads fail\.$/m)
    await start($) // /reload-plugins runs session.start again; the held values stay
    expect((await look($, 'active')).text).toMatch(/^ {3}Goal\n {3}Find where uploads fail\.$/m)
    await press($, 'active', 'note-task-1')
    expect((await look($, 'active')).text).not.toMatch(/^ {3}Goal$/m)
  })

  test('desktop: a task row with a note draws its title natively with the button, and the open note as one drawing inside the width', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'Wire it', tier: 'medium', goal: `Add a retry button. ${'Keep the dialog as wide as it is now and the copy short. '.repeat(4)}` }, { title: 'Docs', tier: 'light' }] })
    await press($, 'active', 'note-task-1', 'desktop')
    for (const cols of [31, 46, 120]) {
      const d = await look($, 'active', 'desktop', cols)
      const W = Math.max(240, Math.min(900, cols * 8 - 8))
      const planned = d.svgs.find((s: any) => /^1\. Wire it: planned$/.test(String(s.props.alt)))
      expect(String(planned.props.source)).not.toContain('>1. Wire it<')
      expect(planned.props.height).toBe(32)
      // the row without a note is the one drawing it was, its title inside
      const plain = d.svgs.find((s: any) => /^2\. Docs: planned$/.test(String(s.props.alt)))
      expect(String(plain.props.source)).toContain('>2. Docs</text>')
      expect(plain.props.height).toBe(46)
      const note = d.svgs.find((s: any) => /^Goal: Add a retry button/.test(String(s.props.alt)))
      expect(note.props.width).toBe(W)
      const src = String(note.props.source)
      expect(src).not.toContain('NaN')
      const lines = [...src.matchAll(/<text class="t"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]!)
      expect(lines.length).toBeGreaterThan(1)
      for (const l of lines) expect(textWidth(l, 11)).toBeLessThanOrEqual(W - 22 - NOTE_X)
      expect(d.keys).toContain('note-task-1')
    }
  })

  test('an archived flow’s rows have the button and open by their own state, apart from the live rows', async ($, on) => {
    const base = { agentId: 'a1', type: 'flowdeck-medium', model: 'claude-opus-5-5', startedAt: NOW - 600_000, endedAt: NOW - 300_000, contextTokens: 0, contextMax: 1_000_000, tokens: 10, costUsd: 0.1, steps: 1, round: 1, status: 'done' as const }
    const runs: AgentRun[] = [{ ...base, id: 'a1', description: '#1 Wire it' }]
    const flow = { title: 'Old', total: 2, done: 2, running: 0, phase: 'close' as const, isFinished: true, isLinked: true, accepted: [1, 2], tasks: [{ title: 'Wire it', tier: 'medium', after: [], goal: 'Add retry.', result: 'Added.' }, { title: 'Docs', tier: 'light', after: [], feedback: 'Fine.' }, { title: 'Bare', tier: 'light', after: [] }] }
    const entry = { ...snapshot({ flow: { ...flow, accepted: [1, 2, 3] }, agents: runs, project: '', startedAt: NOW - 700_000, endedAt: NOW - 200_000, status: 'finished' }), id: 'g1' }
    engine(on, { store: { history: [entry] } })
    laterDay(on) // the flows finished today are looked at in the Archive as on a later day (tabs.ts)
    await start($)
    await settle()
    const a = await look($, 'archive')
    const keys = noteKeys(a.keys)
    expect(keys).toHaveLength(2)
    expect(keys.every(k => /^archive-k[a-z0-9]+-note-(a1|task-2)$/.test(k))).toBe(true)
    await press($, 'archive', keys.find(k => k.endsWith('note-task-2'))!)
    const o = await look($, 'archive')
    expect(o.text).toContain('   Feedback\n   Fine.')
    expect(o.text).not.toContain('   Added.')
    await press($, 'archive', keys.find(k => k.endsWith('note-a1'))!)
    expect((await look($, 'archive')).text).toContain('   Goal\n   Add retry.\n   Result\n   Added.')
    for (const surface of ['terminal', 'desktop'] as const) {
      await showTab($, 'archive')
      const p = await mount($, surface)
      const tree = JSON.stringify(await p.drawn())
      await p.unmount()
      // the group is open here: the Wire it row's note sits before its worker line
      const n = tree.indexOf('Add retry.')
      const w = tree.indexOf(surface === 'terminal' ? 'medium' : 'Opus 5.5', n)
      if (n < 0 || w < n || tree.indexOf('Wire it') > n) throw new Error(`${surface} ${tree.indexOf('Wire it')}/${n}/${w}`)
    }
  })
})

describe('the rule for the model', () => {
  test('the flow rule names goal, result and feedback within its length; the progress tool says where the brief comes from', async ($, on) => {
    const { registered } = engine(on, { store: { rule: 'on' } })
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
    const rule = r.sections.find((s: any) => s.id === 'flowdeck:flow-rule')
    for (const word of ['goal', 'result', 'feedback', 'notes [{task, result, feedback}]']) expect(rule.text).toContain(word)
    expect(rule.text.length).toBeLessThan(760)
    const tool = registered.find(t => t.name === 'progress')
    for (const word of ['brief', 'Agent prompt']) expect(tool.description).toContain(word)
  })
})
