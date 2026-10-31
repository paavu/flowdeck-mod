// Lays out the trees scripts/screenshots/shots.tsx printed as HTML and screenshots them with agent-browser (headless Chromium).
// The mod's Svg drawings are used as they are; the desktop app's own elements (Box, Text, Button) are approximated here
// with plain CSS (system font, 8 px per cell), so the native parts are close to the desktop app, not identical.
// Usage: node render.mjs <test output> <docs/images folder> <scratch folder>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outFile, imagesDir, scratch] = process.argv.slice(2)
if (!outFile || !imagesDir || !scratch) throw new Error('usage: node render.mjs <test output> <images folder> <scratch folder>')

// name: the page width in CSS px (the band at 110 columns, the panel at 62)
const SHOTS = {
  'band-running': 900,
  'band-done': 900,
  'cache-warm': 900,
  'cache-cold': 900,
  'panel-active': 520,
  'panel-finished': 520,
  'panel-archive': 520,
  'panel-trash': 520,
}
const SVG_SOURCES = ['band-running', 'band-done', 'cache-warm', 'cache-cold']
const THEME = {
  light: { bg: '#faf9f5', ink: '#1f1f1f', line: '#e6e4dd', button: '#f0eee6' },
  dark: { bg: '#262624', ink: '#ececec', line: '#3a3a37', button: '#30302e' },
}
const CELL = 8

const trees = {}
for (const line of readFileSync(outFile, 'utf8').split('\n')) {
  const m = /^@@SHOT (\S+) (.*)$/.exec(line)
  if (m) trees[m[1]] = JSON.parse(m[2])
}
const missing = Object.keys(SHOTS).filter(n => !trees[n])
if (missing.length) throw new Error(`no drawing printed for: ${missing.join(', ')}`)

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

const px = n => `${n * CELL}px`
function boxStyle(p) {
  const s = ['display:flex', `flex-direction:${p.flexDirection === 'column' ? 'column' : 'row'}`]
  if (p.gap) s.push(`gap:${px(p.gap)}`)
  if (p.columnGap) s.push(`column-gap:${px(p.columnGap)}`)
  if (p.marginTop) s.push(`margin-top:${px(p.marginTop)}`)
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
  const kids = html(n.children ?? p.children, theme)
  switch (n.type) {
    case 'Box':
      return `<div style="${boxStyle(p)}">${kids}</div>`
    case 'Text':
      return `<span class="text" style="${textStyle(p)}">${kids}</span>`
    case 'Button': {
      const cls = p.plain ? 'btn plain' : 'btn'
      return `<span class="${cls}" style="${p.dimColor ? 'opacity:.55' : ''}">${kids || esc(p.label ?? '')}</span>`
    }
    case 'Svg': {
      const src = `data:image/svg+xml;base64,${Buffer.from(themed(p.source, theme)).toString('base64')}`
      return `<img src="${src}" width="${p.width}" height="${p.height}" alt="${esc(p.alt ?? '')}" style="display:block;flex-shrink:0">`
    }
    default:
      return kids
  }
}

function page(tree, width, theme) {
  const vars = (t) => `--bg:${t.bg};--ink:${t.ink};--line:${t.line};--button:${t.button}`
  const rootVars = theme === 'auto'
    ? `:root{${vars(THEME.light)}}@media (prefers-color-scheme: dark){:root{${vars(THEME.dark)}}}`
    : `:root{${vars(THEME[theme])}}`
  return `<!doctype html><html><head><meta charset="utf-8"><title>flowdeck sample</title><style>
${rootVars}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.frame{width:${width}px;padding:16px;box-sizing:content-box}
.text{display:inline-block}
.btn{display:inline-block;white-space:nowrap;padding:1px 8px;border:1px solid var(--line);border-radius:6px;background:var(--button);flex-shrink:0}
.btn.plain{padding:0 2px;border-color:transparent;background:none}
</style></head><body><div class="frame">${html(tree, theme)}</div></body></html>`
}

// agent-browser (headless Chrome for Testing) in a session of its own; each page is captured by its frame element.
const SESSION = 'flowdeck-shots'
const browser = (...args) => execFileSync('agent-browser', ['--session', SESSION, ...args], { stdio: ['ignore', 'ignore', 'inherit'] })

mkdirSync(join(imagesDir, 'src'), { recursive: true })
mkdirSync(scratch, { recursive: true })
try {
  browser('open', 'about:blank')
  browser('set', 'media', 'light', 'reduced-motion')
  for (const [name, width] of Object.entries(SHOTS)) {
    const tree = trees[name]
    writeFileSync(join(imagesDir, 'src', `${name}.html`), page(tree, width, 'auto'))
    browser('set', 'viewport', String(width + 32), '1600', '2')
    for (const theme of ['light', 'dark']) {
      const file = join(scratch, `${name}-${theme}.html`)
      writeFileSync(file, page(tree, width, theme))
      browser('open', `file://${file}`)
      browser('screenshot', '.frame', join(imagesDir, `${name}-${theme}.png`))
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
    walk(n.children ?? n.props?.children)
  }
  walk(trees[name])
  svgs.forEach((s, i) => writeFileSync(join(imagesDir, 'src', `${name}-${i + 1}.svg`), s))
}
console.log(`wrote ${Object.keys(SHOTS).length * 2} PNG files to ${imagesDir}`)
