// An honest in-memory file system for the tests: what the engine's fs does that matters to saving.
// A read or write over 4 MiB of UTF-8 rejects; stat, the listing and `exists` can each fail on their own;
// a file can be there yet unreadable; `delay` holds any call, so two saves can be made to interleave.

export const ENGINE_MAX = 4 * 1024 * 1024 // 4 MiB, the engine's limit on one read or write

// UTF-8 length, counted here independently of the code under test.
export const utf8 = (s: string): number => {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

export type Fail = {
  /** every call fails, as when the fs is down */
  fs?: boolean
  read?: boolean
  write?: boolean | ((path: string) => boolean)
  stat?: boolean
  list?: boolean
  exists?: boolean
}

export type FakeFs = {
  files: Record<string, string>
  fail: Fail
  /** paths that are there but whose read rejects */
  unreadable: Set<string>
  /** paths whose read rejects as over 4 MiB, whatever their size */
  tooBig: Set<string>
  writes: string[]
  reads: string[]
  /** every write tried, with its size in bytes, refused or not */
  tried: { path: string; bytes: number }[]
  /** held before every call; resolve it later to let the call go on */
  delay: null | ((op: 'read' | 'write' | 'stat' | 'list' | 'exists', path: string) => Promise<void> | void)
  /** symbolic links: a path and where it lands, as a resolving stat answers */
  links: Record<string, string>
  /** another spelling a resolving stat gives a path (a Windows drive path), with no link */
  aliases: Record<string, string>
}

export function fakeFs(on: any, opts: { files?: Record<string, string>; fail?: Fail; unreadable?: string[]; tooBig?: string[] } = {}): FakeFs {
  const fs: FakeFs = {
    files: opts.files ?? {},
    fail: opts.fail ?? {},
    unreadable: new Set(opts.unreadable ?? []),
    tooBig: new Set(opts.tooBig ?? []),
    writes: [],
    reads: [],
    tried: [],
    delay: null,
    links: {},
    aliases: {},
  }
  const names = (dir: string) => {
    const pre = `${dir.replace(/\/$/, '')}/`
    return Object.keys(fs.files)
      .filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/'))
      .map(p => p.slice(pre.length))
  }
  on('fs.read', async (_$: any, e: any) => {
    await fs.delay?.('read', e.path)
    fs.reads.push(e.path)
    if (fs.fail.fs || fs.fail.read) throw new Error('EIO')
    if (fs.unreadable.has(e.path)) throw new Error('EACCES')
    if (!(e.path in fs.files)) throw new Error('ENOENT')
    if (fs.tooBig.has(e.path) || utf8(fs.files[e.path]!) > ENGINE_MAX) throw new Error('over 4 MiB')
    return { value: fs.files[e.path] }
  })
  on('fs.write', async (_$: any, e: any) => {
    await fs.delay?.('write', e.path)
    const bytes = utf8(e.text)
    fs.tried.push({ path: e.path, bytes })
    const w = fs.fail.write
    if (fs.fail.fs || w === true || (typeof w === 'function' && w(e.path))) throw new Error('EACCES')
    if (bytes > ENGINE_MAX) throw new Error('over 4 MiB')
    fs.writes.push(e.path)
    fs.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', async (_$: any, e: any) => {
    await fs.delay?.('stat', e.path)
    if (fs.fail.fs || fs.fail.stat) throw new Error('EIO')
    // Asked to resolve, a folder holding files stats as a folder, and `links` says where a path lands (itself else).
    if (e.resolve && !(e.path in fs.files) && Object.keys(fs.files).some(p => p.startsWith(`${e.path}/`))) {
      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: fs.aliases[e.path] ?? e.path } }
    }
    if (!(e.path in fs.files)) throw new Error('ENOENT')
    const link = fs.links[e.path]
    const real = e.resolve ? { realPath: link ?? fs.aliases[e.path] ?? e.path } : {}
    return { value: { kind: 'file', size: utf8(fs.files[e.path]!), mtimeMs: 0, isLink: !!link, ...real } }
  })
  on('fs.list', async (_$: any, e: any) => {
    await fs.delay?.('list', String(e.path))
    if (fs.fail.fs || fs.fail.list) throw new Error('EIO')
    const list = names(String(e.path))
    if (!list.length) throw new Error('ENOENT') // a folder with no files does not exist here
    return { value: list.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', async (_$: any, e: any) => {
    await fs.delay?.('exists', e.path)
    if (fs.fail.fs || fs.fail.exists) throw new Error('EIO')
    return { value: e.path in fs.files }
  })
  return fs
}
