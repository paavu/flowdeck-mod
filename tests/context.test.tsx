import { describe, expect, test } from 'claude-code/testing'

import { cells, contextRows, contextSvg, legend, share, toReading, tokens } from '../hooks/context'

// /context's breakdown as the engine hands it over, for a 1M window.
const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_400, color: 'promptBorder', kind: 'used' },
    { name: 'System tools', tokens: 12_000, color: 'inactive', kind: 'used' },
    { name: 'MCP tools', tokens: 2_600, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', kind: 'deferred' },
    { name: 'Skills', tokens: 0, color: 'warning', kind: 'used' },
    { name: 'Messages', tokens: 186_000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', kind: 'buffer' },
    { name: 'Free space', tokens: 746_000, color: 'promptBorder', kind: 'free' },
  ],
  totalTokens: 204_000,
  rawMaxTokens: 1_000_000,
  percentage: 20,
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
}

describe('context module', () => {
  test('tokens and share read well', () => {
    expect(tokens(3_400)).toBe('3.4k')
    expect(tokens(186_000)).toBe('186k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(tokens(950)).toBe('950')
    expect(share(3_400, 1_000_000)).toBe('0.3%')
    expect(share(186_000, 1_000_000)).toBe('19%')
    expect(share(494, 1_000_000)).toBe('<0.1%')
  })

  test('toReading drops deferred and empty rows, keeps the compaction point', () => {
    const r = toReading(BREAKDOWN)
    expect(r.slices.map(s => s.name)).toEqual(['system prompt', 'system tools', 'mcp tools', 'messages', 'free space', 'autocompact buffer'])
    expect(r.compactsAt).toBe(950_000)
    const colors = r.slices.filter(s => s.kind === 'used').map(s => s.color)
    expect(new Set(colors).size).toBe(colors.length)
    expect(toReading({ ...BREAKDOWN, isAutoCompactEnabled: false }).compactsAt).toBeUndefined()
  })

  test('the bar is always exactly the width and a small used slice still shows', () => {
    const r = toReading(BREAKDOWN)
    for (const width of [20, 47, 80, 200]) {
      const bar = cells(r, width)
      expect(bar.reduce((n, c) => n + c.text.length, 0)).toBe(width)
      expect(bar.filter(c => c.kind === 'used').every(c => c.text.length >= 1)).toBe(true)
    }
    for (const line of legend(r, 40)) {
      const size = line.reduce((n, s, i) => n + (i ? 3 : 0) + 2 + s.name.length + 1 + tokens(s.tokens).length + (s.kind === 'used' ? 1 + share(s.tokens, r.window).length : 0), 0)
      expect(size <= 40 || line.length === 1).toBe(true)
    }
  })

  test('contextSvg draws one rect per slice and a header', () => {
    const r = toReading(BREAKDOWN)
    const { height, body } = contextSvg(400, r)
    expect((body.match(/<rect /g) ?? []).length).toBe(r.slices.length)
    expect(body).toContain('204k of 1M · compacts at 950k')
    expect(body).toContain('messages 186k')
    expect(height).toBeGreaterThan(40)
  })

  test('contextRows fit the columns', () => {
    const r = toReading(BREAKDOWN)
    const rows = contextRows(r, 60)
    expect(rows[0]).toContain('204k of 1M')
    expect(rows.every(row => row.length <= 60)).toBe(true)
    expect(rows[1]!.length).toBe(60)
  })

  test('collapsed, only the head line and the bar remain', () => {
    const r = toReading(BREAKDOWN)
    expect(contextRows(r, 60, true).length).toBe(2)
    expect(contextRows(r, 60).length).toBeGreaterThan(2)
    const full = contextSvg(400, r)
    const small = contextSvg(400, r, true)
    expect(small.height).toBeLessThan(full.height)
    expect(small.body).toContain('204k of 1M')
    expect((small.body.match(/<rect /g) ?? []).length).toBe(r.slices.length)
    expect(small.body).not.toContain('messages 186k')
  })
})
