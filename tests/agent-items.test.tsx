import { describe, expect, test } from 'claude-code/testing'

import { applyItemOps, derive, finishItems, ITEM_COLOR, itemElapsed, itemLine, itemsOf, itemSvg, MAX_ITEMS, parseSteps, stepItems } from '../hooks/agent-items'
import { STATE_COLOR } from '../hooks/plan-view'
import { showTab } from './tabs'

const NOW = Date.UTC(2026, 9, 26, 12, 40)
const fit = (s: string, _size: number, maxW: number) => (s.length * 6 > maxW ? s.slice(0, Math.max(1, Math.floor(maxW / 6) - 1)) + '…' : s)

const list = (...titles: string[]) => parseSteps(titles.map(title => ({ title })), [], NOW) ?? []

describe('agent items: the step list', () => {
  test('a sent list becomes items, the first one active and stamped', () => {
    const items = list('read code', 'write tests', 'wire tool')
    expect(items.map(i => i.status)).toEqual(['active', 'pending', 'pending'])
    expect(items[0]!.startedAt).toBe(NOW)
    expect(items[1]!.startedAt).toBeUndefined()
  })

  test('derived counts and note: done items, all items, the active title', () => {
    const items = parseSteps([{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }, { title: 'c', status: 'done' }, { title: 'd' }, { title: 'e' }, { title: 'f' }], [], NOW) ?? []
    expect(derive(items)).toEqual({ done: 3, total: 6, note: 'd' })
  })

  test('a sent active item stays the active one; a second active is pending', () => {
    const items = parseSteps([{ title: 'a', status: 'done' }, { title: 'b', status: 'active' }, { title: 'c', status: 'active' }], [], NOW) ?? []
    expect(items.map(i => i.status)).toEqual(['done', 'active', 'pending'])
  })

  test('titles are trimmed and capped, empty ones and garbage dropped, at most 12 items', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `step ${i + 1}` }))
    expect(parseSteps(many, [], NOW)?.length).toBe(MAX_ITEMS)
    const items = parseSteps([{ title: '  spaced   out  ' }, { title: '' }, null, 7, { title: 3 }, { title: 'x'.repeat(200) }, 'plain'], [], NOW) ?? []
    expect(items.map(i => i.title.length <= 48)).toEqual([true, true, true])
    expect(items[0]!.title).toBe('spaced out')
    expect(items[2]!.title).toBe('plain')
    expect(parseSteps([{ title: 'a', status: 'weird' }], [], NOW)?.[0]!.status).toBe('active')
  })

  test('no list sent reads as no list; a resent list keeps what was finished under the same title', () => {
    expect(parseSteps(undefined, [], NOW)).toBeNull()
    expect(parseSteps('x', [], NOW)).toBeNull()
    const before = applyItemOps(list('a', 'b'), { next: true }, NOW + 5000).items
    const again = parseSteps([{ title: 'A' }, { title: 'b' }, { title: 'c' }], before, NOW + 6000) ?? []
    expect(again.map(i => i.status)).toEqual(['done', 'active', 'pending'])
    expect(again[0]!.doneAt).toBe(NOW + 5000)
    expect(again[1]!.startedAt).toBe(NOW + 5000)
  })

  test('next finishes the active item and starts the following one', () => {
    const { items, unknown } = applyItemOps(list('a', 'b', 'c'), { next: true }, NOW + 4000)
    expect(unknown).toEqual([])
    expect(items.map(i => i.status)).toEqual(['done', 'active', 'pending'])
    expect(items[0]!.doneAt).toBe(NOW + 4000)
    expect(items[1]!.startedAt).toBe(NOW + 4000)
    const last = applyItemOps(applyItemOps(items, { next: true }, NOW).items, { next: true }, NOW)
    expect(last.items.map(i => i.status)).toEqual(['done', 'done', 'done'])
  })

  test('done names items case-insensitively; finishing the active one moves on', () => {
    const { items } = applyItemOps(list('a', 'b', 'c'), { done: ['A', 'c'] }, NOW)
    expect(items.map(i => i.status)).toEqual(['done', 'active', 'done'])
  })

  test('active jumps to an item: earlier active done, later active pending', () => {
    const { items } = applyItemOps(list('a', 'b', 'c'), { active: 'C' }, NOW + 1000)
    expect(items.map(i => i.status)).toEqual(['done', 'pending', 'active'])
    expect(items[2]!.startedAt).toBe(NOW + 1000)
  })

  test('failed marks an item error and stamps its end', () => {
    const { items } = applyItemOps(list('a', 'b'), { failed: 'a' }, NOW + 2000)
    expect(items[0]).toMatchObject({ status: 'error', doneAt: NOW + 2000 })
    expect(derive(items)).toEqual({ done: 0, total: 2, note: undefined })
  })

  test('unknown titles are ignored and reported', () => {
    const { items, unknown } = applyItemOps(list('a', 'b'), { done: ['zz'], active: 'yy', failed: 'xx' }, NOW)
    expect(unknown).toEqual(['zz', 'yy', 'xx'])
    expect(items.map(i => i.status)).toEqual(['active', 'pending'])
  })

  test('stepItems: null without item fields, a list with them', () => {
    expect(stepItems(undefined, { done: 2, total: 3 }, NOW)).toBeNull()
    const made = stepItems(undefined, { steps: [{ title: 'a' }, { title: 'b' }], next: true }, NOW)
    expect(made?.items.map(i => i.status)).toEqual(['done', 'active'])
  })

  test('the run end closes the active item: done for a done run, error for a failed one', () => {
    const items = list('a', 'b')
    expect(finishItems(items, true, NOW + 9000).map(i => i.status)).toEqual(['done', 'pending'])
    expect(finishItems(items, true, NOW + 9000)[0]!.doneAt).toBe(NOW + 9000)
    expect(finishItems(items, false, NOW + 9000).map(i => i.status)).toEqual(['error', 'pending'])
  })

  test('without a clock nothing is stamped and nothing throws', () => {
    const items = parseSteps([{ title: 'a' }, { title: 'b' }], [], undefined) ?? []
    expect(items[0]!.startedAt).toBeUndefined()
    expect(applyItemOps(items, { next: true }, undefined).items[0]!.doneAt).toBeUndefined()
  })

  test('itemsOf keeps only well-formed items', () => {
    expect(itemsOf('junk')).toEqual([])
    expect(itemsOf([{ title: 'a', status: 'done' }, { title: 5 }, null, { title: 'b', status: 'odd' }])).toEqual([
      { title: 'a', status: 'done' },
      { title: 'b', status: 'pending' },
    ])
  })
})

describe('agent items: drawing', () => {
  test('state colours: pending grey, active blue-violet, done green, error red', () => {
    expect(ITEM_COLOR.active).toBe(STATE_COLOR.running)
    expect(ITEM_COLOR.done).toBe(STATE_COLOR.done)
    expect(ITEM_COLOR.error).toBe(STATE_COLOR.error)
    expect(Object.values(STATE_COLOR)).not.toContain(ITEM_COLOR.pending)
  })

  test('elapsed: running from its start, done from start to end, pending none', () => {
    expect(itemElapsed({ title: 'a', status: 'active', startedAt: NOW }, NOW + 12_000)).toBe(12_000)
    expect(itemElapsed({ title: 'a', status: 'done', startedAt: NOW, doneAt: NOW + 3000 }, NOW + 99_000)).toBe(3000)
    expect(itemElapsed({ title: 'a', status: 'pending' }, NOW)).toBeNull()
    expect(itemElapsed({ title: 'a', status: 'done', doneAt: NOW }, NOW)).toBeNull()
  })

  test('the desktop row: mark in the state colour, title, elapsed right-aligned', () => {
    const run = itemSvg(400, { title: 'write tests', status: 'active', startedAt: NOW }, NOW + 12_000, fit)
    expect(run).toContain(`fill="${STATE_COLOR.running}"`)
    expect(run).toContain('>write tests<')
    expect(run).toMatch(/text-anchor="end"[^>]*>12s</)
    const done = itemSvg(400, { title: 'commit', status: 'done', startedAt: NOW, doneAt: NOW + 65_000 }, NOW, fit)
    expect(done).toContain(`stroke="${STATE_COLOR.done}"`)
    expect(done).toContain('1m 5s')
    expect(itemSvg(400, { title: 'x', status: 'error' }, NOW, fit)).toContain(`stroke="${STATE_COLOR.error}"`)
    const pending = itemSvg(400, { title: 'later', status: 'pending' }, NOW, fit)
    for (const hex of Object.values(STATE_COLOR)) expect(pending).not.toContain(hex)
  })

  test('a long title is cut, the time kept; markup in titles is escaped', () => {
    const long = 'a very long step title that never ends at all'
    const src = itemSvg(200, { title: long, status: 'active', startedAt: NOW }, NOW + 1000, fit)
    expect(src).not.toContain(long)
    expect(src).toContain('…')
    expect(src).toContain('1s')
    expect(itemSvg(400, { title: '<b>&', status: 'pending' }, NOW, fit)).toContain('&lt;b&gt;&amp;')
  })

  test('the terminal line: glyph per state, dim pending, title cut to fit with the time', () => {
    expect(itemLine({ title: 'a', status: 'pending' }, NOW, 40)).toMatchObject({ mark: '●', isDim: true, time: '' })
    expect(itemLine({ title: 'a', status: 'active', startedAt: NOW }, NOW + 12_000, 40)).toMatchObject({ mark: '●', color: STATE_COLOR.running, isDim: false, time: '12s' })
    expect(itemLine({ title: 'a', status: 'done' }, NOW, 40)).toMatchObject({ mark: '✓', color: STATE_COLOR.done })
    expect(itemLine({ title: 'a', status: 'error' }, NOW, 40)).toMatchObject({ mark: '✗', color: STATE_COLOR.error })
    const cut = itemLine({ title: 'x'.repeat(48), status: 'active', startedAt: NOW }, NOW + 5000, 30)
    expect(cut.title.endsWith('…')).toBe(true)
    expect(3 + 2 + cut.title.length + 2 + cut.time.length).toBeLessThanOrEqual(30)
  })
})

// --- through the tool and the panel

const RUNNING = STATE_COLOR.running
const GREEN = STATE_COLOR.done
const RED = STATE_COLOR.error

function engine(on: any, opts: { clockFails?: () => boolean; storeFails?: boolean } = {}) {
  const store: Record<string, unknown> = {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => {
    if (opts.clockFails?.()) throw new Error('clock down')
    return { value: clock.now }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => {
    if (opts.storeFails) throw new Error('store down')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  return { store, clock }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30))
const pane = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const spawn = ($: any, id = 'w1', description = 'wire it') => $.agent.spawn({ subagentType: 'flowdeck-careful', description, tool_use_id: id } as any)
const step = async ($: any, input: Record<string, unknown>, agentId: string | null = 'w1') =>
  String((await $.tool.call({ tool: 'mcp__flowdeck__step', ...(agentId ? { agentId } : {}), ...input } as any)).result)
const SIX = ['read code', 'write tests', 'wire tool', 'fix types', 'run suite', 'commit'].map(title => ({ title }))

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
  await p.unmount()
  return { svgs, buttons, alts: svgs.map((s: any) => String(s.props.alt ?? '')) }
}
const rowSource = (d: { svgs: any[] }, alt: RegExp) => String(d.svgs.find((s: any) => alt.test(String(s.props.alt)))?.props.source ?? '')
const fold = async ($: any, id = 'w1', surface: 'terminal' | 'desktop' = 'terminal') => {
  const p = await pane($, surface)
  await p.press({ key: `agent-fold-${id}` })
  await settle()
  await p.unmount()
}

describe('agent items through the step tool', () => {
  test('a steps list derives the count (the active step: 1/6) and the active title as the note', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    expect(await step($, { steps: SIX })).toBe('ok')
    expect((await terminal($)).text).toMatch(/1\/6 read code/)
    expect(rowSource(await desktop($), /^wire it:/)).toContain('1/6 · read code')
  })

  test('next, done, active and failed move the count and the note', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX })
    await step($, { next: true })
    expect((await terminal($)).text).toMatch(/2\/6 write tests/)
    await step($, { done: ['write tests', 'WIRE TOOL'] })
    expect((await terminal($)).text).toMatch(/4\/6 fix types/)
    await step($, { active: 'commit' })
    expect((await terminal($)).text).toMatch(/5\/6 commit/)
    await step($, { failed: 'commit' })
    expect((await terminal($)).text).toMatch(/4\/6$/m)
  })

  test('an unknown title is ignored with a short note in the result', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX })
    expect(await step($, { done: ['nope'] })).toBe('ok (unknown step "nope" ignored)')
    expect((await terminal($)).text).toMatch(/1\/6 read code/)
  })

  test('explicit done, total and note win for that call', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX, done: 2, total: 9, note: 'my own words' })
    expect((await terminal($)).text).toMatch(/3\/9 my own words/)
    await step($, { next: true })
    expect((await terminal($)).text).toMatch(/2\/6 write tests/)
  })

  test('the old done/total/note calls work as before', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    expect(await step($, { done: 0, total: 3 })).toBe('ok')
    await step($, { done: 1, total: 3, note: 'tests' })
    const t = await terminal($)
    expect(t.text).toMatch(/2\/3 tests/)
    // No step list: the chevron is there, dim, and opens on the row's details.
    const chevron = t.buttons.find((b: any) => String(b.props.key) === 'agent-fold-w1')
    expect(String(chevron?.props.label)).toBe('▶︎')
    expect(chevron?.props.dimColor).toBe(true)
  })

  test('calls from the main agent stay ignored', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    expect(await step($, { steps: SIX }, null)).toBe('ignored: only subagents report steps')
    expect((await terminal($)).text).not.toMatch(/0\/6/)
  })

  test('a failing clock or store never throws the call', async ($, on) => {
    let broken = false
    engine(on, { clockFails: () => broken, storeFails: true })
    await start($)
    await spawn($)
    broken = true
    expect(await step($, { steps: SIX })).toBe('ok')
    expect(await step($, { next: true })).toBe('ok')
    broken = false
    expect((await terminal($)).text).toMatch(/2\/6 write tests/)
  })

  test('garbage input never throws and keeps the row', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    for (const input of [{ steps: 'x' }, { steps: [null, 3, { title: {} }] }, { done: 'x' }, { done: [5, null] }, { active: 7 }, { next: 'yes' }, { failed: {} }]) {
      expect(await step($, input)).toMatch(/^ok/)
    }
    const t = await terminal($)
    expect(t.text).toContain('wire it')
    expect((await desktop($)).alts.some(a => /^wire it:/.test(a))).toBe(true)
  })

  test('the run end closes the active item: done run done, failed run error', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await spawn($, 'w1', 'first')
    await spawn($, 'w2', 'second')
    await step($, { steps: [{ title: 'only step' }] }, 'w1')
    await step($, { steps: [{ title: 'bad step' }] }, 'w2')
    clock.now = NOW + 7000
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, agentId: 'w2' } as any)
    await showTab($, 'finished') // both runs ended
    await fold($, 'w1')
    await fold($, 'w2')
    const t = await terminal($)
    expect(t.text).toMatch(/1\/1/)
    const marks = t.texts.filter((x: any) => x.text === '✓' || x.text === '✗').map((x: any) => ({ text: x.text, color: x.props.color }))
    expect(marks).toContainEqual({ text: '✓', color: GREEN })
    expect(marks).toContainEqual({ text: '✗', color: RED })
    expect(t.text).toMatch(/only step\s+7s/)
  })
})

describe('agent items in the panel', () => {
  test('every agent row has a chevron, dim without items; it toggles its children (terminal)', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1', 'with items')
    await spawn($, 'w2', 'without items')
    await step($, { steps: SIX }, 'w1')
    await step($, { done: 1, total: 4 }, 'w2')
    let t = await terminal($)
    const chevrons = t.buttons.filter((b: any) => /^(?:▶︎|▼)$/.test(String(b.props.label)))
    expect(chevrons.length).toBe(2)
    expect(chevrons.map((b: any) => String(b.props.label))).toEqual(['▶︎', '▶︎'])
    expect(chevrons.find((b: any) => b.props.key === 'agent-fold-w1')?.props.dimColor).toBe(false)
    expect(chevrons.find((b: any) => b.props.key === 'agent-fold-w2')?.props.dimColor).toBe(true)
    expect(t.text).not.toMatch(/fix types/)
    await fold($, 'w1')
    t = await terminal($)
    expect(t.buttons.filter((b: any) => String(b.props.label) === '▼').length).toBe(1)
    for (const s of SIX) expect(t.text).toContain(s.title)
    const active = t.texts.find((x: any) => x.text === '●' && x.props.color === RUNNING)
    expect(active).toBeDefined()
    const pending = t.texts.filter((x: any) => x.text === '●' && x.props.dimColor)
    expect(pending.length).toBe(5)
    await fold($, 'w1')
    t = await terminal($)
    expect(t.text).not.toMatch(/fix types/)
  })

  test('desktop: chevron beside the row, children as small svg rows when open', async ($, on) => {
    engine(on)
    await start($)
    await spawn($, 'w1', 'with items')
    await spawn($, 'w2', 'without items')
    await step($, { steps: SIX }, 'w1')
    await step($, { next: true }, 'w1')
    let d = await desktop($)
    const before = d.svgs.length
    const chevrons = d.buttons.filter((b: any) => /^(?:▶︎|▼)$/.test(String(b.props.label)))
    expect(chevrons.map((b: any) => [String(b.props.key), b.props.dimColor])).toEqual([
      ['agent-fold-w2', true],
      ['agent-fold-w1', false],
    ])
    await fold($, 'w1', 'desktop')
    d = await desktop($)
    expect(d.svgs.length).toBe(before + 6)
    const kids = d.svgs.filter((s: any) => Number(s.props.height) === 22)
    expect(kids.length).toBe(6)
    expect(String(kids[0].props.alt)).toMatch(/^read code: Done/)
    expect(String(kids[0].props.source)).toContain(`stroke="${GREEN}"`)
    expect(String(kids[1].props.source)).toContain(`fill="${RUNNING}"`)
    expect(String(kids[1].props.source)).toContain('write tests')
    const row = d.svgs.find((s: any) => /^with items:/.test(String(s.props.alt)))
    const plain = d.svgs.find((s: any) => /^without items:/.test(String(s.props.alt)))
    expect(Number(row.props.width)).toBe(Number(kids[0].props.width))
    expect(Number(plain.props.height)).toBe(48)
  })

  test('no dismiss button on agent rows', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'w1' } as any)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      const labels = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.label))
      await p.unmount()
      expect(labels).not.toContain('✕')
    }
  })

  test('twelve items with long titles render on both surfaces', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    const many = Array.from({ length: 15 }, (_, i) => ({ title: `a rather long step title number ${i + 1} that goes on and on` }))
    await step($, { steps: many })
    await fold($)
    expect((await terminal($)).text).toMatch(/1\/12/)
    const t = await terminal($, 40)
    expect(t.texts.filter((x: any) => /^ {3}● a rather long step title/.test(x.text)).length).toBe(12)
    expect(t.text).toContain('…')
    const d = await desktop($, 40)
    const kids = d.svgs.filter((s: any) => Number(s.props.height) === 22)
    expect(kids.length).toBe(12)
    expect(String(kids[0].props.source)).toContain('…')
  })

  test('there is no Collapse: an unfolded row always shows its steps in full', async ($, on) => {
    engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX })
    await fold($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const p = await pane($, surface)
      expect(await p.find({ type: 'Button', key: 'compact' })).toBeUndefined()
      expect(JSON.stringify(await p.drawn())).not.toMatch(/"(Collapse|Expand)"/)
      await p.unmount()
    }
    const t = await terminal($)
    expect(t.text).toMatch(/fix types/)
    const d = await desktop($)
    expect(d.svgs.filter((s: any) => Number(s.props.height) === 22).length).toBe(SIX.length)
  })
})

describe('steps closed in one batch call', () => {
  const ALL = SIX.map(s => s.title)

  test('one call closing two or more unstarted steps marks them batch; the started one and a lone close do not', () => {
    const made = stepItems(undefined, { steps: SIX }, NOW)!.items
    const batch = stepItems(made, { done: ALL }, NOW + 30_000)!.items
    expect(batch.map(i => !!i.batch)).toEqual([false, true, true, true, true, true])
    expect(batch[0]).toMatchObject({ startedAt: NOW, doneAt: NOW + 30_000 })
    const lone = stepItems(made, { done: ['write tests'] }, NOW + 5000)!.items
    expect(lone.some(i => i.batch)).toBe(false)
    const stepwise = stepItems(stepItems(made, { next: true }, NOW + 5000)!.items, { next: true }, NOW + 9000)!.items
    expect(stepwise.some(i => i.batch)).toBe(false)
    expect(stepItems(made, { done: ALL }, undefined)!.items.some(i => i.batch)).toBe(false)
  })

  test('the flag survives a stored round trip and a later call', () => {
    const batch = stepItems(stepItems(undefined, { steps: SIX }, NOW)!.items, { done: ALL }, NOW + 30_000)!.items
    const again = stepItems(itemsOf(JSON.parse(JSON.stringify(batch))), { note: 'x', done: ['commit'] }, NOW + 40_000)!.items
    expect(again.filter(i => i.batch).length).toBe(5)
  })

  test('terminal and desktop draw – for batch-closed steps and the time for the others', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX })
    clock.now = NOW + 30_000
    await step($, { done: ALL })
    await fold($)
    const t = await terminal($)
    expect(t.text).toMatch(/read code\s+30s/)
    for (const title of ALL.slice(1)) expect(t.text).toMatch(new RegExp(`${title}\\s+–`))
    expect(t.text).not.toMatch(/write tests\s+0s/)
    const d = await desktop($)
    const kids = d.svgs.filter((s: any) => Number(s.props.height) === 22)
    expect(String(kids[0].props.alt)).toBe('read code: Done 30s')
    expect(String(kids[1].props.alt)).toBe('write tests: Done –')
    expect(String(kids[1].props.source)).toMatch(/text-anchor="end"[^>]*>–</)
    expect(String(kids[0].props.source)).toMatch(/text-anchor="end"[^>]*>30s</)
  })

  test('steps closed one at a time keep their own times', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await spawn($)
    await step($, { steps: SIX })
    clock.now = NOW + 4000
    await step($, { next: true })
    clock.now = NOW + 11_000
    await step($, { next: true })
    await fold($)
    const t = await terminal($)
    expect(t.text).toMatch(/read code\s+4s/)
    expect(t.text).toMatch(/write tests\s+7s/)
    expect(t.text).not.toContain('–')
  })
})
