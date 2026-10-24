import { describe, expect, test } from 'claude-code/testing'

function engine(on: any) {
  const opened: any[] = []
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('agent.spawn', (_$: any, e: any) => ({ agentId: e.tool_use_id, model: 'opus' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$: any, e: any) => (opened.push(e), { value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  return { opened }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

describe('flowdeck naming', () => {
  test('the progress tool accepts the flowdeck progress report', async ($, on) => {
    engine(on)
    await start($)
    const r = await $.tool.call({ tool: 'mcp__flowdeck__progress', title: 'T', total: 2, tasks: [{ title: 'a', tier: 'light' }, { title: 'b', tier: 'medium' }] } as any)
    expect(String(r.result)).toMatch(/^ok: /)
  })

  test('the old savvy tool name is not served', async ($, on) => {
    engine(on)
    await start($)
    const r = await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'T', total: 1 } as any).catch(() => null)
    expect(r === null || r?.result === undefined || !String(r.result).startsWith('ok')).toBe(true)
  })

  test('/flowdeck-agents opens a pane titled flowdeck', async ($, on) => {
    const { opened } = engine(on)
    await start($)
    const r = await $.command.run({ command: 'flowdeck-agents', args: '' } as any)
    expect(r.text).toBeDefined()
    expect(opened.some(o => o.id === 'flowdeck-agents' && o.title === 'flowdeck')).toBe(true)
  })
})
