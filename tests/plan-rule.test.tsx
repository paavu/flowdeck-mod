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

// The Plans feature is gone (1.0.0035): the flow rule is flowdeck's only prompt section.
describe('prompt rules without plans', () => {
  test('adds only the flow rule after the sections already composed, no plan-rule', async ($, on) => {
    engine(on)
    const r = await compose($)
    expect(r.sections.map((s: any) => s.id)).toEqual(['core', 'other:rule', 'flowdeck:flow-rule'])
    expect(r.sections.some((s: any) => s.id === 'flowdeck:plan-rule')).toBe(false)
  })

  test('no section names the plan tool', async ($, on) => {
    engine(on)
    const r = await compose($)
    for (const s of r.sections) expect(String(s.text)).not.toContain('mcp__flowdeck__plan')
  })

  test('a failing composition below is not masked: the engine\'s sections are never replaced by ours alone', async ($, on) => {
    engine(on, () => {
      throw new Error('compose down')
    })
    let error: unknown = null
    const r = await compose($).catch((err: unknown) => {
      error = err
      return null
    })
    const ours = (x: any) => x.sections.filter((s: any) => String(s.id).startsWith('flowdeck:'))
    expect(r === null || ours(r).length === 0 || (r as any).sections.length > 1).toBe(true)
    expect(error !== null || r === null || (r as any).sections.length > 1).toBe(true)
  })
})
