import { describe, expect, test } from 'claude-code/testing'

import { asPanel } from '../hooks/shapes'
import { asRule, estimateTokens, isTracking, SCHEMA_CHARS_PER_TOKEN, toggledRule } from '../hooks/rule'
import { fakeFs } from './fake-fs'
import { showTab } from './tabs'

// Task tracking: the flow rule goes into the system prompt unless the stored choice is `off`, and always in a session
// that ran /flowdeck:flowdeck. A fresh install saves `on`; an earlier release's `unset` counts as on. Only `off` shows
// the strip on the Active and Finished tabs.

const DIR = '/work/app/.claude/flowdeck'

function engine(on: any, opts: { store?: Record<string, unknown>; files?: Record<string, string>; storeDown?: boolean } = {}) {
  const store: Record<string, unknown> = opts.store ?? {}
  const fs = fakeFs(on, { files: opts.files ?? {} })
  const opened: string[] = []
  const closed: string[] = []
  const commands: any[] = []
  const tools: any[] = []
  let panes: { id: string }[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 31, 9, 0) }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.id', () => ({ value: 's' }))
  on('tool.register', (_$: any, e: any) => (tools.push(e), { value: undefined }))
  on('command.register', (_$: any, e: any) => (commands.push(e), { value: undefined }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$: any, e: any) => (opened.push(e.id), (panes = [{ id: e.id }]), { value: undefined }))
  on('ui.close', (_$: any, e: any) => (closed.push(e.id), (panes = []), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => {
    if (opts.storeDown) throw new Error('store down')
    return { value: store[e.key] }
  })
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'engine', scope: 'shared' }] }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  return { store, fs, opened, closed, commands, tools }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
const ruleText = async ($: any): Promise<string | null> => (await compose($)).sections.find((s: any) => s.id === 'flowdeck:flow-rule')?.text ?? null
const pane = ($: any, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const walk = (n: any): any[] => (n && typeof n === 'object' ? [n, ...(Array.isArray(n) ? n : (n.children ?? [])).flatMap(walk)] : [])
const textOf = (n: any): string => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''))
const rule = (r: string) => ({ rule: r })

// The strip as drawn: its texts and its buttons' labels, or null when there is none.
async function strip($: any, surface: 'desktop' | 'terminal') {
  const p = await pane($, surface)
  const root = await p.drawn()
  await p.unmount()
  const box = walk(root).find(n => n?.props?.key === 'rule-strip')
  if (!box) return null
  const nodes = walk(box)
  return {
    texts: nodes.filter(n => n?.type === 'Text').map(textOf),
    buttons: nodes.filter(n => n?.type === 'Button').map(n => [n.props.key, n.props.label]),
  }
}

async function topLabel($: any, surface: 'desktop' | 'terminal'): Promise<string> {
  const p = await pane($, surface)
  const root = await p.drawn()
  await p.unmount()
  return walk(root).find(n => n?.props?.key === 'track-tasks')?.props?.label
}

async function press($: any, key: string) {
  const p = await pane($, 'terminal')
  await p.press({ key })
  await p.unmount()
}

describe('the stored choice', () => {
  test('reads tolerantly: anything but on or off is unset; only off stops tracking; the switch turns off from on and unset', () => {
    expect([asRule('on'), asRule('off'), asRule('unset'), asRule(undefined), asRule(true), asRule('ON')]).toEqual(['on', 'off', 'unset', 'unset', 'unset', 'unset'])
    expect([isTracking('on'), isTracking('unset'), isTracking('off')]).toEqual([true, true, false])
    expect([toggledRule('on'), toggledRule('off'), toggledRule('unset')]).toEqual(['off', 'on', 'off'])
    expect([estimateTokens(360), estimateTokens(360, SCHEMA_CHARS_PER_TOKEN)]).toEqual([100, 180])
  })

  test('a fresh install saves on and injects the rule; a later session keeps it', async ($, on) => {
    const { store, fs } = engine(on)
    await start($)
    expect(store.rule).toBe('on')
    expect(await ruleText($)).not.toBeNull()
    fs.files[`${DIR}/flow-live.json`] = '{}'
    await start($)
    expect(store.rule).toBe('on')
  })

  for (const [what, opts] of [
    ['flow-live.json in this project', { files: { [`${DIR}/flow-live.json`]: '{}' } }],
    ['archive-index.json in this project', { files: { [`${DIR}/archive-index.json`]: '{"version":1,"entries":[]}' } }],
    ['history.json from before 1.0.0025', { files: { [`${DIR}/history.json`]: '[]' } }],
    ['the keepWarm store key', { store: { keepWarm: { '/elsewhere': false } } }],
    ['the history store key', { store: { history: {} } }],
    ['the contextShown store key', { store: { contextShown: false } }],
  ] as const) {
    test(`an install from before the choice keeps its rule: ${what} migrates to on`, async ($, on) => {
      const { store } = engine(on, opts as any)
      await start($)
      expect(store.rule).toBe('on')
      expect(await ruleText($)).not.toBeNull()
    })
  }

  test('a choice already stored is kept: off and unset are not migrated, a value of the wrong kind is', async ($, on) => {
    const files = { [`${DIR}/flow-live.json`]: '{}' }
    const off = engine(on, { store: rule('off'), files })
    await start($)
    expect(off.store.rule).toBe('off')
    expect(await ruleText($)).toBeNull()
    off.store.rule = 'unset'
    await start($)
    expect(off.store.rule).toBe('unset')
    expect(await ruleText($)).not.toBeNull()
    off.store.rule = 42
    await start($)
    expect(off.store.rule).toBe('on')
  })

  test('a store that cannot be read migrates nothing and still injects the rule', async ($, on) => {
    const { store } = engine(on, { files: { [`${DIR}/flow-live.json`]: '{}' }, storeDown: true })
    await start($)
    expect(store.rule).toBeUndefined()
    expect(await ruleText($)).not.toBeNull()
  })

  test('an old held panel without the choice reads as unset, draws as on and shows no strip', async ($, on) => {
    const old = { isContextShown: true, isUsageShown: false, isBandHidden: false, isKeepWarm: true, tab: 'finished' }
    expect(asPanel(old).rule).toBe('unset')
    expect(asPanel({ ...old, rule: 'sideways' }).rule).toBe('unset')
    expect(asPanel({ ...old, rule: 'on' }).rule).toBe('on')
    engine(on, { store: rule('off') })
    on('state.get', { plugin: 'flowdeck', key: 'panel' }, () => ({ value: old }))
    expect(await strip($, 'terminal')).toBeNull()
    expect(await topLabel($, 'terminal')).toBe('● Track tasks')
  })
})

describe('the flow rule in the system prompt', () => {
  test('unless tracking is off: on and unset inject it', async ($, on) => {
    const { store } = engine(on, { store: rule('on') })
    await start($)
    const r = await compose($)
    expect(r.sections.map((s: any) => s.id)).toEqual(['core', 'flowdeck:flow-rule'])
    expect(r.sections[1].scope).toBe('session')
    store.rule = 'off'
    expect(await ruleText($)).toBeNull()
    store.rule = 'unset'
    expect(await ruleText($)).not.toBeNull()
  })

  test('/flowdeck:flowdeck turns it on for its own session, whatever the choice; another skill does not', async ($, on) => {
    const { store } = engine(on, { store: rule('off') })
    await start($)
    await $.skill.prompt({ skill: 'commit', text: 'x', pluginName: 'other' } as any)
    expect(await ruleText($)).toBeNull()
    await $.skill.prompt({ skill: 'flowdeck', text: 'Task from the user: x', pluginName: 'flowdeck' } as any)
    expect(await ruleText($)).not.toBeNull()
    expect(store.rule).toBe('off') // never stored
    const status = await $.command.run({ command: 'flowdeck-rule', args: 'status' } as any)
    expect(status.text).toContain('/flowdeck:flowdeck ran in it')
  })

  test('self-contained: the rule carries every reporting duty', async ($, on) => {
    engine(on, { store: rule('on') })
    await start($)
    const text = String(await ruleText($))
    for (const word of [
      'mcp__flowdeck__progress', // report through the progress tool
      'Plan once: title, tasks [{title, tier, after, goal}]', // plan once, goal on create
      'chain tasks editing the same files with `after`',
      '`add` with its goal',
      '`done: [n]` with notes [{task, result, feedback}]', // result and feedback on accept
      '`#<n> <title>`',
      'Any task doing work (edit, shell, worker) opens or joins a flow first, even a one-step one (one task)',
      'only an answer with no work calls needs none',
      'Close each task with `done` + notes before the turn ends',
      'Pick the Agent `model` per task and send it as the task\'s `model`', // model choice
      'Fable only after the user approves, once Opus heavy failed; state why atop its brief',
    ]) {
      expect(text).toContain(word)
    }
    // Trimmed in 1.0.0037 from 896 characters; 1.0.0038 adds the model sentence, 1.0.0039 the Fable brief clause.
    expect(text.length).toBeLessThan(760)
  })
})

describe('the strip on the Active and Finished tabs', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`a fresh install, on and unset draw none (${surface})`, async ($, on) => {
      const { store } = engine(on)
      await start($)
      expect(await strip($, surface)).toBeNull()
      store.rule = 'unset'
      await start($)
      expect(await strip($, surface)).toBeNull()
    })

    test(`off says so and keeps one button; on draws none (${surface})`, async ($, on) => {
      const { store } = engine(on, { store: rule('off') })
      await start($)
      const s = await strip($, surface)
      expect(s?.texts[0]).toBe('Task tracking is off')
      expect(s?.texts[1]).toMatch(/^When on, Claude plans each task, shows it here with its workers, time and cost, and saves a handoff note\. It adds about \d{1,3}(,\d{3})* tokens per session and a few tool calls per task\. \/flowdeck:flowdeck <task> tracks any set of tasks whenever you want\.$/)
      expect(s?.buttons).toEqual([['rule-on', 'Track all tasks']])
      store.rule = 'on'
      await start($)
      expect(await strip($, surface)).toBeNull()
    })
  }

  test('shown on Finished too, never on Archive or Trash', async ($, on) => {
    engine(on, { store: rule('off') })
    await start($)
    await showTab($, 'finished')
    expect(await strip($, 'terminal')).not.toBeNull()
    await showTab($, 'archive')
    expect(await strip($, 'terminal')).toBeNull()
    await showTab($, 'trash')
    expect(await strip($, 'desktop')).toBeNull()
  })

  test('the token count is the rule as prose and the progress tool as /context counts its schema', async ($, on) => {
    const { tools } = engine(on, { store: rule('off') })
    await start($)
    const n = Number(/about ([\d,]+) tokens/.exec(String((await strip($, 'terminal'))?.texts[1]))?.[1]?.replace(/,/g, ''))
    const progress = tools.find(t => t.name === 'progress')
    const chars = JSON.stringify({ name: 'mcp__flowdeck__progress', description: progress.description, input_schema: progress.inputSchema }).length
    const ruleChars = await (async () => {
      await $.command.run({ command: 'flowdeck-rule', args: 'on' } as any)
      return String(await ruleText($)).length
    })()
    expect(n).toBe(Math.round((estimateTokens(ruleChars) + estimateTokens(chars, SCHEMA_CHARS_PER_TOKEN)) / 10) * 10)
    expect(n).toBeGreaterThan(1000)
    expect(n).toBeLessThan(2500)
  })

  test('Track all tasks stores on and the strip goes', async ($, on) => {
    const { store } = engine(on, { store: rule('off') })
    await start($)
    expect((await strip($, 'terminal'))?.texts[0]).toBe('Task tracking is off')
    expect(await ruleText($)).toBeNull()
    await press($, 'rule-on')
    expect(store.rule).toBe('on')
    expect(await strip($, 'terminal')).toBeNull()
    expect(await ruleText($)).not.toBeNull()
  })
})

describe('the Track tasks switch', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`● from a fresh install, ○ only when off; a press toggles and stores it (${surface})`, async ($, on) => {
      const { store } = engine(on)
      await start($)
      expect(await topLabel($, surface)).toBe('● Track tasks')
      await press($, 'track-tasks')
      expect(store.rule).toBe('off')
      expect(await topLabel($, surface)).toBe('○ Track tasks')
      await press($, 'track-tasks')
      expect(store.rule).toBe('on')
      expect(await topLabel($, surface)).toBe('● Track tasks')
    })

    test(`unset draws ● and a press turns it off (${surface})`, async ($, on) => {
      const { store } = engine(on, { store: rule('unset') })
      await start($)
      expect(await topLabel($, surface)).toBe('● Track tasks')
      await press($, 'track-tasks')
      expect(store.rule).toBe('off')
      expect(await topLabel($, surface)).toBe('○ Track tasks')
    })
  }
})

describe('the commands', () => {
  test('registered: flowdeck-panel, flowdeck-agents (old name) and flowdeck-rule', async ($, on) => {
    const { commands } = engine(on)
    await start($)
    expect(commands.map(c => c.name)).toEqual(['flowdeck-panel', 'flowdeck-agents', 'flowdeck-rule'])
    expect(commands.find(c => c.name === 'flowdeck-rule').description).toBe('Turn task tracking on or off')
  })

  test('/flowdeck-rule on, off and status; anything else says how to use it', async ($, on) => {
    const { store } = engine(on)
    await start($)
    const run = async (args: string) => String((await $.command.run({ command: 'flowdeck-rule', args } as any)).text)
    expect(await run('status')).toMatch(/^Task tracking is on: /)
    expect(await run('')).toMatch(/^Task tracking is on: /)
    const onStatus = await run('status')
    store.rule = 'unset'
    expect(await run('status')).toBe(onStatus)
    expect(await run(' OFF ')).toMatch(/^Task tracking is off/)
    expect(await run('on')).toMatch(/^Task tracking is on/)
    expect(store.rule).toBe('on')
    expect(await run('status')).toMatch(/^Task tracking is on: /)
    expect(await run(' OFF ')).toMatch(/^Task tracking is off/)
    expect(store.rule).toBe('off')
    expect(await run('status')).toMatch(/^Task tracking is off: /)
    expect(await run('maybe')).toBe('Usage: /flowdeck-rule on | off | status')
    expect(store.rule).toBe('off')
  })

  test('/flowdeck-panel and the old /flowdeck-agents both toggle the same pane', async ($, on) => {
    const { opened, closed } = engine(on)
    await start($)
    expect(String((await $.command.run({ command: 'flowdeck-panel', args: '' } as any)).text)).toBe('flowdeck panel opened.')
    expect(String((await $.command.run({ command: 'flowdeck-agents', args: '' } as any)).text)).toBe('flowdeck panel closed.')
    expect(opened).toEqual(['flowdeck-agents'])
    expect(closed).toEqual(['flowdeck-agents'])
  })
})

describe('a flow that starts without being asked stays quiet unless tracking is on', () => {
  const plan = ($: any, title = 'T') =>
    $.tool.call({ tool: 'mcp__flowdeck__progress', title, phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] } as any)

  test('with tracking off the flow starts and the panel does not open', async ($, on) => {
    const { opened } = engine(on, { store: rule('off') })
    await start($)
    const r = await plan($)
    expect(String(r.result)).toMatch(/^ok: /)
    expect(opened).toEqual([])
  })

  for (const choice of ['on', 'unset'] as const) {
    test(`with tracking ${choice} the panel opens once per flow`, async ($, on) => {
      const { opened } = engine(on, { store: rule(choice) })
      await start($)
      await plan($)
      await plan($)
      expect(opened).toEqual(['flowdeck-agents'])
    })
  }

  test('turning tracking on later does not open a flow that already started', async ($, on) => {
    const { opened, store } = engine(on, { store: rule('off') })
    await start($)
    await plan($)
    store.rule = 'on'
    await plan($)
    expect(opened).toEqual([])
    await plan($, 'Another')
    expect(opened).toEqual(['flowdeck-agents'])
  })

  test('/flowdeck:flowdeck is an explicit request: it still opens the panel with tracking off', async ($, on) => {
    const { opened } = engine(on, { store: rule('off') })
    await start($)
    await $.skill.prompt({ skill: 'flowdeck', text: 'Task from the user: x', pluginName: 'flowdeck' } as any)
    await plan($)
    expect(opened).toEqual(['flowdeck-agents'])
  })
})

describe('when a switch applies', () => {
  const TIMING = 'running and queued tasks are not affected'

  test('the replies of /flowdeck-rule on, off and status say so', async ($, on) => {
    engine(on)
    await start($)
    for (const args of ['on', 'off', 'status']) {
      const text = String((await $.command.run({ command: 'flowdeck-rule', args } as any)).text)
      expect(text).toContain('Turning it on applies from the next work call (a reminder)')
      expect(text).toContain('a new session, /clear or a compaction')
      expect(text).toContain('turning it off applies at the next compose, and the reminder stops at once')
      expect(text).toContain(TIMING)
    }
  })

  test('the strip says so while off', async ($, on) => {
    engine(on, { store: rule('off') })
    await start($)
    const s = await strip($, 'terminal')
    expect(s?.texts.some(t => t.includes('next work call') && t.includes('new session, /clear or a compaction') && t.includes(TIMING))).toBe(true)
  })
})

describe('one progress call', () => {
  test('carries add, done and notes together', async ($, on) => {
    engine(on, { store: rule('on') })
    await start($)
    await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'T', phase: 'delegate', tasks: [{ title: 'one', tier: 'light' }] } as any)
    const r = await $.tool.call({
      tool: 'mcp__flowdeck__progress',
      add: [{ title: 'two', tier: 'light', goal: 'the second' }],
      done: [1, 2],
      notes: [{ task: 2, result: 'did it', feedback: 'checked' }],
    } as any)
    expect(String(r.result)).toBe('ok: Tasks 2/2')
  })
})
