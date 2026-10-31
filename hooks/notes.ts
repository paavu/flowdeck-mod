// A task's handoff note: up to four short plain-text parts the panel shows under the task's row, so whoever reviews the
// list has each task's context. `goal` (the user's request, from the orchestrator when it creates the task), `brief` (taken
// by the mod from the worker's delegation prompt when the worker starts), `result` and `feedback` (from the orchestrator
// when it accepts the task). Every text is cleaned and capped here, whatever the caller sent.
import { textWidth } from './plan-view'
import { taskTag } from './tasks'

export type NoteKey = 'goal' | 'brief' | 'result' | 'feedback'
export type TaskNote = Partial<Record<NoteKey, string>>
export type NotePart = { key: NoteKey; label: string; text: string }

export const NOTE_KEYS: readonly NoteKey[] = ['goal', 'brief', 'result', 'feedback']
/** What the orchestrator may set through `progress` `notes`; the brief is the mod's own. */
export const SENT_KEYS: readonly NoteKey[] = ['goal', 'result', 'feedback']
export const NOTE_MAX: Record<NoteKey, number> = { goal: 300, brief: 600, result: 300, feedback: 300 }
export const NOTE_LABEL: Record<NoteKey, string> = { goal: 'Goal', brief: 'Brief', result: 'Result', feedback: 'Feedback' }
/** The row's note button: one single-width glyph with no emoji form (circled i). */
export const NOTE_ICON = 'ⓘ'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// Control characters and line or paragraph separators read as spaces; lone surrogates are dropped.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu
const isLone = (ch: string) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff

/** One line of plain text, at most `max` characters: whitespace collapsed, and when longer cut at a word with `…`. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const chars = [...v.replace(CONTROL, ' ')].filter(ch => !isLone(ch))
  const s = chars.join('').replace(/\s+/g, ' ').trim()
  const all = [...s]
  if (all.length <= max) return s
  const cut = all.slice(0, Math.max(1, max - 1)).join('')
  const at = cut.lastIndexOf(' ')
  return `${(at > cut.length / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:–—-]+$/, '')}…`
}

/** The note parts a value holds, cleaned and capped; anything else (an older task, an odd shape) is no note. */
export function noteOf(v: unknown): TaskNote {
  if (!isObj(v)) return {}
  const out: TaskNote = {}
  for (const k of NOTE_KEYS) {
    const t = cleanText(v[k], NOTE_MAX[k])
    if (t) out[k] = t
  }
  return out
}

export const hasNote = (n: TaskNote): boolean => NOTE_KEYS.some(k => !!n[k])

/** The parts to draw, in their fixed order. */
export const noteParts = (n: TaskNote): NotePart[] => NOTE_KEYS.flatMap(key => (n[key] ? [{ key, label: NOTE_LABEL[key], text: n[key]! }] : []))

/** `t` with one part set, or taken out when the text is empty. */
export function withPart<T extends object>(t: T, key: NoteKey, text: string): T {
  const out = { ...t } as T & TaskNote
  if (text) out[key] = text
  else delete out[key]
  return out
}

/**
 * The `progress` tool's `notes`: `[{ task, goal?, result?, feedback? }]` by task number (from 1). A part sent replaces the
 * one before, an empty one clears it, one left out stays. A number past the list comes back in `unknown`.
 */
export function applyNotes<T extends object>(tasks: T[], notes: unknown): { tasks: T[]; unknown: number[] } {
  const unknown: number[] = []
  if (!Array.isArray(notes)) return { tasks, unknown }
  let out = tasks
  for (const item of notes) {
    if (!isObj(item) || !Number.isInteger(item.task)) continue
    const n = item.task as number
    if (n < 1 || n > out.length) {
      if (!unknown.includes(n)) unknown.push(n)
      continue
    }
    let t = out[n - 1]!
    for (const k of SENT_KEYS) if (typeof item[k] === 'string') t = withPart(t, k, cleanText(item[k], NOTE_MAX[k]))
    if (t !== out[n - 1]) out = out.map((x, i) => (i === n - 1 ? t : x))
  }
  return { tasks: out, unknown }
}

// Sentences every brief carries that say nothing about the task itself: the step-list closing line, and the standard
// preamble (repo line, tool, delete, commit, comment and time-format rules). Only whole sentences that start so are dropped.
const BOILERPLATE: readonly RegExp[] = [
  /close your step list\b/i,
  /^update your step list\b/i,
  /^repo(sitory)?\s*:/i,
  /^(working directory|cwd)\s*:/i,
  /^read\s+(readme|claude\.md|changelog)\b/i,
  /^use lean-ctx\b/i,
  /^never delete files\b/i,
  /^(do not|don't) delete files\b/i,
  /^no rm\b/i,
  /^(no|never|do not|don't)\s+(git\s+)?(commit|push|tag)\b/i,
  /^comments sparingly\b/i,
  /^use comments sparingly\b/i,
  /^24-hour time\b/i,
]
const isBoilerplate = (sentence: string): boolean => BOILERPLATE.some(re => re.test(sentence.trim()))

/**
 * A worker's brief from its delegation prompt (the Agent tool's `prompt`): headings, rules, code fences and the standard
 * boilerplate dropped, list marks and emphasis taken off, one paragraph from the start of the real task text, cut at
 * about 600 characters with `…`. '' when nothing is left.
 */
export function briefOf(prompt: unknown): string {
  if (typeof prompt !== 'string') return ''
  const kept: string[] = []
  for (const raw of prompt.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || /^#{1,6}\s/.test(line) || /^```/.test(line) || /^([-*_])\1{2,}$/.test(line)) continue
    const text = line.replace(/^([-*+]|•)\s+/, '').replace(/\*\*|__/g, '')
    // A line's sentences: split after . ! or ? where the next one starts with a capital, a digit, a quote or a backtick.
    const sentences = text.split(/(?<=[.!?])\s+(?=[\p{Lu}\d`"'(])/u).filter(s => !isBoilerplate(s))
    if (sentences.length) kept.push(sentences.join(' '))
  }
  return cleanText(kept.join(' '), NOTE_MAX.brief)
}

/** Without a prompt: the Agent description without its `#n`, unless that only repeats the task's title. */
export function fallbackBrief(description: unknown, title = ''): string {
  const rest = cleanText(taskTag(typeof description === 'string' ? description : '').rest, NOTE_MAX.brief)
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return rest && plain(rest) !== plain(title) ? rest : ''
}

/**
 * `text` as lines at most `maxW` wide by `width`: broken at spaces; a word wider than a line is broken inside it, so no
 * line is ever wider than `maxW` (bar a single character wider than it).
 */
export function wrapNote(text: string, maxW: number, width: (s: string) => number): string[] {
  const lines: string[] = []
  let cur = ''
  const pieces = (word: string): string[] => {
    if (width(word) <= maxW) return [word]
    const out: string[] = []
    let part = ''
    for (const ch of word) {
      if (part && width(part + ch) > maxW) {
        out.push(part)
        part = ''
      }
      part += ch
    }
    if (part) out.push(part)
    return out
  }
  for (const word of text.split(' ').filter(Boolean)) {
    for (const piece of pieces(word)) {
      const next = cur ? `${cur} ${piece}` : piece
      if (!cur || width(next) <= maxW) cur = next
      else {
        lines.push(cur)
        cur = piece
      }
    }
  }
  if (cur) lines.push(cur)
  return lines
}

// A terminal cell count: wide East Asian characters and most emoji take two columns.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u
export const cells = (s: string): number => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
/** The note's text column on the desktop, the step rows' title column; it ends where the row's stats end. */
export const NOTE_X = 58
const NOTE_RIGHT = 22
const LABEL_SIZE = 10.5
const TEXT_SIZE = 11
const LINE_H = 15
const PART_GAP = 4

/** The opened note on the desktop, W wide: each part's dim label on its own line, then its text wrapped to the width. */
export function noteSvgBody(W: number, parts: NotePart[]): { body: string; height: number; lines: string[] } {
  const maxW = Math.max(40, W - NOTE_RIGHT - NOTE_X)
  let y = 2
  const out: string[] = []
  const lines: string[] = []
  parts.forEach((p, i) => {
    if (i) y += PART_GAP
    y += LINE_H
    out.push(`<text class="m" x="${NOTE_X}" y="${y - 4}" font-family="${FONT}" font-size="${LABEL_SIZE}" font-weight="600">${esc(p.label)}</text>`)
    for (const l of wrapNote(p.text, maxW, s => textWidth(s, TEXT_SIZE))) {
      y += LINE_H
      lines.push(l)
      out.push(`<text class="t" x="${NOTE_X}" y="${y - 4}" font-family="${FONT}" font-size="${TEXT_SIZE}">${esc(l)}</text>`)
    }
  })
  return { body: out.join('\n'), height: y + 6, lines }
}

/** The opened note in the terminal: a dim label line per part, then its text wrapped to `cols`, indented as step rows are. */
export function noteRows(parts: NotePart[], cols: number): { text: string; isLabel: boolean }[] {
  const room = Math.max(8, cols - 4)
  return parts.flatMap(p => [{ text: `   ${p.label}`, isLabel: true }, ...wrapNote(p.text, room, cells).map(l => ({ text: `   ${l}`, isLabel: false }))])
}

/** The alt text of an opened note: its parts, labelled. */
export const noteAlt = (parts: NotePart[]): string => parts.map(p => `${p.label}: ${p.text}`).join(' · ')
