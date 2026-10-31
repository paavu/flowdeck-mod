import { describe, expect, test } from 'claude-code/testing'

import { cut, DECLINED, fableRefusal, isFable, NEEDS_APPROVAL, question } from '../hooks/fable-guard'

const NOW = Date.UTC(2026, 9, 31, 11, 0)

// Answers the engine calls a launch makes; `answer` picks what the user does with the question, `asked` records them.
function engine(on: any, answer: string | 'dismiss' = 'Approve') {
  const asked: string[] = []
  const launched: any[] = []
  const store: Record<string, unknown> = {}
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: undefined }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0].question
      asked.push(q)
      return answer === 'dismiss' ? { deny: 'dismissed' } : { result: { answers: { [q]: answer } } }
    }
    launched.push(e)
    return { result: 'launched' }
  })
  return { asked, launched }
}

const agent = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'Agent', ...input } as any)
const FABLE = { subagent_type: 'flowdeck-fable', description: 'Hard parser bug', prompt: 'Opus heavy failed:\n  the parser   still loops.' }

describe('the Fable approval guard', () => {
  test('a worker on another tier passes untouched, with no question', async ($, on) => {
    const { asked, launched } = engine(on)
    for (const input of [
      { subagent_type: 'flowdeck-heavy', description: 'x', prompt: 'p' },
      { subagent_type: 'flowdeck:flowdeck-careful', description: 'x', prompt: 'p', model: 'opus' },
      { subagent_type: 'general-purpose', description: 'x', prompt: 'p' },
    ]) {
      expect(await agent($, input)).toEqual({ result: 'launched' })
    }
    expect(asked).toEqual([])
    expect(launched.length).toBe(3)
  })

  for (const [name, input] of [
    ['flowdeck-fable', FABLE],
    ['flowdeck:flowdeck-fable', { ...FABLE, subagent_type: 'flowdeck:flowdeck-fable' }],
    ['model fable', { subagent_type: 'general-purpose', model: 'fable', description: 'Hard parser bug', prompt: FABLE.prompt }],
  ] as const) {
    test(`${name} asks with the task and a trimmed reason; approving lets the call through`, async ($, on) => {
      const { asked, launched } = engine(on, 'Approve')
      expect(await agent($, input)).toEqual({ result: 'launched' })
      expect(asked).toEqual([
        'flowdeck wants to use Fable (the reserve tier) for: Hard parser bug. Reason: Opus heavy failed: the parser still loops.. Approve?',
      ])
      expect(launched.length).toBe(1)
    })
  }

  test('declining denies with the Opus heavy message and nothing launches', async ($, on) => {
    const { asked, launched } = engine(on, 'Decline')
    const out: any = await agent($, FABLE)
    expect(out.deny).toBe(DECLINED)
    expect(out.deny).toContain('Opus heavy')
    expect(out.deny).toContain('do not retry Fable')
    expect(asked.length).toBe(1)
    expect(launched).toEqual([])
  })

  test('a typed answer other than Approve, and a dismissed question, both deny', async ($, on) => {
    engine(on, 'sure, go ahead')
    expect(((await agent($, FABLE)) as any).deny).toBe(DECLINED)
  })

  test('a dismissed question denies', async ($, on) => {
    const { launched } = engine(on, 'dismiss')
    expect(((await agent($, FABLE)) as any).deny).toBe(DECLINED)
    expect(launched).toEqual([])
  })

  test('an approval covers that call only: a second launch asks again', async ($, on) => {
    const { asked, launched } = engine(on, 'Approve')
    await agent($, FABLE)
    await agent($, FABLE)
    expect(asked.length).toBe(2)
    expect(launched.length).toBe(2)
  })

  test('a call with missing fields does not crash', async ($, on) => {
    const { asked } = engine(on, 'Decline')
    expect(((await agent($, { model: 'fable' })) as any).deny).toBe(DECLINED)
    expect(asked[0]).toBe('flowdeck wants to use Fable (the reserve tier) for: a task. Reason: none given. Approve?')
    expect(await agent($, {})).toEqual({ result: 'launched' })
  })
})

describe('the guard\'s pieces', () => {
  test('long descriptions and reasons are cut with an ellipsis', () => {
    const q = question({ description: 'd'.repeat(200), prompt: 'r '.repeat(400) })
    const [, description] = /for: (d+…)\. Reason/.exec(q) ?? []
    const [, reason] = /Reason: (.*)\. Approve\?$/.exec(q) ?? []
    expect(description?.length).toBe(120)
    expect(reason?.length).toBe(300)
    expect(reason?.endsWith('…')).toBe(true)
    expect(cut('short', 10)).toBe('short')
    expect(cut(42, 10)).toBe('')
  })

  test('isFable matches the suffix and the model only', () => {
    expect(isFable({ subagent_type: 'flowdeck-fable' })).toBe(true)
    expect(isFable({ subagent_type: 'flowdeck:flowdeck-fable' })).toBe(true)
    expect(isFable({ model: ' Fable ' })).toBe(true)
    expect(isFable({ subagent_type: 'flowdeck-fable-extra' })).toBe(false)
    expect(isFable({ subagent_type: 'my-flowdeck-fable' })).toBe(false)
    expect(isFable({ model: 'opus' })).toBe(false)
    expect(isFable({})).toBe(false)
  })

  test('without a way to ask, the call is denied with the chat instruction', async () => {
    expect(await fableRefusal({} as any, FABLE)).toBe(NEEDS_APPROVAL)
    expect(NEEDS_APPROVAL).toContain('do not retry Fable without a yes')
  })

  test('a failing ask denies instead of throwing; other calls are never asked', async () => {
    const throwing = { ui: { ask: async () => { throw new Error('no ui') } } }
    expect(await fableRefusal(throwing as any, FABLE)).toBe(DECLINED)
    let asked = 0
    const counting = { ui: { ask: async () => { asked++; return 'Approve' } } }
    expect(await fableRefusal(counting as any, { subagent_type: 'flowdeck-heavy' })).toBeNull()
    expect(asked).toBe(0)
  })
})
