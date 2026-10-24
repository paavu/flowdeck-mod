import { describe, expect, test } from 'claude-code/testing'

const OTHER = { id: 'other:rule', text: 'another mod', scope: 'session' as const }

function engine(on: any, compose: () => unknown = () => ({ sections: [{ id: 'core', text: 'engine', scope: 'shared' }, OTHER] })) {
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('prompt.compose', compose)
}

const compose = ($: any) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
const ours = (r: any) => r.sections.filter((s: any) => s.id === 'flowdeck:plan-rule')

describe('plan rule', () => {
  test('adds exactly one session section after the ones already composed', async ($, on) => {
    engine(on)
    const r = await compose($)
    expect(ours(r).length).toBe(1)
    expect(ours(r)[0].scope).toBe('session')
    expect(r.sections.map((s: any) => s.id)).toEqual(['core', 'other:rule', 'flowdeck:plan-rule'])
  })

  test('names the tool and the short ops, stays short and adds no gate', async ($, on) => {
    engine(on)
    const text: string = ours(await compose($))[0].text
    for (const word of ['mcp__flowdeck__plan', 'mcp__flowdeck__progress', 'next:true', 'done:', 'active:', 'failed:', 'needs_input', 'state:"done"', 'kind: "todo"', 'stages']) {
      expect(text).toContain(word)
    }
    expect(text.length).toBeLessThan(1200)
  })

  test('a failing composition below does not make the hook throw', async ($, on) => {
    engine(on, () => {
      throw new Error('compose down')
    })
    let error: unknown = null
    const r = await compose($).catch((err: unknown) => {
      error = err
      return null
    })
    expect(error).toBe(null)
    expect(ours(r).length).toBe(1)
  })
})
