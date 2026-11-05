import { describe, expect, test } from 'claude-code/testing'

import { PLAN_NUDGE, PLAN_SEND_BACK } from '../hooks/nudge'
import { dayKey, hhmm } from '../hooks/time'
import { toolsOf, UNTRACKED_MAX, untrackedLine } from '../hooks/untracked'
import { fakeFs } from './fake-fs'

// The untracked-work log: a main turn that ended with work calls made while tracking was on and no flow was open is one
// record in `<project>/.claude/flowdeck/untracked-work.json`; the panel counts today's under the tabs. And the plan
// nudge and the turn-end check follow the stored choice that /flowdeck-rule and the Track tasks switch write.

const NOW = Date.UTC(2026, 9, 31, 9, 0)
const DIR = '/work/app/.claude/flowdeck'
const LOG = `${DIR}/untracked-work.json`

function engine(on: any, opts: { rule?: string; files?: Record<string, string>; env?: Record<string, string>; fail?: { fs?: boolean }; stop?: { block?: string } } = {}) {
  const store: Record<string, unknown> = opts.rule ? { rule: opts.rule } : {}
  const fs = fakeFs(on, { files: opts.files ?? {}, fail: opts.fail })
  const clock = { now: NOW }
  on('env.get', (_$: any, e: any) => ({ value: opts.env?.[e.name ?? e.key ?? e.variable] }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('session.end', () => ({ sessionId: 's' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => (opts.stop?.block ? { block: opts.stop.block } : {}))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  return { store, fs, files: fs.files, clock }
}

const start = ($: any, cwd = '/work/app') => $.session.start({ surface: 'terminal', isInteractive: true, cwd } as any)
let turnNo = 0
const turn = ($: any) => $.turn.start({ turnId: `u${++turnNo}` } as any)
const call = ($: any, tool: string, agentId?: string) => $.tool.call({ tool, ...(agentId ? { agentId } : {}) } as any)
const stop = ($: any, e: Record<string, unknown> = {}) => $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, ...e } as any)
const command = async ($: any, args: string): Promise<string> => String((await $.command.run({ command: 'flowdeck-rule', args } as any)).text)
const planned = (r: any): boolean => (r.context ?? []).some((l: unknown) => typeof l === 'string' && l.startsWith(PLAN_NUDGE))
const logOf = (files: Record<string, string>): any[] => (LOG in files ? JSON.parse(files[LOG]!) : [])
const OPEN = { title: 'Trial', total: 1, tasks: [{ title: 'Build', tier: 'light' }], phase: 'delegate' }

const pane = ($: any, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const walk = (n: any): any[] => (n && typeof n === 'object' ? [n, ...(Array.isArray(n) ? n : (n.children ?? [])).flatMap(walk)] : [])
const textOf = (n: any): string => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''))

// The line under the tabs (anywhere in the pane), and the node right after the tab row in the FlowDeck group.
async function underTabs($: any, surface: 'desktop' | 'terminal'): Promise<{ line: any; afterTabs: any }> {
  const p = await pane($, surface)
  const root = await p.drawn()
  await p.unmount()
  const nodes = walk(root)
  const group = nodes.find(n => n?.props?.key === 'flowdeck-group')
  const kids: any[] = (group?.children ?? []).filter((k: any) => k && typeof k === 'object')
  const at = kids.findIndex(k => k?.props?.key === 'tabs')
  return { line: nodes.find(n => n?.type === 'Text' && / without a flow today$/.test(textOf(n))) ?? null, afterTabs: kids[at + 1] ?? null }
}

describe('the untracked-work log', () => {
  test('toolsOf: up to 4, most used first, a tie in the order first used', () => {
    expect(toolsOf(new Map([['Edit', 2], ['Bash', 5], ['Write', 2], ['Agent', 1], ['Task', 3]]))).toEqual(['Bash', 'Task', 'Edit', 'Write'])
    expect(toolsOf(new Map())).toEqual([])
  })

  test('a turn with work calls and no flow is one record: local day and 24-hour time, calls, tools, sentBack', async ($, on) => {
    const { files } = engine(on, { rule: 'on' })
    await start($)
    await turn($)
    for (const t of ['Edit', 'Read', 'Bash', 'Edit', 'mcp__lean-ctx__ctx_shell', 'Write', 'Edit']) await call($, t)
    expect((await stop($)).block).toBe(PLAN_SEND_BACK)
    expect(logOf(files)).toEqual([{ day: dayKey(NOW), time: hhmm(NOW), calls: 6, tools: ['Edit', 'Bash', 'mcp__lean-ctx__ctx_shell', 'Write'], sentBack: true }])
    expect(hhmm(NOW)).toMatch(/^\d{2}:\d{2}$/)
    expect(files[`${DIR}/.gitignore`]).toBe('*\n')
  })

  test('one record a turn: the stop after the send-back adds none; a single call is logged and sent back', async ($, on) => {
    const { files } = engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await call($, 'Edit')
    await call($, 'Bash')
    await stop($)
    await stop($, { stop_hook_active: true })
    expect(logOf(files)).toHaveLength(1)
    await turn($)
    await call($, 'Edit')
    expect((await stop($)).block).toBe(PLAN_SEND_BACK)
    expect(logOf(files).map(r => [r.calls, r.sentBack])).toEqual([[2, true], [1, true]])
  })

  test('nothing for a question, a turn with a flow open, or work done before a flow was opened', async ($, on) => {
    const { files } = engine(on, { rule: 'on' })
    await start($)
    await turn($)
    await call($, 'Read')
    await stop($)
    await turn($)
    await call($, 'Edit')
    await call($, 'Bash')
    await $.tool.call({ tool: 'mcp__flowdeck__progress', ...OPEN } as any)
    await call($, 'Edit')
    await stop($)
    expect(LOG in files).toBe(false)
  })

  test('tracking off writes nothing, nor does a worker', async ($, on) => {
    const { files } = engine(on, { rule: 'off' })
    await start($)
    await turn($)
    for (let i = 0; i < 5; i++) await call($, 'Edit')
    await stop($)
    expect(LOG in files).toBe(false)
    await command($, 'on')
    await $.agent.spawn({ subagentType: 'flowdeck-medium', description: '#1 w', tool_use_id: 'w1' } as any)
    await turn($)
    for (let i = 0; i < 5; i++) await call($, 'Edit', 'w1')
    await stop($, { agent_id: 'w1' })
    await stop($)
    expect(LOG in files).toBe(false)
  })

  test('another hook that keeps the turn going: logged when it ends', async ($, on) => {
    const other = { block: 'other: still open' as string | undefined }
    const { files } = engine(on, { rule: 'on', stop: other })
    await start($)
    await turn($)
    await call($, 'Edit')
    await call($, 'Bash')
    expect((await stop($)).block).toBe('other: still open')
    expect(LOG in files).toBe(false)
    other.block = undefined
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(logOf(files).map(r => r.sentBack)).toEqual([false])
  })

  test(`keeps the newest ${UNTRACKED_MAX} records, and records it does not know as they were`, async ($, on) => {
    const old = Array.from({ length: UNTRACKED_MAX }, (_, i) => (i === UNTRACKED_MAX - 1 ? { note: 'kept' } : { day: '2026-10-01', time: '08:00', calls: i, tools: [], sentBack: false }))
    const { files } = engine(on, { rule: 'on', files: { [LOG]: JSON.stringify(old) } })
    await start($)
    await turn($)
    await call($, 'Edit')
    await stop($)
    const log = logOf(files)
    expect(log).toHaveLength(UNTRACKED_MAX)
    expect(log[0].calls).toBe(1)
    expect(log.at(-2)).toEqual({ note: 'kept' })
    expect(log.at(-1).day).toBe(dayKey(NOW))
  })

  test('a log that holds no list, or cannot be read, is never written over', async ($, on) => {
    const { files } = engine(on, { rule: 'on', files: { [LOG]: '{"mine":true}' } })
    await start($)
    await turn($)
    await call($, 'Edit')
    await stop($)
    expect(files[LOG]).toBe('{"mine":true}')
  })

  test('a failing fs never throws the stop', async ($, on) => {
    engine(on, { rule: 'on', fail: { fs: true } })
    await start($)
    await turn($)
    await call($, 'Edit')
    await call($, 'Bash')
    expect((await stop($)).block).toBe(PLAN_SEND_BACK)
  })

  test("from a folder below the project it is the project's log; the child gets no .claude", async ($, on) => {
    const { files } = engine(on, { rule: 'on', env: { HOME: '/Users/u' }, files: { '/Users/u/.claude/projects/-work-app/s.jsonl': '{}' } })
    await start($, '/work/app/sub')
    await turn($)
    await call($, 'Edit')
    await stop($)
    expect(logOf(files)).toHaveLength(1)
    expect(Object.keys(files).filter(p => p.startsWith('/work/app/sub/'))).toEqual([])
  })
})

describe('the panel line under the tabs', () => {
  test('untrackedLine: singular, plural, none, only today', () => {
    expect(untrackedLine([], '2026-11-03')).toBeNull()
    expect(untrackedLine(['2026-11-02'], '2026-11-03')).toBeNull()
    expect(untrackedLine(['2026-11-02', '2026-11-03'], '2026-11-03')).toBe('1 turn without a flow today')
    expect(untrackedLine(['2026-11-03', '2026-11-03', '2026-11-03'], '2026-11-03')).toBe('3 turns without a flow today')
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`none at zero; a muted line right under the tab row once a turn is logged, counting today's (${surface})`, async ($, on) => {
      const yesterday = { day: '2000-01-01', time: '10:00', calls: 3, tools: ['Edit'], sentBack: true }
      engine(on, { rule: 'on', files: { [LOG]: JSON.stringify([yesterday]) } })
      await start($)
      expect((await underTabs($, surface)).line).toBeNull()
      await turn($)
      await call($, 'Edit')
      await stop($)
      let u = await underTabs($, surface)
      expect(textOf(u.line)).toBe('1 turn without a flow today')
      expect(u.line.props.dimColor).toBe(true)
      expect(u.line.props.color).toBeUndefined()
      expect(u.afterTabs).toBe(u.line)
      await turn($)
      await call($, 'Edit')
      await call($, 'Bash')
      await stop($)
      u = await underTabs($, surface)
      expect(textOf(u.line)).toBe('2 turns without a flow today')
    })
  }

  test("a new session counts today's records from the file", async ($, on) => {
    const rec = { day: dayKey(NOW), time: '08:00', calls: 2, tools: ['Edit'], sentBack: true }
    engine(on, { rule: 'on', files: { [LOG]: JSON.stringify([rec, rec]) } })
    await start($)
    expect(textOf((await underTabs($, 'desktop')).line)).toBe('2 turns without a flow today')
  })
})

describe('the nudge and the turn-end check follow /flowdeck-rule', () => {
  test('from the moment the command reports off, no line and no send-back; from on, both again', async ($, on) => {
    const { files } = engine(on, { rule: 'on' })
    await start($)
    await turn($)
    expect(planned(await call($, 'Edit'))).toBe(true)
    expect(await command($, 'off')).toMatch(/^Task tracking is off/)
    for (let i = 0; i < 6; i++) expect(planned(await call($, i % 2 ? 'Bash' : 'Edit'))).toBe(false)
    expect((await stop($)).block).toBeUndefined()
    expect(LOG in files).toBe(false)
    expect(await command($, 'on')).toMatch(/^Task tracking is on/)
    expect(planned(await call($, 'Edit'))).toBe(true)
    await call($, 'Bash')
    expect((await stop($)).block).toBe(PLAN_SEND_BACK)
  })

  test('a bare /flowdeck-rule only reports; it changes nothing', async ($, on) => {
    const { store } = engine(on, { rule: 'off' })
    await start($)
    expect(await command($, '')).toMatch(/^Task tracking is off/)
    expect(store.rule).toBe('off')
    await turn($)
    expect(planned(await call($, 'Edit'))).toBe(false)
  })

  test('in a session that ran /flowdeck:flowdeck, stored off still means no line and no send-back', async ($, on) => {
    const { files } = engine(on, { rule: 'on' })
    await start($)
    await $.skill.prompt({ skill: 'flowdeck', text: 'Task from the user: x', pluginName: 'flowdeck' } as any)
    await command($, 'off')
    expect(await command($, 'status')).toMatch(/^Task tracking is off/)
    await turn($)
    for (let i = 0; i < 4; i++) expect(planned(await call($, 'Edit'))).toBe(false)
    expect((await stop($)).block).toBeUndefined()
    expect(LOG in files).toBe(false)
  })

  test("the panel's Track tasks switch turns them off and on the same way", async ($, on) => {
    engine(on, { rule: 'on' })
    await start($)
    const press = async () => {
      const p = await pane($, 'desktop')
      await p.press({ key: 'track-tasks' })
      await p.unmount()
    }
    await press()
    await turn($)
    expect(planned(await call($, 'Edit'))).toBe(false)
    await press()
    expect(planned(await call($, 'Edit'))).toBe(true)
  })
})
