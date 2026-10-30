// The archive's files as the tests read and seed them (1.0.0025 on): one session file per saved session in
// `<dir>/archive/`, the index `<dir>/archive-index.json`, the trash copies and their index in `<dir>/.trash/`.
import { parseSession } from '../hooks/archive'
import { indexText, recordOf, sessionName, TRASH_INDEX } from '../hooks/archive-index'

export const indexPath = (dir: string): string => `${dir}/archive-index.json`
export const trashIndexPath = (dir: string): string => `${dir}/.trash/${TRASH_INDEX}`
export const markerPath = (dir: string): string => `${dir}/archive-migrated.json`

const inFolder = (files: Record<string, string>, folder: string): string[] =>
  Object.keys(files)
    .filter(p => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/') && p.endsWith('.json'))
    .sort()

const byEnd = (list: any[]): any[] => [...list].sort((a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** The session files' entries in `archive/`, newest first by their end (the panel's order). */
export const sessions = (files: Record<string, string>, dir: string): any[] =>
  byEnd(inFolder(files, `${dir}/archive`).flatMap(p => JSON.parse(files[p]!) ?? []))

/** The session files' paths in `archive/`. */
export const sessionPaths = (files: Record<string, string>, dir: string): string[] => inFolder(files, `${dir}/archive`)

/** The trash copies' entries in `.trash/` (the trash index left out). */
export const trashCopies = (files: Record<string, string>, dir: string): any[] =>
  byEnd(
    inFolder(files, `${dir}/.trash`)
      .filter(p => !p.endsWith(`/${TRASH_INDEX}`))
      .map(p => JSON.parse(files[p]!)),
  )

/** An index's records as written (newest first), or undefined when the file is not there. */
export const records = (files: Record<string, string>, path: string): any[] | undefined => (path in files ? JSON.parse(files[path]!).sessions : undefined)

export const titles = (list: any[] | undefined): string[] => (list ?? []).map(e => e.title)

/** Seeds sessions as a save leaves them: each in its file and listed in the index. */
export function seed(files: Record<string, string>, dir: string, entries: any[]): void {
  const recs = entries.map(e => {
    const text = JSON.stringify(e)
    const file = sessionName(e)
    files[`${dir}/archive/${file}`] = text
    return recordOf(parseSession(e)!, file, new TextEncoder().encode(text).length)
  })
  files[indexPath(dir)] = indexText(recs)
}

export const fileOf = (e: { id: string; startedAt: number }): string => sessionName(e)
