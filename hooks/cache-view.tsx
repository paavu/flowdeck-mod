// The prompt cache in the band: the WARM / COLD chip with its summary and the Show/Hide button for the band's row, and
// the card below the row (idle time, tokens, the TTL line, the next message's cost per model, `prices are estimates`).
// The desktop draws Svgs, the terminal plain text. It draws only: the view, the fold and the press come from register.tsx.
import type { Elements, RenderChildren } from 'claude-code'

import { CACHE_HUE, CACHE_INK, CACHE_WORD, costLabel, FOOTER, MODELS, nextCost, summaryText, tokText, TTL_MS, ttlText, usd } from './cache'
import type { CacheMode, CacheView } from './cache'
import { idleText } from './time'
import { textWidth } from './plan-view'

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const ROW_H = 22 // the band row's height
/** The room the Show/Hide button and its gaps take beside the chip on the desktop row. */
export const CACHE_BUTTON_PX = 56
const CARD_MAX_W = 440
const PAD = 12

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// A word on its hue in dark ink, `size` px; the drawing's width comes back with it.
function chipShape(x: number, y: number, word: string, mode: CacheMode, size: number): { w: number; h: number; svg: string } {
  const h = Math.round(size + 6)
  const w = Math.round(textWidth(word, size, true) + word.length * 0.6 + 12)
  return {
    w,
    h,
    svg:
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${CACHE_HUE[mode]}"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="700" letter-spacing="0.6" fill="${CACHE_INK}">${esc(word)}</text>`,
  }
}

const SUMMARY_SIZE = 12.5

/** The desktop row's drawing: the chip and its summary in one Svg (sibling texts would wrap onto new lines). */
export function chipSvg(v: CacheView, wrap: (w: number, h: number, body: string) => string): { source: string; width: number; alt: string } {
  const chip = chipShape(0, (ROW_H - 16) / 2, CACHE_WORD[v.mode], v.mode, 10)
  const text = summaryText(v)
  const x = chip.w + 7
  const hue = CACHE_HUE[v.mode]
  const y = ROW_H / 2 + 4.5
  const [idle = '', cost] = v.mode === 'cold' ? text.split(' · ') : [text, undefined]
  // Each part at its own x: a renderer may drop the spaces at a tspan's edges.
  const at = (px: number, s: string, attrs: string) =>
    `<text x="${px.toFixed(1)}" y="${y}" font-family="${FONT}" font-size="${SUMMARY_SIZE}" font-variant-numeric="tabular-nums" ${attrs}>${esc(s)}</text>`
  const dotX = x + textWidth(idle, SUMMARY_SIZE, true) + 2
  const costX = dotX + 10
  const width = Math.ceil((cost ? costX + textWidth(cost, SUMMARY_SIZE, true) : x + textWidth(idle, SUMMARY_SIZE, true)) + 4)
  const body =
    chip.svg +
    at(x, idle, `fill="${hue}" font-weight="600"`) +
    (cost ? at(dotX, '·', 'class="m"') + at(costX, cost, 'class="t" font-weight="600"') : '')
  return { source: wrap(width, ROW_H, body), width, alt: `${CACHE_WORD[v.mode]}: ${text}` }
}

const priced = (v: CacheView) => MODELS.map(m => ({ m, cost: usd(nextCost(m, v.mode, v.tokens)), isMine: v.model?.id === m.id }))

/** The card's facts as plain lines, the terminal's card (and the desktop card's alt). */
export function cardLines(v: CacheView): { facts: string; label: string; models: { name: string; cost: string; isMine: boolean }[]; footer: string } {
  return {
    facts: `idle ${idleText(v.idleMs)} · ${tokText(v.tokens)} tokens cached · ${ttlText(v)}`,
    label: `${costLabel(v.mode)}:`,
    models: priced(v).map(p => ({ name: p.m.name, cost: p.cost, isMine: p.isMine })),
    footer: FOOTER,
  }
}

/** The desktop card below the band row, `W` px wide at most (a narrow band gets two models a row). */
export function cardSvg(v: CacheView, W: number, wrap: (w: number, h: number, body: string) => string): { source: string; width: number; height: number; alt: string } {
  const width = Math.max(180, Math.min(CARD_MAX_W, Math.round(W)))
  const hue = CACHE_HUE[v.mode]
  const t = (x: number, y: number, s: string, size: number, attrs: string) =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" ${attrs}>${esc(s)}</text>`
  let g = ''
  // The chip, then the idle time and the tokens.
  const chip = chipShape(PAD, 10, CACHE_WORD[v.mode], v.mode, 10)
  g += chip.svg
  g += t(PAD + chip.w + 8, 23, `idle ${idleText(v.idleMs)} · ${tokText(v.tokens)} tokens cached`, 12.5, 'class="t" font-weight="500"')
  // The TTL line and the hour as a bar: how much of it has gone.
  const ttl = ttlText(v)
  g += t(PAD, 48, ttl, 11.5, `fill="${hue}" font-weight="600"`)
  const barX = Math.round(PAD + textWidth(ttl, 11.5, true) + 10)
  const barW = Math.max(20, width - PAD - barX)
  const gone = Math.min(1, v.idleMs / TTL_MS)
  g += `<rect class="k" x="${barX}" y="41" width="${barW}" height="6" rx="3"/>`
  g += `<rect x="${barX}" y="41" width="${Math.max(gone > 0 ? 3 : 0, Math.round(barW * gone))}" height="6" rx="3" fill="${hue}"/>`
  // What the next message costs on each model; the session's model is marked YOU.
  g += t(PAD, 71, costLabel(v.mode), 11, 'class="s"')
  const cols = width >= 380 ? 4 : 2
  const cellW = (width - PAD * 2) / cols
  const ROW = 36
  priced(v).forEach((p, i) => {
    const x = Math.round(PAD + (i % cols) * cellW)
    const y = 92 + Math.floor(i / cols) * ROW
    g += t(x, y, p.m.name, 11, p.isMine ? `fill="${hue}" font-weight="700"` : 'class="s" font-weight="600"')
    if (p.isMine) g += chipShape(x + Math.round(textWidth(p.m.name, 11, true)) + 6, y - 10, 'YOU', v.mode, 8).svg
    g += t(x, y + 18, p.cost, 14, p.isMine ? 'class="t" font-weight="700"' : 'class="m" font-weight="500"')
  })
  const footerY = 92 + Math.ceil(MODELS.length / cols) * ROW + 4
  g += t(PAD, footerY, FOOTER, 10.5, 'class="m"')
  const height = footerY + 10
  const lines = cardLines(v)
  const alt =
    `Cache ${v.mode}: ${lines.facts}. ${costLabel(v.mode)}: ` +
    lines.models.map(m => `${m.name} ${m.cost}${m.isMine ? ' (you)' : ''}`).join(', ') +
    `. ${FOOTER}.`
  const body = `<rect class="tile" x="0" y="0" width="${width}" height="${height}" rx="10"/>${g}`
  return { source: wrap(width, height, body), width, height, alt }
}

export type CacheUi = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'> & { Svg: Elements['desktop']['Svg'] | null }

export type CacheDrawing = {
  /** The chip, its summary and the Show/Hide button, as siblings for the band's row. */
  row: RenderChildren[]
  /** What `row` takes: px on the desktop, columns in the terminal. */
  size: number
  /** The card below the band's row; null while folded. */
  card: RenderChildren
}

/**
 * The cache's part of the band. `Svg` null draws the terminal's text. `bandW` is the band's width in px (the desktop card
 * is at most that wide); `wrap` is the panel's svg wrapper (its light and dark classes).
 */
export function cacheDrawing(
  ui: CacheUi,
  v: CacheView,
  open: boolean,
  onToggle: () => unknown,
  bandW: number,
  wrap: (w: number, h: number, body: string) => string,
): CacheDrawing {
  const { Box, Text, Button, Svg } = ui
  const button = <Button key="cache-fold" label={open ? 'Hide' : 'Show'} plain dimColor onPress={() => void onToggle()} />
  if (Svg) {
    const chip = chipSvg(v, wrap)
    const card = open ? cardSvg(v, bandW, wrap) : null
    return {
      row: [<Svg key="cache-chip" source={chip.source} alt={chip.alt} width={chip.width} height={ROW_H} />, button],
      size: chip.width + CACHE_BUTTON_PX,
      card: card ? (
        <Box key="cache-card" flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
          <Svg source={card.source} alt={card.alt} width={card.width} height={card.height} />
        </Box>
      ) : null,
    }
  }
  const hue = CACHE_HUE[v.mode]
  const text = summaryText(v)
  const [idle, cost] = v.mode === 'cold' ? text.split(' · ') : [text, undefined]
  const word = ` ${CACHE_WORD[v.mode]} `
  const chip = (
    <Box key="cache-chip" flexDirection="row" flexShrink={0}>
      <Text backgroundColor={hue} color={CACHE_INK} bold>
        {word}
      </Text>
      <Text color={hue} bold>{` ${idle ?? ''}`}</Text>
      {cost ? <Text dimColor>{' · '}</Text> : null}
      {cost ? <Text bold>{cost}</Text> : null}
    </Box>
  )
  const lines = cardLines(v)
  const card = open ? (
    <Box key="cache-card" flexDirection="column">
      <Text wrap="truncate-end">{lines.facts}</Text>
      <Text wrap="truncate-end">{lines.label}</Text>
      <Text wrap="truncate-end">
        {lines.models.map((m, i) => (
          <Text key={`cache-model-${i}`}>
            {i ? ' · ' : ''}
            {`${m.name} ${m.cost}`}
            {m.isMine ? (
              <Text color={hue} bold>
                {' YOU'}
              </Text>
            ) : null}
          </Text>
        ))}
      </Text>
      <Text dimColor wrap="truncate-end">
        {lines.footer}
      </Text>
    </Box>
  ) : null
  // The chip, a space, the summary, then the button and the gaps around it.
  return { row: [chip, button], size: word.length + 1 + text.length + 2 + 4 + 2, card }
}
