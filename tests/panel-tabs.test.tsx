import { describe, expect, test } from 'claude-code/testing'

import { keyOf, parseSession } from '../hooks/archive'
import { byNewest, recordOf } from '../hooks/archive-index'
import { asPanel, PANEL_DEFAULT } from '../hooks/shapes'
import { fileOf } from './archive-files'
import { showTab } from './tabs'
import type { Tab } from './tabs'

// The flowdeck group under Context and Usage: the tabs Active, Finished, Plans, Archive and Trash with their counts, the
// Band button at the end, and the one list of the selected tab below them.

const NOW = Date.UTC(2026, 9, 30, 13, 0)
const HOUR = 3_600_000
const SURFACES = ['terminal', 'desktop'] as const
const TABS: Tab[] = ['active', 'finished', 'plans', 'archive', 'trash']

function engine(on: any, opts: { store?: Record<string, unknown> } = {}) {
  const store = opts.store ?? {}
  const clock = { now: NOW }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
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
  return { store, clock }
}

// A value an older flowdeck wrote: the held state answers it until the new code writes the key.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return r?.value?.version > 0 ? r : { value: { value, version: r?.value?.version ?? 0 } }
  })

// A value the held state always answers, whatever a load or save wrote.
const pinned = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return { value: { value, version: r?.value?.version ?? 0 } }
  })

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const mount = ($: any, surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns } } as any)
const progress = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flowdeck__progress', ...input } as any)
const spawn = ($: any, id: string, description: string) => $.agent.spawn({ subagentType: 'flowdeck-medium', description, tool_use_id: id } as any)
const complete = ($: any, agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId } as any)

const entry = (i: number) => ({
  id: `e${i}`,
  project: '/work/app',
  title: `Old flow ${i}`,
  startedAt: NOW - (i + 2) * HOUR,
  endedAt: NOW - (i + 1) * HOUR,
  status: 'finished',
  done: 1,
  total: 1,
  tasks: [{ title: 'old task', tier: 'light' }],
  cost: 1,
  tokens: 1000,
  time: 60_000,
})
// The index records of these entries, newest first; `trashed` marks them as moved to the trash at NOW.
const recordsOf = (entries: any[], trashed = false) =>
  byNewest(entries.map(e => ({ ...recordOf(parseSession(e)!, fileOf(e), 0), ...(trashed ? { trashedAt: NOW, originalFile: fileOf(e) } : {}) })))

// One of everything: a running run, a finished run, a queued task, a plan and a saved session.
async function everything($: any) {
  await start($)
  await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'run a', tier: 'medium' }, { title: 'done b', tier: 'medium' }, { title: 'queued c', tier: 'light' }] })
  await spawn($, 'w2', 'done b')
  await complete($, 'w2')
  await spawn($, 'w1', 'run a')
  await $.tool.call({ tool: 'mcp__flowdeck__plan', id: 'alpha', title: 'Alpha rollout', stages: [{ name: 'S', steps: [{ title: 'one' }] }] } as any)
}

// Everything a pane shows as words: its Texts, its drawings' alts and its Buttons' text.
const seen = async (p: any): Promise<string> => {
  const texts = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text))
  const alts = (await p.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt ?? ''))
  const buttons = (await p.findAll({ type: 'Button' })).map((b: any) => `${String(b.props.key)} ${String(b.text ?? '')}`)
  return [...texts, ...alts, ...buttons].join('\n')
}
// The list each tab draws, by a word only it shows.
const MARK: Record<Tab, RegExp> = {
  active: /queued c/,
  finished: /done b/,
  plans: /Alpha rollout/,
  archive: new RegExp(`archive-${keyOf('e1')}`),
  trash: new RegExp(`trash-${keyOf('e9')}`),
}
const tabText = async (p: any, tab: Tab) => (await p.find({ type: 'Button', key: `tab-${tab}` }))?.text

const kidsOf = (n: any): any[] => (Array.isArray(n?.children) ? n.children : Array.isArray(n?.props?.children) ? n.props.children : []).filter((c: any) => c && typeof c === 'object')
const walk = (n: any, out: any[] = []): any[] => {
  if (!n || typeof n !== 'object') return out
  out.push(n)
  for (const c of kidsOf(n)) walk(c, out)
  return out
}
const keyOfNode = (n: any) => String(n?.props?.key ?? n?.key ?? '')

describe('the tabs', () => {
  test('Active is selected by default; a press selects another tab, and the choice holds for later draws', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      let p = await mount($, surface)
      expect((await p.find({ type: 'Text', text: 'Active (0)' }))?.props).toMatchObject({ bold: true, underline: true })
      for (const tab of ['finished', 'plans', 'archive'] as const) {
        const b = await p.find({ type: 'Button', key: `tab-${tab}` })
        expect(b?.props.dimColor).toBe(true)
      }
      await p.press({ key: 'tab-plans' })
      await p.unmount()
      p = await mount($, surface)
      expect((await p.find({ type: 'Text', text: 'Plans (0)' }))?.props).toMatchObject({ bold: true, underline: true })
      expect(await p.find({ type: 'Text', text: 'No plans' })).toBeDefined()
      await p.unmount()
      await showTab($, 'active')
    }
  })

  test('pressing the selected tab changes nothing', async ($, on) => {
    engine(on)
    let writes = 0
    on('state.set', { plugin: 'flowdeck', key: 'panel' }, async (_$: any, e: any, next: any) => {
      writes++
      return next(e)
    })
    await start($)
    const p = await mount($, 'terminal')
    writes = 0
    await p.press({ key: 'tab-active' })
    await p.unmount()
    expect(writes).toBe(0)
    const again = await mount($, 'terminal')
    expect(await again.find({ type: 'Text', text: 'Nothing running or queued' })).toBeDefined()
    await again.unmount()
  })

  test('a panel held from before the tabs reads as Active; a tab of the wrong kind too', async ($, on) => {
    expect(asPanel({ isCompact: false }).tab).toBe('active')
    expect(asPanel({ tab: 'bogus' }).tab).toBe('active')
    expect(asPanel({ tab: 7 }).tab).toBe('active')
    expect(asPanel({ tab: 'archive' }).tab).toBe('archive')
    expect(asPanel({ tab: 'trash' }).tab).toBe('trash')
    // the fields of the volumes are dropped; a page is never under 50, and a confirmation of the wrong kind is none
    for (const k of ['archiveVolume', 'archiveListOpen', 'archiveError', 'archiveWarning', 'archiveLatestCount']) expect(k in asPanel({ archiveVolume: 'history-3.json', archiveListOpen: true, archiveError: 'x', archiveWarning: 'y', archiveLatestCount: 5 })).toBe(false)
    expect(asPanel({ archiveLimit: 10, trashLimit: 'x' })).toMatchObject({ archiveLimit: 50, trashLimit: 50 })
    expect(asPanel({ archiveLimit: 100 }).archiveLimit).toBe(100)
    expect(asPanel({ confirm: { list: 'archive', id: 'e1' } }).confirm).toEqual({ list: 'archive', id: 'e1' })
    expect(asPanel({ confirm: { list: 'volumes', id: 'e1' } }).confirm).toBeNull()
    expect(asPanel(null).tab).toBe(PANEL_DEFAULT.tab)
    engine(on)
    held(on, 'panel', { isCompact: false, isDoneCollapsed: true, isContextShown: true, isUsageShown: true, isPlansShown: false, isArchiveShown: false, autoOpenedFor: '' })
    for (const surface of SURFACES) {
      const p = await mount($, surface)
      expect(await p.find({ type: 'Text', text: 'Nothing running or queued' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: /could not be drawn|could not draw/ })).toBeUndefined()
      await p.unmount()
    }
  })

  test('a held panel with a tab of the wrong kind draws the Active tab', async ($, on) => {
    engine(on)
    held(on, 'panel', { ...PANEL_DEFAULT, tab: 'history' })
    for (const surface of SURFACES) {
      const p = await mount($, surface)
      expect((await p.find({ type: 'Text', text: 'Active (0)' }))?.props.underline).toBe(true)
      await p.unmount()
    }
  })

  test('the tabs and the Band button form their own row below Context and Usage, which keep theirs', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      const p = await mount($, surface)
      const root = await p.drawn()
      await p.unmount()
      const row = (key: string) => walk(root).find(n => keyOfNode(n) === key)
      const keys = (n: any) => walk(n).map(keyOfNode).filter(Boolean)
      expect(keys(row('top-toggles'))).toEqual(['top-toggles', 'context', 'usage'])
      expect(keys(row('tabs'))).toEqual(['tabs', 'tab-active', 'tab-finished', 'tab-plans', 'tab-archive', 'tab-trash', 'band'])
      // the group comes after Context and Usage
      const order = walk(root).map(keyOfNode)
      expect(order.indexOf('top-toggles')).toBeLessThan(order.indexOf('flowdeck-group'))
      const band = walk(row('tabs')).find(n => keyOfNode(n) === 'band')
      expect(band?.props?.dimColor).toBe(true)
    }
  })
})

describe('one list at a time', () => {
  for (const surface of SURFACES) {
    test(`each tab draws its own list and none of the others (${surface})`, async ($, on) => {
      engine(on, { store: { history: [entry(1)] } })
      // the Archive holds e1, the Trash e9
      pinned(on, 'archiveLists', { records: recordsOf([entry(1)]), trash: recordsOf([entry(9)], true), warnings: [] })
      await everything($)
      for (const tab of TABS) {
        await showTab($, tab)
        const p = await mount($, surface)
        const words = await seen(p)
        await p.unmount()
        for (const other of TABS) expect([other, MARK[other].test(words)]).toEqual([other, other === tab])
      }
    })
  }

  test('the counts: running and queued, finished, plans, saved sessions; on both surfaces and every tab', async ($, on) => {
    engine(on, { store: { history: [entry(2), entry(1)] } })
    await everything($)
    for (const surface of SURFACES) {
      for (const tab of TABS) {
        await showTab($, tab)
        const p = await mount($, surface)
        expect(await tabText(p, 'active')).toBe('Active (2)')
        expect(await tabText(p, 'finished')).toBe('Finished (1)')
        expect(await tabText(p, 'plans')).toBe('Plans (1)')
        expect(await tabText(p, 'archive')).toBe('Archive (2)')
        expect(await tabText(p, 'trash')).toBe('Trash (0)')
        await p.unmount()
      }
    }
  })

  test('every count is (0) with nothing to show, and each tab says so', async ($, on) => {
    engine(on)
    await start($)
    const empty: Record<Tab, string> = { active: 'Nothing running or queued', finished: 'No finished items yet', plans: 'No plans', archive: 'no archive yet', trash: 'Trash is empty' }
    for (const surface of SURFACES) {
      for (const tab of TABS) {
        await showTab($, tab)
        const p = await mount($, surface)
        for (const t of TABS) expect(await tabText(p, t)).toBe(`${t[0]!.toUpperCase()}${t.slice(1)} (0)`)
        expect(await p.find({ type: 'Text', text: empty[tab] })).toBeDefined()
        await p.unmount()
      }
    }
  })

  test('Active lists the running rows first, then the queued tasks in plan order, with the flow header above', async ($, on) => {
    engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'first', tier: 'light' }, { title: 'second', tier: 'light' }, { title: 'third', tier: 'light' }, { title: 'fourth', tier: 'light' }] })
    await spawn($, 'w3', 'third')
    const p = await mount($, 'terminal')
    const text = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text)).join('\n')
    expect(await p.find({ type: 'Button', key: 'compact' })).toBeDefined()
    expect(await p.find({ type: 'Button', key: 'flow-finish' })).toBeUndefined()
    await p.unmount()
    const at = (s: string) => text.indexOf(s)
    expect(at('Ship')).toBeGreaterThan(-1)
    expect(at('Ship')).toBeLessThan(at('3. third'))
    expect(at('3. third')).toBeLessThan(at('1. first'))
    expect(at('1. first')).toBeLessThan(at('2. second'))
    expect(at('2. second')).toBeLessThan(at('4. fourth'))
    expect(text).not.toMatch(/Running ·|Planned ·|Finished ·/)
    const d = await mount($, 'desktop')
    const alts = (await d.findAll({ type: 'Svg' })).map((s: any) => String(s.props.alt ?? '')).filter((a: string) => /^\d\. /.test(a))
    await d.unmount()
    expect(alts).toEqual(['1. first: planned', '2. second: planned', '4. fourth: planned'])
  })

  test('Finished lists the finished rows newest first under the flow header, each with its archive icon', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await progress($, { title: 'Ship', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }, { title: 'two', tier: 'light' }] })
    await spawn($, 'w1', 'one')
    clock.now = NOW + 1000
    await spawn($, 'w2', 'two')
    clock.now = NOW + 60_000
    await complete($, 'w1')
    await complete($, 'w2')
    await showTab($, 'finished')
    for (const surface of SURFACES) {
      const p = await mount($, surface)
      const keys = (await p.findAll({ type: 'Button' })).map((b: any) => String(b.props.key))
      const names = (await p.findAll({ type: 'Text' })).map((t: any) => String(t.text)).filter((t: string) => /^\d\. /.test(t))
      expect(await p.find({ type: 'Button', key: 'compact' })).toBeDefined()
      expect(await p.find({ type: 'Button', key: 'flow-finish' })).toBeUndefined()
      await p.unmount()
      expect(keys.filter((k: string) => k.startsWith('archive-item-'))).toEqual(['archive-item-w2', 'archive-item-w1'])
      expect(names).toEqual(['2. two', '1. one'])
    }
  })
})

describe('the Archive and Trash counts', () => {
  test('every session each list holds, the ones past the page too; drawn or not, on both surfaces', async ($, on) => {
    engine(on)
    const archived = Array.from({ length: 52 }, (_, i) => entry(i + 1))
    pinned(on, 'archiveLists', { records: recordsOf(archived), trash: recordsOf([entry(60), entry(61)], true), warnings: [] })
    for (const surface of SURFACES) {
      for (const tab of ['active', 'archive', 'trash'] as const) {
        await showTab($, tab)
        const p = await mount($, surface)
        expect(await tabText(p, 'archive')).toBe('Archive (52)')
        expect(await tabText(p, 'trash')).toBe('Trash (2)')
        if (tab === 'archive') {
          // a page of 50 is drawn; the other two are a press away
          expect((await p.findAll({ type: 'Button' })).filter((b: any) => /^archive-k[a-z0-9]+$/.test(String(b.props.key)))).toHaveLength(50)
          expect(String((await p.find({ type: 'Button', key: 'archive-more' }))?.props.label)).toBe('Show more (2)')
        }
        await p.unmount()
      }
    }
    await showTab($, 'active')
  })
})
