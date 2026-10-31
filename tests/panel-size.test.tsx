import { describe, expect, test } from 'claude-code/testing'

// The desktop panel stays small enough for the desktop app to take. A 19-task flow with 17 finished runs drew a
// 267,000-character Finished tab (each row's drawing about 12,000: its crab as one rect per pixel and the crab's motion
// CSS on rows that do not move); past about 240,000 the desktop app kept the panel it had, its presses came back
// `ui_press not handled`, and the reopened panel stayed blank. The engine drew it without an error, so nothing caught it.

const NOW = Date.UTC(2026, 9, 31, 7, 30)
const MIN = 60_000
const LIMIT = 200_000 // PANE_MAX_CHARS in register.tsx

function engine(on: any) {
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

// A value the held state answers until the code writes the key, as a reload leaves it.
const held = (on: any, key: string, value: unknown) =>
  on('state.get', { plugin: 'flowdeck', key }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    return r?.value?.version > 0 ? r : { value: { value, version: r?.value?.version ?? 0 } }
  })

const TIERS = ['medium', 'careful', 'heavy', 'medium', 'light']
const task = (n: number) => ({
  title: `Task ${n} with a title of some length`,
  tier: TIERS[n % TIERS.length],
  after: n > 1 ? [n - 1] : [],
  goal: `Do the work of task ${n} as asked, in one sentence of a plain length.`,
  result: `Task ${n} is done: the change, its tests and the version bump; every test passes.`,
  feedback: 'Accepted. Reviewed the diff and ran the tests again.',
})
// Run n (from 1): finished `n` steps of six ago, unless it is still running.
const runOf = (n: number, isRunning = false) => ({
  id: `w${n}`,
  agentId: `w${n}`,
  type: `flowdeck:flowdeck-${TIERS[n % TIERS.length]}`,
  description: `#${n} Task ${n} with a title of some length`,
  model: n % 3 ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
  effort: 'medium',
  status: isRunning ? 'running' : 'done',
  startedAt: NOW - (40 - n) * 6 * MIN,
  ...(isRunning ? {} : { endedAt: NOW - (40 - n) * 6 * MIN + 5 * MIN }),
  contextTokens: 150_000,
  contextMax: 1_000_000,
  tokens: 2_000_000,
  costUsd: 1.2,
  steps: 40,
  round: 1,
  stepDone: isRunning ? 3 : 6,
  stepTotal: 6,
  items: Array.from({ length: 6 }, (_, i) => ({
    title: `Step ${i + 1} of task ${n}`,
    status: isRunning && i >= 3 ? (i === 3 ? 'active' : 'pending') : 'done',
    ...(isRunning && i > 3 ? {} : { startedAt: NOW - (40 - n) * 6 * MIN + i * 40_000 }),
    ...(isRunning && i >= 3 ? {} : { doneAt: NOW - (40 - n) * 6 * MIN + (i + 1) * 40_000 }),
  })),
})

// A flow of `tasks` tasks whose first `finished` have finished runs (all accepted), and `running` more running.
function flowOf(tasks: number, finished: number, running = 0) {
  const accepted = Array.from({ length: finished }, (_, i) => i + 1)
  return {
    flow: {
      title: 'Big flow',
      total: tasks,
      done: finished,
      running,
      phase: 'delegate',
      isFinished: false,
      isLinked: true,
      tasks: Array.from({ length: tasks }, (_, i) => task(i + 1)),
      accepted,
      acceptedAt: Object.fromEntries(accepted.map(n => [String(n), NOW - (40 - n) * 6 * MIN + 6 * MIN])),
    },
    agents: [...Array.from({ length: finished }, (_, i) => runOf(i + 1)), ...Array.from({ length: running }, (_, i) => runOf(finished + i + 1, true))],
  }
}

const hold = (on: any, tasks: number, finished: number, running = 0, tab = 'finished') => {
  const { flow, agents } = flowOf(tasks, finished, running)
  held(on, 'flow', flow)
  held(on, 'agents', agents)
  held(on, 'now', NOW)
  held(on, 'panel', { tab, rule: 'on', isContextShown: false, isUsageShown: false, isArchiveShown: true })
}

async function draw($: any, surface: 'desktop' | 'terminal') {
  const p = await $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 60 } } as any)
  const json = JSON.stringify(await p.drawn())
  const svgs = await p.findAll({ type: 'Svg' })
  const texts = await p.findAll({ type: 'Text' })
  const buttons = await p.findAll({ type: 'Button' })
  await p.unmount()
  return { json, svgs, texts, buttons, text: texts.map((t: any) => String(t.text)).join('\n') }
}

const rowSvgs = (svgs: any[]) => svgs.filter((s: any) => /^#\d+ Task \d+/.test(String(s.props.alt)))

describe('the desktop panel stays within what the desktop takes', () => {
  test('a 19-task flow with 17 finished runs draws its Finished tab as drawings, under the limit', async ($, on) => {
    engine(on)
    hold(on, 19, 17)
    const d = await draw($, 'desktop')
    expect(d.json.length).toBeLessThanOrEqual(LIMIT)
    expect(rowSvgs(d.svgs)).toHaveLength(17)
    expect(d.text).not.toMatch(/drawn as text|too large/)
  })

  test("a finished row's drawing is small: its crab is a few paths, without the crab's motion CSS", async ($, on) => {
    engine(on)
    hold(on, 19, 17)
    const rows = rowSvgs((await draw($, 'desktop')).svgs)
    for (const s of rows) {
      const source = String(s.props.source)
      expect(source.length).toBeLessThan(4_000)
      expect(source).not.toContain('@keyframes st')
      expect(source).not.toContain(' run"')
      expect((source.match(/<rect x="\d+" y="\d+" width="1" height="1"/g) ?? []).length).toBe(0)
    }
  })

  test('a running row keeps its walking crab and the CSS that moves it', async ($, on) => {
    engine(on)
    hold(on, 19, 17, 1, 'active')
    const rows = rowSvgs((await draw($, 'desktop')).svgs)
    expect(rows).toHaveLength(1)
    const source = String(rows[0].props.source)
    expect(source).toContain(' run"')
    expect(source).toContain('@keyframes st')
  })

  test('a flow past the limit draws its text rows on the desktop and says so; never a blank panel', async ($, on) => {
    engine(on)
    hold(on, 90, 90)
    const d = await draw($, 'desktop')
    expect(d.json.length).toBeLessThanOrEqual(LIMIT)
    expect(d.text).toMatch(/^Finished is drawn as text: its drawing is too large for the panel$/m)
    expect(rowSvgs(d.svgs)).toHaveLength(0)
    expect(d.text).toMatch(/Task 90 with a title/)
    expect(d.text).toMatch(/Task 1 with a title/)
    for (const key of ['context', 'usage', 'band', 'tab-active', 'tab-finished', 'tab-archive', 'tab-trash']) {
      expect(d.buttons.some((b: any) => b.props.key === key)).toBe(true)
    }
  })

  test('the terminal draws the same flows as text rows, without the note', async ($, on) => {
    engine(on)
    hold(on, 90, 90)
    const t = await draw($, 'terminal')
    expect(t.text).not.toMatch(/drawn as text|too large/)
    expect(t.text).toMatch(/Task 90 with a title/)
  })
})
