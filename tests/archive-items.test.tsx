import { describe, expect, test } from 'claude-code/testing'

import { fakeFs } from './fake-fs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const DIR = '/work/app/.claude/flowdeck'
const HISTORY = `${DIR}/history.json`
const SIDE = `${DIR}/history-extra-${NOW}.json`
const ID = `${NOW}-/work/app`

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store = opts.store ?? {}
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
const pane = ($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
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
const terminal = async ($: any, cols = 80) => {
  const p = await pane($, 'terminal', cols)
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { text: texts.map((t: any) => t.text).join('\n'), texts, buttons }
}
const desktop = async ($: any, cols = 80) => {
  const p = await pane($, 'desktop', cols)
  const svgs = await p.findAll({ type: 'Svg' })
  const buttons = await p.findAll({ type: 'Button' })
  const drawn = JSON.stringify(await p.drawn())
  await p.unmount()
  return { svgs, buttons, drawn, alts: svgs.map((s: any) => String(s.props.alt ?? '')) }
}
// The live rows the desktop draws, by description.
const desktopRows = (d: { alts: string[] }) => d.alts.filter(a => /^task \d+: /.test(a)).map(a => a.split(':')[0])
const press = async ($: any, key: string, surface: 'terminal' | 'desktop' = 'terminal') => {
  const p = await pane($, surface)
  await p.press({ key })
  await settle()
  await p.unmount()
}
const entries = (files: Record<string, string>): any[] => JSON.parse(files[HISTORY] ?? '[]')
const ids = (e: any): string[] => (e?.agents ?? []).map((a: any) => a.id).sort()

describe('archiving finished items of the live flow', () => {
  test('pressing the 2nd row of the newest-first list archives it and every older one, the newest stays', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    let d = await desktop($)
    expect(desktopRows(d)).toEqual(['task 4', 'task 3', 'task 2', 'task 1'])
    expect(archiveKeys(d.buttons)).toEqual(['archive-item-w4', 'archive-item-w3', 'archive-item-w2', 'archive-item-w1'])
    await press($, 'archive-item-w3', 'desktop')
    d = await desktop($)
    expect(desktopRows(d)).toEqual(['task 4'])
    expect(archiveKeys(d.buttons)).toEqual(['archive-item-w4'])
    const t = await terminal($)
    expect(t.text).toContain('task 4')
    expect(t.text).not.toMatch(/task [123]\b/)
    expect(ids(entries(files)[0])).toEqual(['w1', 'w2', 'w3'])
  })

  test('pressing the newest row archives all four', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    await press($, 'archive-item-w4')
    expect(desktopRows(await desktop($))).toEqual([])
    expect(ids(entries(files)[0])).toEqual(['w1', 'w2', 'w3', 'w4'])
  })

  test('pressing the oldest row archives only it; a second press on it does nothing', async ($, on) => {
    const { files, fs, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    const p = await pane($)
    await p.press({ key: 'archive-item-w1' })
    await settle()
    expect(desktopRows(await desktop($))).toEqual(['task 4', 'task 3', 'task 2'])
    expect(ids(entries(files)[0])).toEqual(['w1'])
    const writes = fs.writes.length
    const before = files[HISTORY]
    clock.now = NOW + 180_000
    await p.press({ key: 'archive-item-w1' }).catch(() => {})
    await settle()
    await p.unmount()
    expect(fs.writes.length).toBe(writes)
    expect(files[HISTORY]).toBe(before)
    expect(desktopRows(await desktop($))).toEqual(['task 4', 'task 3', 'task 2'])
  })

  test('failed rows count as finished and are archived the same way', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3, [2])
    await press($, 'archive-item-w2')
    expect(desktopRows(await desktop($))).toEqual(['task 3'])
    const e = entries(files)[0]
    expect(ids(e)).toEqual(['w1', 'w2'])
    expect(e.agents.find((a: any) => a.id === 'w2').status).toBe('failed')
  })

  test('running and planned rows have no Archive button, and a running row is never swept', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    clock.now = NOW + 130_000
    await spawn($, 'w9', 'still going')
    await turnStep($, 'w9')
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const keys = archiveKeys(await p.findAll({ type: 'Button' }))
      await p.unmount()
      expect(keys).toEqual(['archive-item-w2', 'archive-item-w1'])
    }
    await press($, 'archive-item-w2')
    expect(ids(entries(files)[0])).toEqual(['w1', 'w2'])
    const t = await terminal($)
    expect(t.text).toContain('still going')
    expect(t.text).toContain('never started')
    expect(t.text).toMatch(/Running · 1/)
  })

  test('the Finished label counts only the rows left, with a dim · M archived', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    let t = await terminal($)
    expect(String(t.buttons.find((b: any) => String(b.props.key) === 'done')?.props.label)).toBe('▾ Finished · 4')
    expect(t.text).not.toContain('archived')
    await press($, 'archive-item-w2')
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const done = await p.find({ type: 'Button', key: 'done' })
      const dim = await p.find({ type: 'Text', text: /· 2 archived/ })
      await p.unmount()
      expect(JSON.stringify(done)).toContain('▾ Finished · 2')
      expect(JSON.stringify(done)).toContain(' · 2 archived')
      expect(dim?.props.dimColor).toBe(true)
    }
    await press($, 'archive-item-w4')
    t = await terminal($)
    const done = t.buttons.find((b: any) => String(b.props.key) === 'done')
    expect(JSON.stringify(done)).toContain('Finished · 0')
    expect(JSON.stringify(done)).toContain(' · 4 archived')
    expect(t.text).not.toMatch(/task \d/)
  })

  test('the header tiles still count the archived rows; planned tasks with archived runs stay started', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    const header = (s: string) => s.split('\n').find(l => /^≈\$/.test(l))
    const before = await terminal($)
    const d0 = await desktop($)
    expect(before.text).not.toMatch(/\d\. task 1/) // never shown as planned: it has a run
    await press($, 'archive-item-w2')
    const after = await terminal($)
    const d1 = await desktop($)
    expect(header(after.text)).toBe(header(before.text))
    expect(header(after.text)).toContain('≈$0.80')
    expect(d1.alts.find(a => a.startsWith('Ship it:'))).toBe(d0.alts.find(a => a.startsWith('Ship it:')))
    expect(after.text).toContain('2. never started')
    expect(after.text).not.toMatch(/\d\. task [12]/)
  })
})

describe('the partial archive entry', () => {
  test('is saved with only the archived agents, partial and open, in history.json and the side file', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    await press($, 'archive-item-w2')
    const list = entries(files)
    expect(list.length).toBe(1)
    const e = list[0]
    expect(e.id).toBe(ID)
    expect(e.partial).toBe(true)
    expect(e.status).toBe('open')
    expect(e.title).toBe('Ship it')
    expect(e.done).toBe(1)
    expect(e.total).toBe(3)
    expect(e.tasks.map((t: any) => t.title)).toEqual(['task 1', 'never started', 'task 2'])
    expect(ids(e)).toEqual(['w1', 'w2'])
    expect(Math.round(e.cost * 100)).toBe(80)
    expect(e.tokens).toBe(200_000)
    expect(e.agents[0]).toMatchObject({ type: 'flowdeck-light', model: 'claude-opus-5-5', status: 'done', tokens: 100_000 })
    expect('archived' in e.agents[0]).toBe(false)
    const side = JSON.parse(files[SIDE]!)
    expect(side.length).toBe(1)
    expect(side[0].partial).toBe(true)
    expect(ids(side[0])).toEqual(['w1', 'w2'])
  })

  test('the Archive section shows it at the top as archived while the flow runs', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    await press($, 'archive')
    await press($, 'archive-item-w1')
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const groups = await p.findAll({ type: 'Button', text: /^▾ .* · 1 item · running$/ })
      expect(groups.length).toBe(1)
      expect(await p.find({ type: 'Text', text: /1\/3|archived while the flow runs|ended with the session/ })).toBeUndefined()
      const buttons = await p.findAll({ type: 'Button' })
      // inside the group the archived row has no Archive button
      expect(archiveKeys(buttons)).toEqual(['archive-item-w3', 'archive-item-w2'])
      expect(buttons.some((b: any) => String(b.props.key) === `archive-finished-${ID}`)).toBe(false)
      await p.unmount()
    }
  })

  test('archiving more later grows the same entry, never a second one', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    await press($, 'archive-item-w2')
    clock.now = NOW + 200_000
    await press($, 'archive-item-w4')
    const list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(ID)
    expect(list[0].partial).toBe(true)
    expect(ids(list[0])).toEqual(['w1', 'w2', 'w3', 'w4'])
    expect(list[0].endedAt).toBe(NOW + 200_000)
    expect(ids(JSON.parse(files[SIDE]!)[0])).toEqual(['w1', 'w2', 'w3', 'w4'])
    expect(Object.keys(files).filter(f => f.includes('history-extra-')).length).toBe(1)
  })

  test('finishing the flow replaces it with the full entry: all agents, no partial, one entry', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    clock.now = NOW + 125_000
    await spawn($, 'w5', 'late one')
    await press($, 'archive-item-w3')
    clock.now = NOW + 300_000
    await progress($, { finished: true })
    const list = entries(files)
    expect(list.length).toBe(1)
    const e = list[0]
    expect(e.id).toBe(ID)
    expect(e.status).toBe('finished')
    expect('partial' in e).toBe(false)
    expect(ids(e)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(e.agents.find((a: any) => a.id === 'w1')).toMatchObject({ status: 'done', tokens: 100_000, description: 'task 1' })
    expect(Math.round(e.cost * 100)).toBe(160)
    const side = JSON.parse(files[SIDE]!)
    expect('partial' in side[0]).toBe(false)
    expect(ids(side[0])).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
  })

  test('the final entry wins even when the clock has not moved since the partial one', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    await press($, 'archive-item-w1')
    await progress($, { finished: true })
    const list = entries(files)
    expect(list.length).toBe(1)
    expect('partial' in list[0]).toBe(false)
    expect(ids(list[0])).toEqual(['w1', 'w2'])
    expect('partial' in JSON.parse(files[SIDE]!)[0]).toBe(false)
  })

  test('a restart replaces it the same way', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    await press($, 'archive-item-w2')
    clock.now = NOW + 300_000
    await progress($, { restart: true, title: 'Next', total: 1, tasks: [{ title: 'z', tier: 'light' }] })
    const list = entries(files).filter((x: any) => x.id === ID)
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('finished')
    expect('partial' in list[0]).toBe(false)
    expect(ids(list[0])).toEqual(['w1', 'w2', 'w3'])
    // the new flow starts with a clean list
    expect(archiveKeys((await terminal($)).buttons)).toEqual([])
  })

  test('the session ending replaces it with the open full entry', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    await press($, 'archive-item-w2')
    clock.now = NOW + 300_000
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    const list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('open')
    expect('partial' in list[0]).toBe(false)
    expect(ids(list[0])).toEqual(['w1', 'w2', 'w3'])
  })

  test('a reload of the folder keeps partial on the entry', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    await press($, 'archive-item-w1')
    await start($)
    await settle()
    await press($, 'archive')
    const p = await pane($)
    expect(await p.find({ type: 'Button', text: / · running$/ })).toBeDefined()
    await p.unmount()
  })
})

describe('safety of an archive press', () => {
  test('when every write fails the rows stay in the live list and nothing throws', async ($, on) => {
    const { files, fs, fail, store, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    fs.fail.write = true
    fail.store = true
    const p = await pane($)
    await p.press({ key: 'archive-item-w2' })
    await settle()
    await p.unmount()
    expect(desktopRows(await desktop($))).toEqual(['task 3', 'task 2', 'task 1'])
    expect(files[HISTORY]).toBeUndefined()
    expect(store.history).toBeUndefined()
    const t = await terminal($)
    expect(t.text).not.toContain('archived')
    expect(archiveKeys(t.buttons)).toEqual(['archive-item-w3', 'archive-item-w2', 'archive-item-w1'])
  })

  test('a save that falls back to the store counts as saved', async ($, on) => {
    const { files, fs, store, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    fs.fail.write = true
    await press($, 'archive-item-w2')
    expect(files[HISTORY]).toBeUndefined()
    const saved = (store.history as any[]) ?? []
    expect(saved.length).toBe(1)
    expect(saved[0].partial).toBe(true)
    expect(ids(saved[0])).toEqual(['w1', 'w2'])
    expect(desktopRows(await desktop($))).toEqual(['task 3'])
  })

  test('the side file alone counts as saved when history.json cannot be read', async ($, on) => {
    const { files, fs, fail, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    files[HISTORY] = '[]'
    fs.unreadable.add(HISTORY)
    fail.store = true
    await press($, 'archive-item-w2')
    expect(files[HISTORY]).toBe('[]')
    expect(JSON.parse(files[SIDE]!)[0].partial).toBe(true)
    expect(desktopRows(await desktop($))).toEqual([])
  })

  test('the flow being finished meanwhile is never overwritten by the partial entry', async ($, on) => {
    const { files, fs, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    let release: () => void = () => {}
    let held = false
    fs.delay = op => {
      if (op !== 'write' || held) return
      held = true
      return new Promise<void>(done => (release = done))
    }
    const p = await pane($)
    const pressed = p.press({ key: 'archive-item-w2' })
    await settle()
    clock.now = NOW + 300_000
    const finished = progress($, { finished: true })
    await settle()
    release()
    await pressed
    await finished
    await settle()
    await p.unmount()
    const list = entries(files)
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('finished')
    expect('partial' in list[0]).toBe(false)
    expect(ids(list[0])).toEqual(['w1', 'w2', 'w3'])
    expect('partial' in JSON.parse(files[SIDE]!)[0]).toBe(false)
  })

  test('archiving never deletes or empties a file', async ($, on) => {
    const { files, fs, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3)
    await press($, 'archive-item-w1')
    const names = Object.keys(files)
    clock.now = NOW + 200_000
    await press($, 'archive-item-w3')
    for (const n of names) expect(files[n]!.length).toBeGreaterThan(0)
    expect(fs.writes.every(w => w.startsWith(DIR))).toBe(true)
  })
})

describe('where the Archive button shows', () => {
  test('not in compact mode', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      await p.press({ key: 'compact' })
      await settle()
      expect(archiveKeys(await p.findAll({ type: 'Button' }))).toEqual([])
      await p.press({ key: 'compact' })
      await settle()
      expect(archiveKeys(await p.findAll({ type: 'Button' })).length).toBe(2)
      await p.unmount()
    }
  })

  test('not once the flow is finished, and not without a flow', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await finishedRows($, clock, 1)
    expect(archiveKeys((await terminal($)).buttons)).toEqual([])
    clock.now = NOW
    await plan($)
    await finishedRows($, clock, 2)
    expect(archiveKeys((await terminal($)).buttons)).toEqual(['archive-item-w2', 'archive-item-w1'])
    await progress($, { finished: true })
    expect(archiveKeys((await terminal($)).buttons)).toEqual([])
    expect(archiveKeys((await desktop($)).buttons)).toEqual([])
  })

  test('a row that runs again leaves the archived state and shows as running', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    await press($, 'archive-item-w1')
    await turnStep($, 'w1')
    let t = await terminal($)
    expect(t.text).toMatch(/Running · 1/)
    expect(t.text).toContain('task 1')
    await complete($, 'w1')
    t = await terminal($)
    expect(archiveKeys(t.buttons)).toEqual(['archive-item-w2', 'archive-item-w1'])
  })

  test('30 rows: pressing the 10th newest archives 21, keeps 9', async ($, on) => {
    const { files, clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 30)
    // newest first: w30 … w1, so the 10th is w21
    await press($, 'archive-item-w21')
    const d = await desktop($)
    expect(desktopRows(d).length).toBe(9)
    expect(desktopRows(d)[8]).toBe('task 22')
    expect(entries(files)[0].agents.length).toBe(21)
    const t = await terminal($)
    expect(JSON.stringify(t.buttons.find((b: any) => String(b.props.key) === 'done'))).toContain(' · 21 archived')
  })

  test('no NaN and no row wider than the pane at 240, 360 and 900 px and 24..80 columns', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 3, [], () => $.tool.call({ tool: 'mcp__flowdeck__step', agentId: 'w2', steps: [{ title: 'one' }, { title: 'two' }] } as any))
    for (const [cols, W] of [[31, 240], [46, 360], [120, 900]] as const) {
      const d = await desktop($, cols)
      expect(d.drawn).not.toContain('NaN')
      for (const s of d.svgs) {
        const w = Number(s.props.width)
        expect(Number.isFinite(w)).toBe(true)
        expect(w).toBeGreaterThan(0)
        expect(w).toBeLessThanOrEqual(W)
        expect(String(s.props.source)).not.toContain('NaN')
      }
      // the archive icon and the chevron share one 28 px column on the right
      const row = (n: number) => d.svgs.find((s: any) => String(s.props.alt).startsWith(`task ${n}:`))
      expect(Number(row(1).props.width)).toBe(W - 28)
      expect(Number(row(2).props.width)).toBe(W - 28)
      expect(archiveKeys(d.buttons).length).toBe(3)
    }
    for (let cols = 24; cols <= 80; cols += 4) {
      const t = await terminal($, cols)
      expect(t.text).not.toContain('NaN')
      expect(t.text).not.toContain('undefined')
      expect(archiveKeys(t.buttons).length).toBe(3)
    }
  })

  test('the button keys never collide with any other key in the pane', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 4)
    await press($, 'archive')
    await press($, 'archive-item-w2')
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const keys = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))
      await p.unmount()
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.filter(k => k.startsWith('archive-item-'))).toEqual(['archive-item-w4', 'archive-item-w3'])
    }
  })
})

describe('the small archive icon', () => {
  const ICON = '⤓'
  const kids = (n: any): any[] => (Array.isArray(n?.children) ? n.children : Array.isArray(n?.props?.children) ? n.props.children : []).filter((c: any) => c && typeof c === 'object')
  const walk = (n: any, out: any[] = []): any[] => {
    if (!n || typeof n !== 'object') return out
    out.push(n)
    for (const c of kids(n)) walk(c, out)
    return out
  }
  const keyOf = (n: any) => String(n?.props?.key ?? n?.key ?? '')
  // the innermost Box that directly holds the Button with this key
  const holder = (root: any, key: string) => walk(root).find(n => kids(n).some(c => keyOf(c) === key))
  const one = (s: string) => [...new (Intl as any).Segmenter().segment(s)].length === 1

  test('the label is one narrow glyph, never the word Archive, on both surfaces', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const b = await p.find({ type: 'Button', key: 'archive-item-w1' })
      await p.unmount()
      const label = String(b.props.label)
      expect(label).toBe(ICON)
      expect(one(label)).toBe(true)
      expect(label).not.toMatch(/Archive/)
      expect(b.props.plain).toBe(true)
      expect(b.props.dimColor).toBe(true)
    }
  })

  test('desktop: one 28 px column, the icon above the chevron; rows with neither keep the full width', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2, [], () => $.tool.call({ tool: 'mcp__flowdeck__step', agentId: 'w2', steps: [{ title: 'one' }, { title: 'two' }] } as any))
    clock.now = NOW + 130_000
    await spawn($, 'w9', 'still going')
    await turnStep($, 'w9')
    for (const [cols, W] of [[31, 240], [46, 360], [120, 900]] as const) {
      const p = await pane($, 'desktop', cols)
      const svgs = await p.findAll({ type: 'Svg' })
      const root = await p.drawn()
      await p.unmount()
      const row = (name: string) => svgs.find((s: any) => String(s.props.alt).startsWith(`${name}:`))
      expect(Number(row('task 1').props.width)).toBe(W - 28)
      expect(Number(row('task 2').props.width)).toBe(W - 28)
      expect(Number(row('still going').props.width)).toBe(W)
      const col = holder(root, 'archive-item-w2')
      expect(col?.props?.flexDirection).toBe('column')
      expect(kids(col).map(keyOf)).toEqual(['archive-item-w2', 'agent-fold-w2'])
      expect(kids(holder(root, 'archive-item-w1')).map(keyOf)).toEqual(['archive-item-w1'])
      expect(JSON.stringify(root)).not.toContain('NaN')
    }
  })

  test('terminal: the glyph comes right after the task name on the first line', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await plan($)
    await finishedRows($, clock, 2, [], () => $.tool.call({ tool: 'mcp__flowdeck__step', agentId: 'w2', steps: [{ title: 'one' }, { title: 'two' }] } as any))
    for (let cols = 24; cols <= 80; cols += 4) {
      const p = await pane($, 'terminal', cols)
      const root = await p.drawn()
      await p.unmount()
      expect(JSON.stringify(root)).not.toContain('NaN')
      for (const id of ['w1', 'w2']) {
        const line = kids(holder(root, `archive-item-${id}`))
        const at = line.findIndex(c => keyOf(c) === `archive-item-${id}`)
        expect(JSON.stringify(line[at - 1])).toContain(`task ${id.slice(1)}`)
        if (id === 'w2') expect(line.findIndex(c => keyOf(c) === 'agent-fold-w2')).toBeGreaterThan(at + 1)
      }
    }
    const t = await terminal($)
    expect(t.text).not.toMatch(/\bArchive\b(?! ·)/)
  })
})
