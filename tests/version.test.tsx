import { describe, expect, test } from 'claude-code/testing'

import { VERSION } from '../hooks/version'

// The panel names the version of the code running (hooks/version.ts, loaded with the mod), never plugin.json read at run
// time. Every release changes both: the engine hands the manifest's version to `plugin.register` as it loads the mod, and
// the first test fails when the two differ (a test cannot read plugin.json itself: no file access, code files only).

function engine(on: any) {
  const manifest = { version: '' }
  on('plugin.register', (_$: any, e: any, next: any) => {
    if (e.name === 'flowdeck') manifest.version = String(e.version ?? '')
    return next(e)
  })
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 30, 9, 0) }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 0, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  return manifest
}

const pane = ($: any, surface: 'desktop' | 'terminal') => $.ui.mount({ plugin: 'flowdeck', surface, component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
const walk = (n: any): any[] => (n && typeof n === 'object' ? [n, ...(Array.isArray(n) ? n : (n.children ?? [])).flatMap(walk)] : [])
const textOf = (n: any): string => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''))

describe('the running version', () => {
  test('hooks/version.ts names the version plugin.json declares, in the M.m.xxxx form', async ($, on) => {
    const manifest = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d{4}$/)
    expect(VERSION).toBe(manifest.version)
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`a dim v<version> at the far end of the top row, after Context and Usage (${surface})`, async ($, on) => {
      engine(on)
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
      const p = await pane($, surface)
      const root = await p.drawn()
      await p.unmount()
      const row = walk(root).find(n => n?.props?.key === 'top-toggles')
      const kids: any[] = row.children
      expect(kids.findIndex(c => c?.props?.key === 'context')).toBe(0)
      expect(kids.findIndex(c => c?.props?.key === 'usage')).toBe(1)
      expect(kids[2]?.props?.flexGrow).toBe(1)
      const label = walk(kids[3]).find(n => n?.type === 'Text')
      expect(textOf(label)).toBe(`v${VERSION}`)
      expect(label.props.dimColor).toBe(true)
      expect(kids[3]?.props?.flexShrink).toBe(0)
    })
  }

  test('the fallback drawing shows it too', async ($, on) => {
    engine(on)
    on('state.get', { plugin: 'flowdeck', key: 'panel' }, () => ({ deny: 'panel down' })) // the whole panel fails
    for (const surface of ['desktop', 'terminal'] as const) {
      const p = await pane($, surface)
      expect(await p.find({ type: 'Text', text: 'flowdeck could not draw this panel' })).toBeDefined()
      expect(await p.find({ type: 'Text', text: `v${VERSION}` })).toBeDefined()
      await p.unmount()
    }
  })
})
