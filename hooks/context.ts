// The context window as data and as drawings, for the flowdeck panel. The maths is context-bar's (hamzafer, MIT).
import type { Reading, Slice } from '../types'

const SPLIT = '   '
// /context's theme gives several rows the same grey, so each used row gets its own color, in order.
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#ff9e64', '#c0caf5']
const MESSAGES = '#d97757' // the row that grows, in the accent color
const FREE = '#808080'
const BUFFER = '#808080'
const GLYPH = { used: '█', free: '─', buffer: '░' } as const
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

export function toReading(b: {
  categories: { name: string; tokens: number; color: string; kind: string }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
}): Reading {
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens, color: c.color, kind: c.kind as Slice['kind'] }))
  const order = { used: 0, free: 1, buffer: 2 }
  slices.sort((x, y) => order[x.kind] - order[y.kind]) // stable: used rows keep /context's order
  let next = 0
  for (const s of slices) {
    s.color = s.kind === 'free' ? FREE : s.kind === 'buffer' ? BUFFER : s.name === 'messages' ? MESSAGES : PALETTE[next++ % PALETTE.length]!
  }
  return {
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
  }
}

// The bar as runs of cells: each slice gets its share of `width`, a used one at least one cell.
export function cells(r: Reading, width: number) {
  const sizes = r.slices.map(s => Math.max(s.kind === 'used' ? 1 : 0, Math.round((s.tokens / r.window) * width)))
  // Rounding leaves the sum a few cells off: free space takes the difference first, then the largest slices.
  let diff = width - sizes.reduce((a, n) => a + n, 0)
  const isUsed = (i: number) => r.slices[i]!.kind === 'used'
  const order = r.slices.map((_, i) => i).sort((a, b) => Number(isUsed(a)) - Number(isUsed(b)) || sizes[b]! - sizes[a]!)
  for (const i of order) {
    if (diff === 0) break
    const size = Math.max(isUsed(i) ? 1 : 0, sizes[i]! + diff)
    diff -= size - sizes[i]!
    sizes[i] = size
  }
  return r.slices.map((s, i) => ({ color: s.color, kind: s.kind, text: GLYPH[s.kind].repeat(sizes[i]!) })).filter(c => c.text !== '')
}

// The legend, packed into lines no wider than `width`.
export function legend(r: Reading, width: number) {
  const lines: Slice[][] = [[]]
  let used = 0
  for (const s of r.slices) {
    const size = 2 + s.name.length + 1 + tokens(s.tokens).length + (s.kind === 'used' ? 1 + share(s.tokens, r.window).length : 0)
    const line = lines.at(-1)!
    if (line.length > 0 && used + SPLIT.length + size > width) {
      lines.push([s])
      used = size
    } else {
      used += (line.length > 0 ? SPLIT.length : 0) + size
      line.push(s)
    }
  }
  return lines.filter(l => l.length > 0)
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function share(n: number, window: number) {
  const p = (n / window) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p >= 10 ? Math.round(p) : +p.toFixed(1)}%`
}

const headOf = (r: Reading) => `${tokens(r.total)} of ${tokens(r.window)}${r.compactsAt ? ` · compacts at ${tokens(r.compactsAt)}` : ''}`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The terminal text: the head line, the bar, then the legend lines, none wider than `columns`.
export function contextRows(r: Reading, columns: number): string[] {
  const head = `${headOf(r)}  ${r.percent}%`
  const rows = [head.length > columns ? head.slice(0, columns) : head, cells(r, columns).map(c => c.text).join('')]
  for (const line of legend(r, columns)) {
    rows.push(line.map(s => `${s.kind === 'used' ? '■' : GLYPH[s.kind]} ${s.name} ${tokens(s.tokens)}${s.kind === 'used' ? ` ${share(s.tokens, r.window)}` : ''}`).join(SPLIT))
  }
  return rows
}

// The desktop drawing, as the inside of the panel's svg (text uses its `t` and `s` classes): header, proportional bar, legend.
export function contextSvg(width: number, r: Reading): { height: number; body: string } {
  const barY = 24
  const barH = 12
  let x = 0
  const rects = r.slices
    .map(s => {
      const w = Math.max(s.kind === 'used' ? 1 : 0, (s.tokens / r.window) * width)
      const rect = w > 0 ? `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" fill="${s.color}" opacity="${s.kind === 'used' ? 1 : 0.35}"/>` : ''
      x += w
      return rect
    })
    .join('\n')
  const lines = legend(r, Math.max(20, Math.floor(width / 7)))
  const rows = lines
    .map((line, i) => {
      const y = barY + barH + 18 + i * 16
      const text = line
        .map(s => `<tspan fill="${s.color}">${s.kind === 'used' ? '■ ' : '□ '}</tspan><tspan class="${s.kind === 'used' ? 't' : 's'}">${esc(s.name)} ${tokens(s.tokens)}${s.kind === 'used' ? ` ${share(s.tokens, r.window)}` : ''}</tspan>`)
        .join('<tspan>   </tspan>')
      return `<text x="0" y="${y}" font-family="${FONT}" font-size="11">${text}</text>`
    })
    .join('\n')
  const body = `<text class="t" x="0" y="14" font-family="${FONT}" font-size="12" font-weight="600">context</text>
<text class="s" x="${width}" y="14" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${esc(headOf(r))}  ${r.percent}%</text>
${rects}
${rows}`
  return { height: barY + barH + 22 + Math.max(1, lines.length) * 16, body }
}
