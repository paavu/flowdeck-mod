// The folder a session saves under: Claude Code's own project folder, the one its transcript folder is named after
// (`<config>/projects/<key>/<session>.jsonl`), found among the working folder and its parents by name alone, or by the
// transcript file's presence; else the working folder. Nothing is remembered. register.tsx makes the fs calls (`$` never
// crosses an import); everything here is pure.

/** Claude Code's longest folder key before it cuts the rest and adds a hash. */
export const KEY_MAX = 200

const trimEnd = (p: string): string => p.replace(/[\\/]+$/, '')

// The folder above `dir`; null at a root ('/', 'C:\') or for a bare name.
export const parentOf = (dir: string): string | null => {
  const t = trimEnd(dir)
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (cut < 0) return null
  if (cut === 0) return '/'
  const up = t.slice(0, cut)
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up
}

// The working folder, then each parent up to the root.
export const ancestors = (cwd: string): string[] => {
  const out = [cwd]
  let dir: string | null = cwd
  while ((dir = parentOf(dir)) !== null) out.push(dir)
  return out
}

// Claude Code's 32-bit string hash, base 36, for keys past KEY_MAX.
const hash36 = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

// Claude Code's name for a project folder under `projects/`: every character outside [A-Za-z0-9] a '-'; past KEY_MAX
// characters, the first KEY_MAX, a '-' and the hash of the whole path.
export const projectKey = (path: string): string => {
  const key = path.replace(/[^a-zA-Z0-9]/g, '-')
  return key.length <= KEY_MAX ? key : `${key.slice(0, KEY_MAX)}-${hash36(path)}`
}

// The key a transcript path names: its folder's name; '' for anything else.
export const keyOfTranscript = (path: unknown): string => {
  if (typeof path !== 'string') return ''
  const parts = path.split(/[\\/]+/)
  return parts.length >= 3 && parts.at(-1) ? (parts.at(-2) ?? '') : ''
}

// The working folder or the nearest parent whose key is the transcript's; null when none is (the working folder is
// outside the project). Two in one chain cannot share a key short of a hash collision; the nearest would win.
export const projectByKey = (cwd: string, transcript: unknown): string | null => {
  const key = keyOfTranscript(transcript)
  if (!key || !cwd) return null
  // The key may be made from either Unicode form of the path; both are tried.
  return ancestors(cwd).find(dir => [dir, dir.normalize('NFC')].some(d => projectKey(trimEnd(d) || d) === key)) ?? null
}

// Where session `sid`'s transcript would be for each folder from `cwd` up, nearest first: the paths to look for when no
// transcript was named (a reload). `configDir` is Claude Code's config folder.
export const transcriptGuesses = (cwd: string, sid: string, configDir: string): Array<{ at: string; file: string }> =>
  !cwd || !sid || !configDir ? [] : ancestors(cwd).map(at => ({ at, file: `${trimEnd(configDir)}/projects/${projectKey(trimEnd(at) || at)}/${sid}.jsonl` }))
