import { describe, expect, test } from 'claude-code/testing'

import { SMALL_SIZE } from '../hooks/sizes'
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
    test(`a dim v<version> at the far end of the top row, after Context, Usage, Band and Keep warm (${surface})`, async ($, on) => {
      engine(on)
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' } as any)
      const p = await pane($, surface)
      const root = await p.drawn()
      await p.unmount()
      const row = walk(root).find(n => n?.props?.key === 'top-toggles')
      const kids: any[] = row.children
      const buttons: any[] = kids[0]?.children ?? []
      expect(buttons.slice(0, 3).map(c => c?.props?.key)).toEqual(['context', 'usage', 'band'])
      expect((buttons[3]?.children ?? []).map((c: any) => c?.type)).toEqual([surface === 'desktop' ? 'Svg' : 'Text', 'Button'])
      expect(kids[1]?.props?.flexGrow).toBe(1)
      if (surface === 'desktop') {
        const label = walk(kids[2]).find(n => n?.type === 'Svg')
        expect(label.props.alt).toBe(`v${VERSION}`)
        expect(label.props.source).toContain(`font-size="${SMALL_SIZE}"`)
        expect(label.props.source).toContain('text-anchor="end"')
        expect(label.props.source).toContain('class="m"')
        expect(label.props.source).toContain(`>v${VERSION}</text>`)
        expect(row.props.flexWrap).toBe('nowrap')
      } else {
        const label = walk(kids[2]).find(n => n?.type === 'Text')
        expect(textOf(label)).toBe(`v${VERSION}`)
        expect(label.props.dimColor).toBe(true)
      }
      expect(kids[2]?.props?.flexShrink).toBe(0)
    })
  }

  test('the fallback drawing shows it too', async ($, on) => {
    engine(on)
    on('state.get', { plugin: 'flowdeck', key: 'panel' }, () => ({ deny: 'panel down' })) // the whole panel fails
    for (const surface of ['desktop', 'terminal'] as const) {
      const p = await pane($, surface)
      expect(await p.find({ type: 'Text', text: 'flowdeck could not draw this panel' })).toBeDefined()
      expect(await p.find(surface === 'desktop' ? { type: 'Svg', alt: `v${VERSION}` } : { type: 'Text', text: `v${VERSION}` })).toBeDefined()
      expect(await p.find({ type: 'Text', text: 'FlowDeck' })).toBeDefined()
      expect(await p.find({ type: 'Button', text: /Track tasks/ })).toBeDefined()
      await p.unmount()
    }
  })
})
