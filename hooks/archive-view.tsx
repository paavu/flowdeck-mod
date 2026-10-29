// The archive in the panel: its section (Back to latest, the volume list, the warning, the groups, Show older) and one
// group per past flow. It draws only: the data, the panel's flow drawing and every press come from register.tsx.
import type { Elements, RenderChildren } from 'claude-code'

import type { AgentRun, ArchiveAgent, ArchiveEntry, ArchiveVolume, Panel, PlannedTask, TaskPlan } from '../types'
import { formatEntry, groupLine, keyOf, spanOf, spanText } from './archive'
import { acceptedOf } from './tasks'

export const ARCHIVE_PAGE = 10

// The file keeps its original name, so the text names it as it is.
export const UNREADABLE = 'history.json could not be read; showing recovered entries (the file is untouched)'

/** A planned task, numbered in plan order; `ready` once everything it waits for is done. */
export type Planned = PlannedTask & { n: number; ready?: boolean }
export type Totals = { cost: number; tokens: number; time: number }

// One flow as the panel draws it, live or from the archive: the header (title and the three tiles, then
// `controls`) and, on demand, the body (running, the `Finished · N` fold, planned; `flat`, the archive's: every row
// newest first, then planned). `at` is the clock the rows count to.
export type FlowView = {
  kp: string
  fp: string
  title: string
  list: AgentRun[]
  /** The flow's tasks in plan order: a run that belongs to one shows its number and what it waits for. */
  tasks?: { title: string; tier?: string; after?: number[] }[]
  /** The accepted task numbers (from 1): a run of one never hides an Incomplete state; one without a run is an Accepted row. */
  accepted?: number[]
  planned: Planned[]
  at: number
  t: Totals
  controls: RenderChildren
  /** The live flow only: which finished rows get an Archive button, and its press. */
  archive?: { can: (a: AgentRun) => boolean; press: (a: AgentRun) => unknown }
} & ({ flat?: false; isDoneCollapsed: boolean; doneKey: string; onDone: () => unknown } | { flat: true })
export type FlowDrawing = { header: RenderChildren; body: () => RenderChildren }

export type ArchiveView = {
  ui: Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>
  /** The desktop's drawing element; null in the terminal. */
  Svg: Elements['desktop']['Svg'] | null
  W: number
  /** The panel's width in columns: the date line fits it. */
  cols: number
  svg: (W: number, H: number, body: string) => string
  fmt: { cost: (usd: number) => string; tokens: (n: number) => string; time: (ms: number) => string }
  tokensWord: string
  p: Panel
  /** The part shown: the latest one, or the volume being browsed. */
  entries: ArchiveEntry[]
  volumes: ArchiveVolume[]
  flowView: (v: FlowView) => FlowDrawing
  /** One plan drawn as the Plans section draws it; `kp` prefixes its keys, `at` is its clock. */
  plan: (pl: TaskPlan, kp: string, at: number) => RenderChildren
  on: {
    entry: (id: string, isOpen: boolean) => unknown
    list: () => unknown
    volume: (file: string) => unknown
    latest: () => unknown
    more: () => unknown
  }
}

// A saved run as it ended, with an end: one saved while still going keeps its status and reads as Running at finish, its
// clock stopped at the save (the end is what tells it from a live run).
const endedRun = (a: ArchiveAgent, end: number): AgentRun => ({ ...a, endedAt: a.endedAt ?? end })

const flows = (n: number): string => `${n} ${n === 1 ? 'flow' : 'flows'}`

// A past flow as a group: its fold (end date and item count) and its tiles always;
// opened, the flow as it ended with its rows flat, or the task list of an entry saved without runs. The Archive holds
// finished work only, so a group never draws the flow's unstarted tasks.
// A finished plan is a group of its own: its fold (end date and step count) and, opened, the plan as the Plans section
// draws it (title, state, percent); it has no tiles.
// The first group shown is open unless the user folded it; the others are folded unless the user opened them.
function archiveGroup(v: ArchiveView, entry: ArchiveEntry, i: number): RenderChildren {
  const { Box, Text, Button } = v.ui
  const { Svg, W, p } = v
  const { lines } = formatEntry(entry)
  const key = keyOf(entry.id)
  const isOpen = !(p.closedEntries ?? []).includes(entry.id) && (i === 0 || p.openEntries.includes(entry.id))
  const runs = (entry.agents ?? []).map(a => endedRun(a, entry.endedAt))
  const view = entry.plan
    ? null
    : v.flowView({
        kp: `archive-${key}-`,
        fp: `${entry.id}:`,
        // Archived flows are all finished: the group shows no title.
        title: '',
        list: runs,
        tasks: entry.tasks,
        accepted: acceptedOf(entry),
        planned: [],
        at: entry.endedAt,
        t: { cost: entry.cost, tokens: entry.tokens, time: entry.time },
        flat: true,
        controls: null,
      })
  const body = !isOpen
    ? null
    : entry.plan
      ? v.plan(entry.plan, `archive-${key}-`, entry.endedAt)
      : view && runs.length
        ? Svg
          ? view.body()
          : <Box flexDirection="column" marginTop={1}>{view.body()}</Box>
        : lines.map((l, k) => (
            <Text key={`archive-${key}-${k}`} dimColor wrap="truncate-end">
              {l}
            </Text>
          ))
  return (
    <Box key={`archive-row-${key}`} flexDirection="column" marginTop={i ? 1 : 0}>
      {i > 0 && Svg && <Svg source={v.svg(W, 1, `<line class="ln" x1="0" y1="0.5" x2="${W}" y2="0.5"/>`)} alt="" width={W} height={1} />}
      <Button key={`archive-${key}`} plain onPress={() => v.on.entry(entry.id, isOpen)}>
        <Text wrap="truncate-end">{`${isOpen ? '▾' : '▸'} ${groupLine(entry, v.cols - 2)}`}</Text>
      </Button>
      {view?.header}
      {body}
    </Box>
  )
}

// A group that throws draws one dim line in its place; the other groups still draw.
function safeGroup(v: ArchiveView, entry: ArchiveEntry, i: number): RenderChildren {
  try {
    return archiveGroup(v, entry, i)
  } catch {
    const { Text } = v.ui
    return (
      <Text key={`archive-row-${keyOf(String(entry?.id ?? i))}`} dimColor>
        Archive group could not be drawn
      </Text>
    )
  }
}

// The Archive section, null while it is hidden.
export function archiveSection(v: ArchiveView): RenderChildren {
  const { Box, Text, Button } = v.ui
  const { p, entries, volumes, fmt } = v
  if (!p.isArchiveShown) return null
  const shown = entries.slice(0, p.archiveLimit ?? ARCHIVE_PAGE)
  const span = spanOf(entries)
  return (
    <Box key="archive-section" flexDirection="column">
      {p.archiveVolume != null && <Button key="archive-latest" label="Back to latest" plain onPress={v.on.latest} />}
      {volumes.length > 0 && (
        <Button
          key="archive-older"
          label={`${p.archiveListOpen ? '▾' : '▸'} Older volumes (${volumes.length} ${volumes.length === 1 ? 'file' : 'files'})`}
          plain
          onPress={v.on.list}
        />
      )}
      {p.archiveListOpen &&
        volumes.map(sg => (
          <Box key={`archive-seg-row-${sg.file}`} flexDirection="column">
            <Button key={`archive-seg-${sg.file}`} label={spanText(sg.from, sg.to)} plain onPress={() => v.on.volume(sg.file)} />
            <Text dimColor wrap="truncate-end">
              {`${flows(sg.count)} · ≈${fmt.cost(sg.cost)} · ${fmt.tokens(sg.tokens)} ${v.tokensWord} · ${fmt.time(sg.time)}`}
            </Text>
          </Box>
        ))}
      {p.archiveError ? <Text dimColor>{`could not load ${p.archiveError}`}</Text> : null}
      {p.archiveVolume == null && p.archiveWarning ? (
        <Text key="archive-warning" dimColor>
          {p.archiveWarning}
        </Text>
      ) : null}
      {entries.length > 0 && (
        <Text dimColor wrap="truncate-end">
          {`Showing ${spanText(span.from, span.to)} · ${flows(entries.length)}`}
        </Text>
      )}
      {entries.length === 0 ? <Text dimColor>no archive yet</Text> : shown.map((entry, i) => safeGroup(v, entry, i))}
      {entries.length > shown.length && <Button key="archive-more" label={`Show older (${entries.length - shown.length})`} plain onPress={v.on.more} />}
    </Box>
  )
}
