// The archive in the panel: its section (Back to latest, the volume list, the warning, the groups, Show older) and one
// group per past flow. It draws only: the data, the panel's flow drawing and every press come from register.tsx.
import type { Elements, RenderChildren } from 'claude-code'

import type { AgentRun, ArchiveAgent, ArchiveEntry, ArchiveVolume, Panel, PlannedTask } from '../types'
import { entryLine, formatEntry, spanOf, spanText } from './archive'

export const ARCHIVE_PAGE = 10

// The file keeps its original name, so the text names it as it is.
export const UNREADABLE = 'history.json could not be read; showing recovered entries (the file is untouched)'

export type Planned = PlannedTask & { n: number }
export type Totals = { cost: number; tokens: number; time: number }

// One flow as the panel draws it, live or from the archive: the header (title and the three tiles, then
// `controls`) and, on demand, the body (running, the `Finished · N` fold, planned; `flat`, the archive's: every row
// newest first, then planned). `at` is the clock the rows count to.
export type FlowView = {
  kp: string
  fp: string
  title: string
  list: AgentRun[]
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
  unstarted: (tasks: PlannedTask[], list: AgentRun[]) => Planned[]
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

// A past flow as a group: its fold (title, date, done/total, how it ended) and its tiles always;
// opened, the flow as it ended with its rows flat, or the task list of an entry saved without runs.
// The first group shown is open unless the user folded it; the others are folded unless the user opened them.
function archiveGroup(v: ArchiveView, entry: ArchiveEntry, i: number): RenderChildren {
  const { Box, Text, Button } = v.ui
  const { Svg, W, p } = v
  const { head, lines } = formatEntry(entry)
  const isOpen = !(p.closedEntries ?? []).includes(entry.id) && (i === 0 || p.openEntries.includes(entry.id))
  const runs = (entry.agents ?? []).map(a => endedRun(a, entry.endedAt))
  const tasks = entry.tasks.map(tk => ({ title: tk.title, tier: tk.tier, after: tk.after ?? [] }))
  const view = v.flowView({
    kp: `archive-${entry.id}-`,
    fp: `${entry.id}:`,
    // The fold above already names the flow.
    title: '',
    list: runs,
    planned: v.unstarted(tasks, runs),
    at: entry.endedAt,
    t: { cost: entry.cost, tokens: entry.tokens, time: entry.time },
    flat: true,
    controls: null,
  })
  const body = !isOpen
    ? null
    : runs.length
      ? Svg
        ? view.body()
        : <Box flexDirection="column" marginTop={1}>{view.body()}</Box>
      : lines.map((l, k) => (
          <Text key={`archive-${entry.id}-${k}`} dimColor wrap="truncate-end">
            {l}
          </Text>
        ))
  return (
    <Box key={`archive-row-${entry.id}`} flexDirection="column" marginTop={i ? 1 : 0}>
      {i > 0 && Svg && <Svg source={v.svg(W, 1, `<line class="ln" x1="0" y1="0.5" x2="${W}" y2="0.5"/>`)} alt="" width={W} height={1} />}
      <Button key={`archive-${entry.id}`} plain onPress={() => v.on.entry(entry.id, isOpen)}>
        <Text wrap="truncate-end">{`${isOpen ? '▾' : '▸'} ${head}`}</Text>
      </Button>
      <Text dimColor wrap="truncate-end">{`  ${entryLine(entry, v.cols - 2)}`}</Text>
      {view.header}
      {body}
    </Box>
  )
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
      {entries.length === 0 ? <Text dimColor>no archive yet</Text> : shown.map((entry, i) => archiveGroup(v, entry, i))}
      {entries.length > shown.length && <Button key="archive-more" label={`Show older (${entries.length - shown.length})`} plain onPress={v.on.more} />}
    </Box>
  )
}
