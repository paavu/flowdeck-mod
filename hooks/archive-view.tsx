// The Archive and Trash tabs: one collapsed row per saved session, drawn from its index record alone (no session file is
// read to draw the list), the session's file shown when its row is opened, and the move-to-trash and restore
// confirmations. It draws only: the data, the panel's flow drawing and every press come from register.tsx.
import type { Elements, RenderChildren } from 'claude-code'

import type { AgentRun, ArchiveAgent, ArchiveDetail, ArchiveEntry, ArchiveRecord, Panel, PlannedTask, TaskPlan } from '../types'
import { formatEntry, groupLine, keyOf } from './archive'
import { foldGlyph } from './fold'
import { acceptedOf } from './tasks'

/** A planned task, numbered in plan order; `ready` once everything it waits for is done; `doneAt` when it was accepted. */
export type Planned = PlannedTask & { n: number; ready?: boolean; doneAt?: number }
export type Totals = { cost: number; tokens: number; time: number }

// One flow as the panel draws it, live or from the archive: the header (the three tiles; never the flow's title) and, on
// demand, the body, one flat list of `rows`: `active` (the running rows newest first, then the planned
// tasks in plan order), `finished` (the finished rows not archived and the accepted ones, latest completion first) or
// `all`, the archive's (every row and the accepted ones, latest completion first). `at` is the clock the rows count to.
export type FlowView = {
  kp: string
  fp: string
  list: AgentRun[]
  /** The flow's tasks in plan order: a run that belongs to one shows its number and what it waits for. */
  tasks?: { title: string; tier?: string; after?: number[] }[]
  /** The accepted task numbers (from 1): a run of one never hides an Incomplete state; one without a run is an Accepted row. */
  accepted?: number[]
  /** When each accepted task was accepted, by number. */
  acceptedAt?: Record<string, number>
  /** When an accepted task with no time of its own counts as done (an archive entry's end); none in the live flow. */
  acceptedFallback?: number
  planned: Planned[]
  at: number
  t: Totals
  /** The live flow only: which finished rows get an Archive button, and its press. */
  archive?: { can: (a: AgentRun) => boolean; press: (a: AgentRun) => unknown }
  rows: 'active' | 'finished' | 'all'
}
export type FlowDrawing = { header: RenderChildren; body: () => RenderChildren }

export type ArchiveWords = {
  tokensWord: string
  untitled: string
  noArchive: string
  trashEmpty: string
  loading: string
  couldNotRead: string
  fileMissing: string
  showMore: string
  trashAsk: string
  trashTell: string
  moveToTrash: string
  restoreAsk: string
  restoreTell: string
  restore: string
  cancel: string
  /** `{n}`: how many sessions the Trash tab shows. */
  emptyTrash: string
  emptyAsk: string
  emptyAskOne: string
  erase: string
}

export type ArchiveView = {
  ui: Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>
  /** The desktop's drawing element; null in the terminal. */
  Svg: Elements['desktop']['Svg'] | null
  W: number
  /** The panel's width in columns: the date line fits it. */
  cols: number
  svg: (W: number, H: number, body: string) => string
  fmt: { cost: (usd: number) => string; tokens: (n: number) => string; time: (ms: number) => string }
  words: ArchiveWords
  p: Panel
  /** Which tab: the Archive or the Trash. */
  list: 'archive' | 'trash'
  /** The tab's sessions, newest first by their end, from the index. */
  records: ArchiveRecord[]
  /** The session files read for open groups. */
  details: ArchiveDetail[]
  warnings: string[]
  /** A project folder holds the archive: sessions can move to the trash and back. */
  canMove: boolean
  flowView: (v: FlowView) => FlowDrawing
  /** One archived plan's drawing; `kp` prefixes its keys, `at` is its clock. */
  plan: (pl: TaskPlan, kp: string, at: number) => RenderChildren
  on: {
    entry: (rec: ArchiveRecord, isOpen: boolean) => unknown
    /** The row's ✕ (Archive) or Restore (Trash): opens its confirmation. */
    ask: (rec: ArchiveRecord) => unknown
    confirm: (rec: ArchiveRecord) => unknown
    cancel: () => unknown
    more: () => unknown
    /** Empty Trash: opens its confirmation. */
    askEmpty: () => unknown
    /** Erase, in Empty Trash's confirmation. */
    empty: () => unknown
  }
}

// The fold state's key of a group: the session id in the Archive, `trash:<id>` in the Trash.
export const groupKey = (list: 'archive' | 'trash', id: string): string => (list === 'archive' ? id : `trash:${id}`)

// The first group of a list is open unless the user folded it; the others are folded unless the user opened them.
export const isGroupOpen = (p: Panel, list: 'archive' | 'trash', id: string, i: number): boolean => {
  const k = groupKey(list, id)
  return !(p.closedEntries ?? []).includes(k) && (i === 0 || p.openEntries.includes(k))
}

// A saved run as it ended, with an end: one saved while still going keeps its status and reads as Running at finish, its
// clock stopped at the save (the end is what tells it from a live run).
const endedRun = (a: ArchiveAgent, end: number): AgentRun => ({ ...a, endedAt: a.endedAt ?? end })

// The dim line under a session's title line: cost, tokens and time; a plan has only its time.
export function summaryLine(v: Pick<ArchiveView, 'fmt' | 'words'>, rec: ArchiveRecord): string {
  const time = v.fmt.time(rec.time)
  const line = rec.kind === 'plan' ? time : `≈${v.fmt.cost(rec.cost)} · ${v.fmt.tokens(rec.tokens)} ${v.words.tokensWord} · ${time}`
  return rec.missing ? `${line} · ${v.words.fileMissing}` : line
}

// An opened group's body: the session as it ended (its rows, latest completion first; an archived plan's
// drawing; the task list of a flow saved without runs), or why it is not there.
function groupBody(v: ArchiveView, rec: ArchiveRecord, key: string): RenderChildren {
  const { Box, Text } = v.ui
  const d = v.details.find(x => x.list === v.list && x.id === rec.id)
  const note = (text: string) => (
    <Text key={`${v.list}-${key}-note`} dimColor wrap="truncate-end">
      {`  ${text}`}
    </Text>
  )
  if (d?.state !== 'ok' || !d.entry) {
    if (rec.missing) return note(v.words.fileMissing)
    return note(!d || d.state === 'loading' ? v.words.loading : `${v.words.couldNotRead} ${rec.file || 'the shared store'}`)
  }
  const entry: ArchiveEntry = d.entry
  const kp = `${v.list}-${key}-`
  if (entry.plan) return v.plan(entry.plan, kp, entry.endedAt)
  const runs = (entry.agents ?? []).map(a => endedRun(a, entry.endedAt))
  if (!runs.length) {
    return formatEntry(entry).lines.map((l, k) => (
      <Text key={`${kp}${k}`} dimColor wrap="truncate-end">
        {l}
      </Text>
    ))
  }
  const view = v.flowView({
    kp,
    fp: `${groupKey(v.list, entry.id)}:`,
    list: runs,
    tasks: entry.tasks,
    accepted: acceptedOf(entry),
    acceptedAt: entry.acceptedAt,
    acceptedFallback: entry.endedAt,
    planned: [],
    at: entry.endedAt,
    t: { cost: entry.cost, tokens: entry.tokens, time: entry.time },
    rows: 'all',
  })
  return v.Svg ? view.body() : <Box flexDirection="column" marginTop={1}>{view.body()}</Box>
}

// The confirmation that takes a row's place: the session's date and item count, title, summary and file, what the move
// does, and the two buttons. Only one is open at a time (Panel.confirm).
function confirmBlock(v: ArchiveView, rec: ArchiveRecord, key: string): RenderChildren {
  const { Box, Text, Button } = v.ui
  const w = v.words
  const isTrash = v.list === 'trash'
  const file = isTrash ? `.claude/flowdeck/.trash/${rec.file}` : `.claude/flowdeck/archive/${rec.file}`
  return (
    <Box key={`${v.list}-confirm-${key}`} flexDirection="column">
      <Text bold wrap="truncate-end">
        {isTrash ? w.restoreAsk : w.trashAsk}
      </Text>
      <Text wrap="truncate-end">{groupLine(rec, v.cols - 2)}</Text>
      <Text wrap="truncate-end">{rec.title.trim() || w.untitled}</Text>
      <Text dimColor wrap="truncate-end">
        {summaryLine(v, rec)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {file}
      </Text>
      <Text dimColor>{isTrash ? w.restoreTell : w.trashTell}</Text>
      <Box flexDirection="row" gap={2}>
        <Button key={isTrash ? `trash-restore-yes-${key}` : `archive-trash-${key}`} label={isTrash ? w.restore : w.moveToTrash} plain onPress={() => v.on.confirm(rec)} />
        <Button key={`${v.list}-cancel-${key}`} label={w.cancel} plain onPress={v.on.cancel} />
      </Box>
    </Box>
  )
}

// One session as a row: the fold (chevron first, then its date and item count), the row's action at the far end (✕ in
// the Archive, Restore in the Trash), the dim summary line, and the session's rows when open.
function sessionRow(v: ArchiveView, rec: ArchiveRecord, i: number): RenderChildren {
  const { Box, Text, Button } = v.ui
  const { Svg, W, p } = v
  const key = keyOf(rec.id)
  const isOpen = isGroupOpen(p, v.list, rec.id, i)
  const isAsking = p.confirm?.list === v.list && !p.confirm.all && p.confirm.id === rec.id
  const action = !v.canMove ? null : v.list === 'archive' ? (
    <Button key={`archive-del-${key}`} label="✕" plain dimColor onPress={() => v.on.ask(rec)} />
  ) : (
    <Button key={`trash-restore-${key}`} label={v.words.restore} plain dimColor onPress={() => v.on.ask(rec)} />
  )
  return (
    <Box key={`${v.list}-row-${key}`} flexDirection="column" marginTop={i ? 1 : 0}>
      {i > 0 && Svg && <Svg source={v.svg(W, 1, `<line class="ln" x1="0" y1="0.5" x2="${W}" y2="0.5"/>`)} alt="" width={W} height={1} />}
      {isAsking ? (
        confirmBlock(v, rec, key)
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`${v.list}-${key}`} plain onPress={() => v.on.entry(rec, isOpen)}>
                <Text wrap="truncate-end">{`${foldGlyph(isOpen)} ${groupLine(rec, v.cols - 2 - (action ? 4 : 0))}`}</Text>
              </Button>
            </Box>
            <Box flexGrow={1} />
            {action && <Box flexShrink={0}>{action}</Box>}
          </Box>
          <Text dimColor wrap="truncate-end">
            {`  ${summaryLine(v, rec)}`}
          </Text>
          {isOpen && groupBody(v, rec, key)}
        </Box>
      )}
    </Box>
  )
}

// A row that throws draws one dim line in its place; the other rows still draw.
function safeRow(v: ArchiveView, rec: ArchiveRecord, i: number): RenderChildren {
  try {
    return sessionRow(v, rec, i)
  } catch {
    const { Text } = v.ui
    return (
      <Text key={`${v.list}-row-${keyOf(String(rec?.id ?? i))}`} dimColor>
        {v.list === 'archive' ? 'Archive group could not be drawn' : 'Trash group could not be drawn'}
      </Text>
    )
  }
}

// The Trash tab's first line while it holds sessions: `Empty Trash (n)`, or in its place the confirmation that names
// what goes, with Erase and Cancel.
function emptyLine(v: ArchiveView): RenderChildren {
  const { Box, Text, Button } = v.ui
  const w = v.words
  const n = v.records.length
  if (!(v.p.confirm?.list === 'trash' && v.p.confirm.all)) return <Button key="trash-empty" label={w.emptyTrash.replace('{n}', String(n))} plain onPress={v.on.askEmpty} />
  return (
    <Box key="trash-empty-confirm" flexDirection="column">
      <Text bold wrap="truncate-end">
        {(n === 1 ? w.emptyAskOne : w.emptyAsk).replace('{n}', String(n))}
      </Text>
      <Box flexDirection="row" gap={2}>
        <Button key="trash-empty-yes" label={w.erase} plain onPress={v.on.empty} />
        <Button key="trash-empty-cancel" label={w.cancel} plain onPress={v.on.cancel} />
      </Box>
    </Box>
  )
}

// The Archive or Trash tab's list: what the last read could not do, Empty Trash (the Trash, when it holds sessions), the
// sessions (a page of them, `Show more` for the rest), newest first.
export function archiveSection(v: ArchiveView): RenderChildren {
  const { Box, Text, Button } = v.ui
  const { p, records } = v
  const limit = v.list === 'archive' ? p.archiveLimit : p.trashLimit
  const shown = records.slice(0, limit)
  return (
    <Box key={`${v.list}-section`} flexDirection="column">
      {v.warnings.map((w, i) => (
        <Text key={`${v.list}-warning-${i}`} dimColor wrap="truncate-end">
          {w}
        </Text>
      ))}
      {v.list === 'trash' && v.canMove && records.length > 0 && <Box key="trash-empty-line" flexDirection="column" marginBottom={1}>{emptyLine(v)}</Box>}
      {records.length === 0 ? <Text dimColor>{v.list === 'archive' ? v.words.noArchive : v.words.trashEmpty}</Text> : shown.map((rec, i) => safeRow(v, rec, i))}
      {records.length > shown.length && <Button key={`${v.list}-more`} label={v.words.showMore.replace('{n}', String(records.length - shown.length))} plain onPress={v.on.more} />}
    </Box>
  )
}
