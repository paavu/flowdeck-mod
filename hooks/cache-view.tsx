// The prompt cache in the band: the WARM / COLD chip with its summary and the fold chevron beside it for the band's row,
// and the card below the row (idle time, tokens, the TTL line, keep warm's state, what a renewal costs beside a cold
// restart, the next message's cost per model, `prices are estimates`).
// The desktop draws Svgs, the terminal plain text. It draws only: the view, the fold and the press come from register.tsx.
import type { Elements, RenderChildren } from 'claude-code'

import { CACHE_HUE, CACHE_INK, CACHE_WORD, costLabel, FOOTER, keepText, MODELS, nextCost, renewalText, summaryText, tokText, TTL_MS, ttlText, usd } from './cache'
import type { CacheMode, CacheView } from './cache'
import { foldGlyph } from './fold'
import { idleText } from './time'
import { textWidth } from './plan-view'

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const ROW_H = 22 // the band row's height
/** CSS px the desktop app draws at each side of a plain Button's label (measured in the app: 11); the kit has no prop for it. */
export const BUTTON_PAD_PX = 11
/** CSS px a band card leaves before its first drawing, as wide as the room its last part, a plain Button, keeps after its label. */
export const CARD_INSET_PX = BUTTON_PAD_PX
/** CSS px of a reported column on the desktop, and so of one cell of the kit's margins (measured in the app: about 9). */
export const COLUMN_PX = 9
/** CSS px between neighbours on the band's cards: chip to summary, summary to chevron, chevron to crew icon, icon to count. */
export const ITEM_GAP_PX = 7
/**
 * A Button after a drawing on a card sits one cell over the drawing's end (marginLeft -1), since its own room
 * (BUTTON_PAD_PX) is wider than ITEM_GAP_PX: the drawing keeps TAIL_PX after its last mark so the label lands ITEM_GAP_PX on.
 */
export const TAIL_PX = ITEM_GAP_PX + COLUMN_PX - BUTTON_PAD_PX
/** CSS px of the fold chevron's glyph on the desktop (measured in the app: 9). */
export const FOLD_GLYPH_PX = 9
/** CSS px the fold chevron's Button adds to the cache card: the glyph and the Button's own room, less the cell it sits over the chip. */
export const CACHE_FOLD_PX = FOLD_GLYPH_PX + 2 * BUTTON_PAD_PX - COLUMN_PX
/** The card's widest; from WIDE_MIN_W on it draws two columns when their texts fit side by side, else it stacks. */
export const CARD_MAX_W = 760
export const WIDE_MIN_W = 520
const PAD = 12
const COL_GAP = 24 // between the two columns, the faint divider in its middle
const GAP = 14 // between two texts on one line
const CELL_GAP = 12 // between two model cells
const MIN_BAR = 40

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

// The summary's advances at SUMMARY_SIZE, weight 600, measured in the desktop's engine (Chromium, SF Pro on macOS): the
// drawing ends TAIL_PX after the text, so the chevron's gap follows the real width (plan-view's estimate ran 10 px wide).
const SUMMARY_ADVANCE: Record<string, number> = {
  '0': 8.3, '1': 6.17, '2': 7.84, '3': 8.16, '4': 8.38, '5': 8.08, '6': 8.33, '7': 7.38, '8': 8.41, '9': 8.33,
  m: 11.36, h: 7.69, d: 7.95, l: 3.48, e: 7.36, f: 4.88, t: 4.92, '<': 8.19, $: 8.19, '.': 4.11, ' ': 3.28,
}
/** The summary text's width in CSS px on the desktop row; a character outside the table takes plan-view's estimate. */
export const summaryWidth = (s: string): number => [...s].reduce((w, ch) => w + (SUMMARY_ADVANCE[ch] ?? textWidth(ch, SUMMARY_SIZE, true)), 0)

/**
 * The desktop row's drawing: the chip and its summary in one Svg (sibling texts would wrap onto new lines), `inset` px in;
 * `end` is where the summary's last text ends.
 */
export function chipSvg(v: CacheView, wrap: (w: number, h: number, body: string) => string, inset = 0): { source: string; width: number; alt: string; end: number } {
  const chip = chipShape(inset, (ROW_H - 16) / 2, CACHE_WORD[v.mode], v.mode, 10)
  const text = summaryText(v)
  const x = inset + chip.w + ITEM_GAP_PX
  const hue = CACHE_HUE[v.mode]
  const y = ROW_H / 2 + 4.5
  const [idle = '', cost] = v.mode === 'cold' ? text.split(' · ') : [text, undefined]
  // Each part at its own x: a renderer may drop the spaces at a tspan's edges.
  const at = (px: number, s: string, attrs: string) =>
    `<text x="${px.toFixed(1)}" y="${y}" font-family="${FONT}" font-size="${SUMMARY_SIZE}" font-variant-numeric="tabular-nums" ${attrs}>${esc(s)}</text>`
  const dotX = x + textWidth(idle, SUMMARY_SIZE, true) + 2
  const costX = dotX + 10
  const end = cost ? costX + summaryWidth(cost) : x + summaryWidth(idle)
  const width = Math.ceil(end + TAIL_PX)
  const body =
    chip.svg +
    at(x, idle, `fill="${hue}" font-weight="600"`) +
    (cost ? at(dotX, '·', 'class="m"') + at(costX, cost, 'class="t" font-weight="600"') : '')
  return { source: wrap(width, ROW_H, body), width, alt: `${CACHE_WORD[v.mode]}: ${text}`, end }
}

const priced = (v: CacheView) => MODELS.map(m => ({ m, cost: usd(nextCost(m, v.mode, v.tokens)), isMine: v.model?.id === m.id }))

/** The card's facts as plain lines, the terminal's card (and the desktop card's alt); `renewal` is null for an unpriced model. */
export function cardLines(v: CacheView): { facts: string; keep: string; renewal: string | null; label: string; models: { name: string; cost: string; isMine: boolean }[]; footer: string } {
  return {
    facts: `idle ${idleText(v.idleMs)} · ${tokText(v.tokens)} tokens cached · ${ttlText(v)}`,
    keep: keepText(v.keep),
    renewal: renewalText(v),
    label: `${costLabel(v.mode)}:`,
    models: priced(v).map(p => ({ name: p.m.name, cost: p.cost, isMine: p.isMine })),
    footer: FOOTER,
  }
}

// The card's texts: size, weight (600 and up is measured bold) and colour.
type Style = { size: number; weight: number; paint: string }
const FACTS: Style = { size: 12.5, weight: 500, paint: 'class="t"' }
const KEEP: Style = { size: 11.5, weight: 500, paint: 'class="t"' }
const RENEW: Style = { size: 11, weight: 400, paint: 'class="s"' }
const CAPTION: Style = { size: 11, weight: 400, paint: 'class="s"' }
const FOOT: Style = { size: 10.5, weight: 400, paint: 'class="m"' }
const ttlStyle = (v: CacheView): Style => ({ size: 11.5, weight: 600, paint: `fill="${CACHE_HUE[v.mode]}"` })
const nameStyle = (v: CacheView, isMine: boolean): Style => (isMine ? { size: 11, weight: 700, paint: `fill="${CACHE_HUE[v.mode]}"` } : { size: 11, weight: 600, paint: 'class="s"' })
const priceStyle = (isMine: boolean): Style => (isMine ? { size: 14, weight: 700, paint: 'class="t"' } : { size: 14, weight: 500, paint: 'class="m"' })

const widthOf = (s: string, st: Style): number => textWidth(s, st.size, st.weight >= 600)
const textAt = (x: number, y: number, s: string, st: Style): string =>
  `<text x="${Math.round(x)}" y="${y}" font-family="${FONT}" font-size="${st.size}" font-weight="${st.weight}" ${st.paint}>${esc(s)}</text>`

/** `s` as lines at most `maxW` wide: broken at its ` · ` first, then at spaces; a word wider than `maxW` stays whole. */
function wrapText(s: string, st: Style, maxW: number): string[] {
  const fits = (x: string) => widthOf(x, st) <= maxW
  if (fits(s)) return [s]
  const lines: string[] = []
  let cur = ''
  for (const group of s.split(' · ')) {
    const joined = cur ? `${cur} · ${group}` : group
    if (fits(joined)) {
      cur = joined
      continue
    }
    if (cur) lines.push(cur)
    cur = ''
    for (const word of group.split(' ')) {
      const next = cur ? `${cur} ${word}` : word
      if (!cur || fits(next)) cur = next
      else {
        lines.push(cur)
        cur = word
      }
    }
  }
  if (cur) lines.push(cur)
  return lines
}

// What every layout draws: the chip, the texts, the hour's bar and the four model cells.
function parts(v: CacheView) {
  const lines = cardLines(v)
  const chip = chipShape(PAD, 10, CACHE_WORD[v.mode], v.mode, 10)
  const facts = `idle ${idleText(v.idleMs)} · ${tokText(v.tokens)} tokens cached`
  const ttl = ttlText(v)
  const youW = chipShape(0, 0, 'YOU', v.mode, 8).w
  // Each model's cell is as wide as its name (with YOU beside the session's) or its price.
  const models = priced(v).map(p => {
    const nameW = widthOf(p.m.name, nameStyle(v, p.isMine))
    return { ...p, nameW, w: Math.max(nameW + (p.isMine ? 6 + youW : 0), widthOf(p.cost, priceStyle(p.isMine))) }
  })
  const cellW = Math.max(...models.map(p => p.w))
  const bar = (x: number, y: number, w: number) => {
    const gone = Math.min(1, v.warmMs / TTL_MS)
    const hue = CACHE_HUE[v.mode]
    return (
      `<rect class="k" x="${x}" y="${y}" width="${w}" height="6" rx="3"/>` +
      `<rect x="${x}" y="${y}" width="${Math.max(gone > 0 ? 3 : 0, Math.round(w * gone))}" height="6" rx="3" fill="${hue}"/>`
    )
  }
  // A model's name over its price at (x, y), the name's baseline; the session's model is marked YOU.
  const cell = (p: (typeof models)[number], x: number, y: number) =>
    textAt(x, y, p.m.name, nameStyle(v, p.isMine)) +
    (p.isMine ? chipShape(Math.round(x + p.nameW + 6), y - 10, 'YOU', v.mode, 8).svg : '') +
    textAt(x, y + 18, p.cost, priceStyle(p.isMine))
  return { lines, chip, facts, ttl, models, cellW, bar, cell, caption: costLabel(v.mode) }
}

type Drawn = { g: string; height: number }

/**
 * Two columns, about three rows: left the chip with the idle time and the tokens, the TTL line with the hour's bar, keep
 * warm's state with the renewal and cold costs; right, past a faint divider, the caption with `prices are estimates` at
 * its end, then the four models side by side. A line that does not fit goes to a fourth row (the costs below keep warm's
 * state, the footer below the models); null when even that is too wide.
 */
function twoColumns(v: CacheView, width: number): Drawn | null {
  const { lines, chip, facts, ttl, models, bar, cell, caption } = parts(v)
  const keepW = widthOf(lines.keep, KEEP)
  const renW = lines.renewal ? widthOf(lines.renewal, RENEW) : 0
  const ttlW = widthOf(ttl, ttlStyle(v))
  const capW = widthOf(caption, CAPTION)
  const footW = widthOf(FOOTER, FOOT)
  const sumW = models.reduce((n, p) => n + p.w, 0)
  const cellsW = sumW + (models.length - 1) * CELL_GAP
  const inner = width - PAD * 2 - COL_GAP
  for (const [isKeepLine, isFootUp] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    const leftW = Math.max(chip.w + 8 + widthOf(facts, FACTS), ttlW + 10 + MIN_BAR, isKeepLine && lines.renewal ? keepW + GAP + renW : Math.max(keepW, renW))
    const rightW = Math.ceil(Math.max(cellsW, isFootUp ? capW + GAP + footW : Math.max(capW, footW)))
    if (leftW + rightW > inner) continue
    const rightX = width - PAD - rightW
    const leftEnd = rightX - COL_GAP
    let g = chip.svg + textAt(PAD + chip.w + 8, 23, facts, FACTS)
    g += textAt(PAD, 46, ttl, ttlStyle(v))
    const barX = Math.round(PAD + ttlW + 10)
    g += bar(barX, 39, Math.max(MIN_BAR, Math.floor(leftEnd - barX)))
    g += textAt(PAD, 68, lines.keep, KEEP)
    if (lines.renewal) g += isKeepLine ? textAt(PAD + keepW + GAP, 68, lines.renewal, RENEW) : textAt(PAD, 86, lines.renewal, RENEW)
    g += textAt(rightX, 23, caption, CAPTION)
    // The cells side by side, the room left over shared out between them.
    const spread = (rightW - sumW) / Math.max(1, models.length - 1)
    let cellX = rightX
    for (const p of models) {
      g += cell(p, cellX, 46)
      cellX += p.w + spread
    }
    const footX = Math.floor(rightX + rightW - footW)
    g += textAt(footX, isFootUp ? 23 : 84, FOOTER, FOOT)
    const height = Math.max(isKeepLine || !lines.renewal ? 68 : 86, isFootUp ? 64 : 84) + 14
    const divX = rightX - COL_GAP / 2
    g += `<line class="ln" x1="${divX}" y1="12" x2="${divX}" y2="${height - 12}" stroke-width="1"/>`
    return { g, height }
  }
  return null
}

/** One column, every line wrapped to the width: the narrow band's card (two models a row, or one, when four do not fit). */
function stacked(v: CacheView, width: number): Drawn {
  const { lines, chip, facts, ttl, models, cellW, bar, cell, caption } = parts(v)
  const inner = width - PAD * 2
  const right = width - PAD
  let g = chip.svg
  const factsX = PAD + chip.w + 8
  const factLines = wrapText(facts, FACTS, right - factsX)
  factLines.forEach((s, i) => (g += textAt(factsX, 23 + i * 17, s, FACTS)))
  let y = 23 + (factLines.length - 1) * 17 + 23
  const ttlStyled = ttlStyle(v)
  g += textAt(PAD, y, ttl, ttlStyled)
  const barX = Math.round(PAD + widthOf(ttl, ttlStyled) + 10)
  g += bar(barX, y - 7, Math.max(20, right - barX))
  y += 22
  const keepLines = wrapText(lines.keep, KEEP, inner)
  keepLines.forEach((s, i) => (g += textAt(PAD, y + i * 17, s, KEEP)))
  y += (keepLines.length - 1) * 17
  if (lines.renewal) {
    const afterX = PAD + widthOf(keepLines[keepLines.length - 1] ?? '', KEEP) + GAP
    if (afterX + widthOf(lines.renewal, RENEW) <= right) g += textAt(afterX, y, lines.renewal, RENEW)
    else
      for (const s of wrapText(lines.renewal, RENEW, inner)) {
        y += 17
        g += textAt(PAD, y, s, RENEW)
      }
  }
  y += 23
  const capLines = wrapText(caption, CAPTION, inner)
  capLines.forEach((s, i) => (g += textAt(PAD, y + i * 16, s, CAPTION)))
  y += (capLines.length - 1) * 16
  const footW = widthOf(FOOTER, FOOT)
  const isFootUp = PAD + widthOf(capLines[capLines.length - 1] ?? '', CAPTION) + GAP + footW <= right
  if (isFootUp) g += textAt(Math.floor(right - footW), y, FOOTER, FOOT)
  const cols = [4, 2].find(c => cellW + 4 <= inner / c) ?? 1
  const step = inner / cols
  models.forEach((p, i) => (g += cell(p, PAD + (i % cols) * step, y + 21 + Math.floor(i / cols) * 36)))
  y += 21 + (Math.ceil(models.length / cols) - 1) * 36 + 18
  if (!isFootUp) {
    y += 22
    g += textAt(PAD, y, FOOTER, FOOT)
  }
  return { g, height: y + 12 }
}

/**
 * The desktop card below the band row: the band's width up to CARD_MAX_W, in two columns of about three rows when they
 * fit (from WIDE_MIN_W on), else one stacked column. Every text is measured, so none overlaps another or leaves the card.
 */
export function cardSvg(v: CacheView, W: number, wrap: (w: number, h: number, body: string) => string): { source: string; width: number; height: number; alt: string } {
  const width = Math.max(180, Math.min(CARD_MAX_W, Math.round(W)))
  const { g, height } = (width >= WIDE_MIN_W && twoColumns(v, width)) || stacked(v, width)
  const lines = cardLines(v)
  const alt =
    `Cache ${v.mode}: ${lines.facts}. ${lines.keep}.${lines.renewal ? ` ${lines.renewal}.` : ''} ${costLabel(v.mode)}: ` +
    lines.models.map(m => `${m.name} ${m.cost}${m.isMine ? ' (you)' : ''}`).join(', ') +
    `. ${FOOTER}.`
  const body = `<rect class="tile" x="0" y="0" width="${width}" height="${height}" rx="10"/>${g}`
  return { source: wrap(width, height, body), width, height, alt }
}

export type CacheUi = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'> & { Svg: Elements['desktop']['Svg'] | null }

export type CacheDrawing = {
  /** The chip with its summary, then the chevron that opens or folds the card, as siblings for the band's row. */
  row: RenderChildren[]
  /** What `row` takes: px on the desktop, columns in the terminal. */
  size: number
  /** The card below the band's row; null while folded. */
  card: RenderChildren
}

/**
 * The cache's part of the band. `Svg` null draws the terminal's text. `bandW` is the band's width in px (the desktop card
 * is at most that wide); `wrap` is the panel's svg wrapper (its light and dark classes); `columns` the terminal's width
 * (0 when unknown: the terminal card's footer then takes its own line). `isJoined`: another card follows on the desktop
 * row, so the chevron's Button also reaches one cell past the card's end and the card ends 2 px after the glyph.
 */
export function cacheDrawing(
  ui: CacheUi,
  v: CacheView,
  open: boolean,
  onToggle: () => unknown,
  bandW: number,
  wrap: (w: number, h: number, body: string) => string,
  columns = 0,
  isJoined = false,
): CacheDrawing {
  const { Box, Text, Button, Svg } = ui
  // The kit has no pressable wrapper: a Button carries only a text label (Svg or coloured Texts inside it are lost) and
  // neither Svg nor Box takes a press. So the chip keeps its look and the one-glyph chevron beside it folds the card.
  const fold = <Button key="cache-fold" label={foldGlyph(open)} plain dimColor onPress={() => void onToggle()} />
  if (Svg) {
    const chip = chipSvg(v, wrap, CARD_INSET_PX) // the desktop row always draws it on its card
    const card = open ? cardSvg(v, bandW, wrap) : null
    return {
      row: [
        <Svg key="cache-chip" source={chip.source} alt={chip.alt} width={chip.width} height={ROW_H} />,
        <Box key="cache-fold-slot" flexShrink={0} marginLeft={-1} marginRight={isJoined ? -1 : 0}>
          {fold}
        </Box>,
      ],
      size: chip.width + CACHE_FOLD_PX - (isJoined ? COLUMN_PX : 0),
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
  // Three lines: the facts; keep warm with the costs; the caption with the models, the footer after them when it fits.
  const modelsText = lines.models.map(m => `${m.name} ${m.cost}${m.isMine ? ' YOU' : ''}`).join(' · ')
  const isFootUp = columns > 0 && `${lines.label} ${modelsText} · ${lines.footer}`.length <= columns
  const card = open ? (
    <Box key="cache-card" flexDirection="column">
      <Text wrap="truncate-end">{lines.facts}</Text>
      <Text wrap="truncate-end">
        <Text>{lines.keep}</Text>
        {lines.renewal ? <Text dimColor>{' · '}</Text> : null}
        {lines.renewal ? <Text>{lines.renewal}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        <Text>{lines.label}</Text>
        {' '}
        <Text>
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
        {isFootUp ? <Text dimColor>{' · '}</Text> : null}
        {isFootUp ? <Text dimColor>{lines.footer}</Text> : null}
      </Text>
      {isFootUp ? null : (
        <Text dimColor wrap="truncate-end">
          {lines.footer}
        </Text>
      )}
    </Box>
  ) : null
  // The chip, a space, the summary, then the gap, the one-glyph chevron and the row's gap after it.
  return { row: [chip, fold], size: word.length + 1 + text.length + 1 + 1 + 2, card }
}
