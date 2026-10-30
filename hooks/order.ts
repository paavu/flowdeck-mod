// The one order of every list in the panel: latest completion on top. Ties go to the later start, then to the id, so the
// order never depends on when a row was archived, trashed or restored, or on the order it was read in.
export type Placed = { end: number; start: number; id: string }

export const newestFirst = (a: Placed, b: Placed): number => b.end - a.end || b.start - a.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export const sortNewest = <T>(list: readonly T[], place: (t: T) => Placed): T[] =>
  list
    .map(t => ({ t, k: place(t) }))
    .sort((x, y) => newestFirst(x.k, y.k))
    .map(x => x.t)
