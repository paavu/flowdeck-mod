// Lays out the trees scripts/screenshots/shots.tsx printed as HTML, draws the numbered callouts of scripts/screenshots/callouts.tsv
// on them and screenshots them with agent-browser (headless Chromium), light and dark.
// The mod's Svg drawings are used as they are; the desktop app's own elements (Box, Text, Button) are approximated here
// with plain CSS (system font, 8 px per cell), so the native parts are close to the desktop app, not identical.
// Usage: node render.mjs <test output> <docs/images folder> <scratch folder>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outFile, imagesDir, scratch] = process.argv.slice(2)
if (!outFile || !imagesDir || !scratch) throw new Error('usage: node render.mjs <test output> <images folder> <scratch folder>')

// name: { from: the drawing's name (default: the name), width: the page width in CSS px (the band at 110 columns, the panel at 62),
// pick: a part of the drawing, parts: several drawings stacked, each { from, pick, label } }.
// A pick is { svg: n } (the n-th Svg), { children: [i, ...] } (those children of the root) or
// { key, keep?, drop? } (the node with that key, with only the children keyed in `keep`, or all but those in `drop`).
// The band's page is its row at 110 columns as the mod sizes it (9 px a column less 14), and its plain Buttons keep the
// 11 px at each side the desktop app draws (buttonPad; measured in the app) and its cells are 9 px (cell), so the row fills
// as it does there.
const BAND = { width: 110 * 9 - 14, buttonPad: 11, cell: 9 }
const SHOTS = {
  'band-overview': { from: 'band-running', ...BAND },
  'band-running': { ...BAND },
  'band-done': { ...BAND },
  'cache-warm': { width: 760, pick: { svg: 3 } },
  'cache-cold': { width: 760, pick: { svg: 3 } },
  'cache-keep-warm': {
    width: 760,
    parts: [
      { from: 'cache-kept-due', pick: { svg: 3 }, label: 'Keep warm on, renewal due' },
      { from: 'cache-kept-once', pick: { svg: 3 }, label: 'After one renewal' },
      { from: 'cache-kept-off', pick: { svg: 3 }, label: 'Keep warm off' },
    ],
  },
  'panel-overview': { from: 'panel-active', width: 520 },
  'panel-toggles': {
    width: 520,
    parts: [
      { from: 'panel-toggles-on', pick: { children: [0] }, label: 'All on' },
      { from: 'panel-toggles-off', pick: { children: [0] }, label: 'All off' },
    ],
  },
  'panel-context': { from: 'panel-active', width: 520, pick: { children: [1] } },
  'panel-usage': { from: 'panel-active', width: 520, pick: { children: [2] } },
  'panel-tabs': { from: 'panel-active', width: 520, pick: { key: 'flowdeck-group', drop: ['w2', 'plan-3', 'plan-4'] } },
  'panel-flow': { from: 'panel-active', width: 520, pick: { key: 'flowdeck-group', keep: ['w2', 'plan-3', 'plan-4'] } },
  'panel-finished-list': { width: 520, pick: { key: 'flowdeck-group' } },
  'panel-finished': { width: 520, pick: { key: 'flowdeck-group' } },
  'note-view': { from: 'panel-finished', width: 520, pick: { key: 'w1' } },
  'panel-archive': { width: 520, pick: { key: 'flowdeck-group' } },
  'panel-trash': { width: 520, pick: { key: 'flowdeck-group' } },
  'panel-trash-confirm': { width: 520, pick: { key: 'flowdeck-group' } },
  'panel-tracking-off': { width: 520, pick: { key: 'flowdeck-group' } },
}
// The mod's own drawings kept as files under docs/images/src/: the band's and the cache card's Svg sources.
const SVG_SOURCES = ['band-running', 'band-done', 'cache-warm', 'cache-cold']
const THEME = {
  light: { bg: '#faf9f5', ink: '#1f1f1f', line: '#e6e4dd', button: '#f0eee6' },
  dark: { bg: '#262624', ink: '#ececec', line: '#3a3a37', button: '#30302e' },
}
const CELL = 8
const MARK = '#d6249f'
const PAD = 16
const PAD_MARKED = 28

const trees = {}
for (const line of readFileSync(outFile, 'utf8').split('\n')) {
  const m = /^@@SHOT (\S+) (.*)$/.exec(line)
  if (m) trees[m[1]] = JSON.parse(m[2])
}
const partsOf = (name, spec) => (spec.parts ?? [{ from: spec.from ?? name, pick: spec.pick }])
const missing = Object.entries(SHOTS).flatMap(([name, spec]) => partsOf(name, spec).map(p => p.from ?? name)).filter(n => !trees[n])
if (missing.length) throw new Error(`no drawing printed for: ${[...new Set(missing)].join(', ')}`)

// callouts.tsv columns: shot, n, key, text, img, x, y, at, dx, dy ('-' leaves one out; lines starting with # are notes).
// key: the node whose drawing the callout is looked for in (the whole image when left out); text: the first text inside it that
// contains this; img + x + y: a point in the img-th picture of that node (for what the mod draws as one Svg); at: top, bottom,
// left, right or c, the side of the part the number sits on; dx, dy: nudges in px.
const CALLOUTS = {}
for (const line of readFileSync(new URL('./callouts.tsv', import.meta.url), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue
  const [shot, n, key, text, img, x, y, at, dx, dy] = line.split('\t').map(c => (c === '-' ? '' : c))
  ;(CALLOUTS[shot] ??= []).push({ n: Number(n), key, text, img: img === '' || img === undefined ? null : Number(img), x: Number(x || 0), y: Number(y || 0), at: at || 'top', dx: Number(dx || 0), dy: Number(dy || 0) })
}
const unknown = Object.keys(CALLOUTS).filter(n => !SHOTS[n])
if (unknown.length) throw new Error(`callouts for unknown shots: ${unknown.join(', ')}`)

const childrenOf = n => n.children ?? n.props?.children
const keyOfNode = n => n.key ?? n.props?.key
const findKey = (n, key) => {
  if (!n || typeof n !== 'object') return null
  if (Array.isArray(n)) return n.map(c => findKey(c, key)).find(Boolean) ?? null
  return keyOfNode(n) === key ? n : findKey(childrenOf(n), key)
}
function pick(tree, spec) {
  if (!spec) return tree
  if (spec.svg !== undefined) {
    const svgs = []
    const walk = n => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.type === 'Svg') svgs.push(n)
      walk(childrenOf(n))
    }
    walk(tree)
    if (!svgs[spec.svg]) throw new Error(`no Svg number ${spec.svg}`)
    return svgs[spec.svg]
  }
  const slim = (node, kids) => ({ type: node.type, key: keyOfNode(node), props: { ...node.props, children: undefined }, children: kids })
  const kids = node => [].concat(childrenOf(node) ?? [])
  if (spec.children) return slim(tree, kids(tree).filter((_, i) => spec.children.includes(i)))
  const node = findKey(tree, spec.key)
  if (!node) throw new Error(`no node with key ${spec.key}`)
  return slim(
    node,
    kids(node).filter(c => {
      const k = c && typeof c === 'object' ? keyOfNode(c) : undefined
      return spec.keep ? spec.keep.includes(k) : !(spec.drop ?? []).includes(k)
    }),
  )
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The SVG source for one theme: its `prefers-color-scheme: dark` rules dropped (light) or applied unconditionally (dark).
function themed(source, theme) {
  if (theme === 'auto') return source
  const marker = '@media (prefers-color-scheme: dark)'
  let out = ''
  let i = 0
  for (;;) {
    const at = source.indexOf(marker, i)
    if (at < 0) return out + source.slice(i)
    out += source.slice(i, at)
    const open = source.indexOf('{', at)
    let depth = 1
    let j = open + 1
    for (; j < source.length && depth > 0; j++) depth += source[j] === '{' ? 1 : source[j] === '}' ? -1 : 0
    if (theme === 'dark') out += source.slice(open + 1, j - 1)
    i = j
  }
}

// A Space: cells, or a named step (the desktop's own sizes are not known here; these are close).
const STEP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
let cell = CELL // the page's own, set by page()
const px = n => (typeof n === 'string' ? `${STEP[n] ?? 0}px` : `${n * cell}px`)
function boxStyle(p) {
  const s = ['display:flex', `flex-direction:${p.flexDirection === 'column' ? 'column' : 'row'}`]
  if (p.backgroundColor) s.push(`background:${p.backgroundColor}`)
  if (p.paddingX) s.push(`padding-left:${px(p.paddingX)};padding-right:${px(p.paddingX)}`)
  if (p.paddingY) s.push(`padding-top:${px(p.paddingY)};padding-bottom:${px(p.paddingY)}`)
  if (p.gap) s.push(`gap:${px(p.gap)}`)
  if (p.columnGap) s.push(`column-gap:${px(p.columnGap)}`)
  if (p.marginTop) s.push(`margin-top:${px(p.marginTop)}`)
  if (p.marginLeft) s.push(`margin-left:${px(p.marginLeft)}`)
  if (p.marginRight) s.push(`margin-right:${px(p.marginRight)}`)
  if (p.paddingLeft) s.push(`padding-left:${px(p.paddingLeft)}`)
  if (p.flexGrow !== undefined) s.push(`flex-grow:${p.flexGrow}`)
  if (p.flexShrink !== undefined) s.push(`flex-shrink:${p.flexShrink}`)
  if (p.minWidth !== undefined) s.push(`min-width:${px(p.minWidth)}`)
  if (p.width !== undefined) s.push(`width:${px(p.width)}`)
  if (p.overflow === 'hidden') s.push('overflow:hidden')
  if (p.flexWrap) s.push(`flex-wrap:${p.flexWrap}`)
  if (p.alignItems) s.push(`align-items:${{ center: 'center', 'flex-start': 'flex-start', 'flex-end': 'flex-end' }[p.alignItems] ?? 'stretch'}`)
  if (p.justifyContent) s.push(`justify-content:${p.justifyContent}`)
  return s.join(';')
}
function textStyle(p) {
  const s = []
  if (p.color) s.push(`color:${p.color}`)
  if (p.bold || p.weight === 'bold') s.push('font-weight:700')
  else if (p.weight === 'semibold') s.push('font-weight:600')
  if (p.dimColor) s.push('opacity:.55')
  if (p.underline) s.push('text-decoration:underline')
  if (p.wrap === 'truncate-end') s.push('white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0')
  else s.push('white-space:pre-wrap')
  return s.join(';')
}

function html(n, theme) {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return esc(n)
  if (Array.isArray(n)) return n.map(c => html(c, theme)).join('')
  const p = n.props ?? {}
  const kids = html(childrenOf(n), theme)
  const k = keyOfNode(n)
  const data = k ? ` data-key="${esc(k)}"` : ''
  switch (n.type) {
    case 'Box':
      return `<div${data} style="${boxStyle(p)}">${kids}</div>`
    case 'Text':
      return `<span${data} class="text" style="${textStyle(p)}">${kids}</span>`
    case 'Button': {
      const cls = p.plain ? 'btn plain' : 'btn'
      return `<span${data} class="${cls}" style="${p.dimColor ? 'opacity:.55' : ''}">${kids || esc(p.label ?? '')}</span>`
    }
    case 'Svg': {
      const src = `data:image/svg+xml;base64,${Buffer.from(themed(p.source, theme)).toString('base64')}`
      return `<img${data} src="${src}" width="${p.width}" height="${p.height}" alt="${esc(p.alt ?? '')}" style="display:block;flex-shrink:0">`
    }
    default:
      return kids
  }
}

// Draws the numbered circles: runs in the page after layout, from the data in callouts.tsv.
const PLACE = `(${function place(list) {
  const frame = document.querySelector('.frame')
  const box = frame.getBoundingClientRect()
  const R = 9
  const GAP = 3
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  overlay.setAttribute('class', 'leaders')
  overlay.setAttribute('width', String(box.width))
  overlay.setAttribute('height', String(box.height))
  frame.appendChild(overlay)
  const rectOf = c => {
    const scope = c.key ? frame.querySelector(c.key.endsWith('*') ? `[data-key^="${c.key.slice(0, -1)}"]` : `[data-key="${c.key}"]`) : frame
    if (!scope) throw new Error(`callout ${c.n}: no part with key ${c.key}`)
    if (c.img !== null) {
      const im = scope.tagName === 'IMG' ? scope : scope.querySelectorAll('img')[c.img]
      if (!im) throw new Error(`callout ${c.n}: no picture ${c.img}`)
      const r = im.getBoundingClientRect()
      return { left: r.left + c.x, right: r.left + c.x, top: r.top + c.y, bottom: r.top + c.y }
    }
    if (c.text) {
      const drawn = [...scope.querySelectorAll('img')].find(i => i.alt.includes(c.text))
      if (drawn) return drawn.getBoundingClientRect()
      const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      const isPattern = c.text.length > 2 && c.text.startsWith('/') && c.text.endsWith('/')
      const pattern = isPattern ? new RegExp(c.text.slice(1, -1)) : null
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const found = pattern ? pattern.exec(t.nodeValue) : null
        const at = pattern ? (found ? found.index : -1) : t.nodeValue.indexOf(c.text)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(t, at)
        range.setEnd(t, at + (found ? found[0].length : c.text.length))
        return range.getBoundingClientRect()
      }
      throw new Error(`callout ${c.n}: no text "${c.text}"`)
    }
    return scope.getBoundingClientRect()
  }
  for (const c of list) {
    const r = rectOf(c)
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    const [tx, ty] = { top: [cx, r.top], bottom: [cx, r.bottom], left: [r.left, cy], right: [r.right, cy], c: [cx, cy] }[c.at]
    const [ox, oy] = { top: [0, -GAP - R], bottom: [0, GAP + R], left: [-GAP - R, 0], right: [GAP + R, 0], c: [0, 0] }[c.at]
    const x = tx + ox + c.dx - box.left
    const y = ty + oy + c.dy - box.top
    if (Math.hypot(ox + c.dx, oy + c.dy) > GAP + R + 4) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(tx - box.left))
      line.setAttribute('y1', String(ty - box.top))
      line.setAttribute('x2', String(x))
      line.setAttribute('y2', String(y))
      overlay.appendChild(line)
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      dot.setAttribute('cx', String(tx - box.left))
      dot.setAttribute('cy', String(ty - box.top))
      dot.setAttribute('r', '2.5')
      overlay.appendChild(dot)
    }
    const d = document.createElement('div')
    d.className = 'mark'
    d.textContent = String(c.n)
    d.style.left = `${x - R}px`
    d.style.top = `${y - R}px`
    frame.appendChild(d)
  }
}})`

function body(name, spec, theme) {
  const parts = partsOf(name, spec).map(p => ({ ...p, tree: pick(trees[p.from ?? name], p.pick) }))
  if (!spec.parts) return html(parts[0].tree, theme)
  return parts
    .map(p => `<div class="part">${p.label ? `<div class="cap">${esc(p.label)}</div>` : ''}${html(p.tree, theme)}</div>`)
    .join('')
}

function page(name, spec, theme) {
  const vars = t => `--bg:${t.bg};--ink:${t.ink};--line:${t.line};--button:${t.button}`
  const rootVars =
    theme === 'auto'
      ? `:root{${vars(THEME.light)}}@media (prefers-color-scheme: dark){:root{${vars(THEME.dark)}}}`
      : `:root{${vars(THEME[theme])}}`
  const marks = CALLOUTS[name] ?? []
  const pad = marks.length ? PAD_MARKED : PAD
  cell = spec.cell ?? CELL
  return `<!doctype html><html><head><meta charset="utf-8"><title>flowdeck sample</title><style>
${rootVars}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.frame{position:relative;width:${spec.width}px;padding:${pad}px;box-sizing:content-box}
.text{display:inline-block}
.btn{display:inline-block;white-space:nowrap;padding:1px 8px;border:1px solid var(--line);border-radius:6px;background:var(--button);flex-shrink:0}
.btn.plain{padding:0 ${spec.buttonPad ?? 2}px;border-color:transparent;background:none}
.part+.part{margin-top:${marks.length ? 34 : 14}px}
.leaders{position:absolute;left:0;top:0;pointer-events:none;z-index:1}
.leaders line{stroke:${MARK};stroke-width:1.5}
.leaders circle{fill:${MARK}}
.cap{font-size:11px;opacity:.55;margin-bottom:4px}
.mark{position:absolute;width:18px;height:18px;border-radius:50%;background:${MARK};color:#fff;font:700 11px/18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px var(--bg);z-index:2}
</style></head><body><div class="frame">${body(name, spec, theme)}</div>${marks.length ? `<script>window.addEventListener('load',()=>${PLACE}(${JSON.stringify(marks)}))</script>` : ''}</body></html>`
}

// agent-browser (headless Chrome for Testing) in a session of its own; each page is captured by its frame element.
const SESSION = 'flowdeck-shots'
const browser = (...args) => execFileSync('agent-browser', ['--session', SESSION, ...args], { stdio: ['ignore', 'ignore', 'inherit'] })
// A smaller palette keeps each PNG light (flat colours and text); ImageMagick when it is installed.
const shrink = file => {
  try {
    execFileSync('magick', [file, '-quantize', 'sRGB', '+dither', '-colors', '96', `PNG8:${file}`], { stdio: 'ignore' })
  } catch {}
}

mkdirSync(join(imagesDir, 'src'), { recursive: true })
mkdirSync(scratch, { recursive: true })
try {
  browser('open', 'about:blank')
  browser('set', 'media', 'light', 'reduced-motion')
  for (const [name, spec] of Object.entries(SHOTS)) {
    writeFileSync(join(imagesDir, 'src', `${name}.html`), page(name, spec, 'auto'))
    const pad = (CALLOUTS[name] ?? []).length ? PAD_MARKED : PAD
    browser('set', 'viewport', String(spec.width + 2 * pad), '1800', '2')
    for (const theme of ['light', 'dark']) {
      const file = join(scratch, `${name}-${theme}.html`)
      writeFileSync(file, page(name, spec, theme))
      browser('open', `file://${file}`)
      const png = join(imagesDir, `${name}-${theme}.png`)
      browser('screenshot', '.frame', png)
      shrink(png)
    }
  }
} finally {
  browser('close')
}
// The mod's own SVG drawings of the band and the cache card, as it hands them to the desktop app.
for (const name of SVG_SOURCES) {
  const svgs = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'Svg') svgs.push(n.props.source)
    walk(childrenOf(n))
  }
  walk(trees[name])
  svgs.forEach((s, i) => writeFileSync(join(imagesDir, 'src', `${name}-${i + 1}.svg`), s))
}
console.log(`wrote ${Object.keys(SHOTS).length * 2} PNG files to ${imagesDir}`)
