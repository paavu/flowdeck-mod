// The flow shown in the panel, kept on disk so it survives a restart and the next session can close it:
// `<project>/.claude/flowdeck/flow-live.json` (the folder's `*` .gitignore keeps it out of git).
//
// One record per session, `{version, sessions: {<session id>: record}}`: two sessions in one project each write their
// own record and never overwrite the other's (every write reads the file again and changes only the records it means
// to; fields and records it does not know are written back as they were). A file that cannot be read, or whose
// existence cannot be told, or that holds no such object, is never written. Nothing here erases a file: a record is
// taken out by writing the file again without it.
import type { AgentRun, Flow } from '../types'
import { keyOf, WRITE_MAX } from './archive'
import { dataDir, getFile, parseJson, writeData } from './archive-store'
import type { Io } from './archive-store'
import { asAgents, asFlow, asMeta } from './shapes'

export const LIVE_FILE = 'flow-live.json'
export const LIVE_VERSION = 1
/** A flow with no run going and no task queued, idle this long while its session lives, finishes itself. */
export const IDLE_FINISH_MS = 30 * 60_000
/** While a flow is shown its record is written at least this often: the heartbeat that tells another session this one lives. */
export const LIVE_BEAT_MS = 60_000
/** Another session's record not marked ended and not written for this long belongs to a session that is gone. */
export const LIVE_STALE_MS = 3 * 60_000

export type LiveMeta = { startedAt: number; project: string }

/** One session's flow as it stood: what the panel held, when it last changed, when it was last written, when the session ended. */
export type LiveRecord = {
  sessionId: string
  /** The session's transcript file, when the engine named it (classic.SessionStart `transcript_path`). */
  transcript?: string
  flow: Flow
  agents: AgentRun[]
  meta: LiveMeta | null
  /** When the flow, its runs or its record last changed (clock ms). */
  lastActivityAt: number
  /** When the record was last written (the heartbeat). */
  beatAt: number
  /** Set by the session's end (`session.end`): the session is gone. */
  endedAt?: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// One record as read; null when it holds no flow (it is then left in the file as it is).
export function asRecord(v: unknown, sid: string): LiveRecord | null {
  if (!isObj(v)) return null
  const flow = asFlow(v.flow)
  if (!flow) return null
  const endedAt = num(v.endedAt)
  return {
    sessionId: typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : sid,
    ...(typeof v.transcript === 'string' && v.transcript ? { transcript: v.transcript } : {}),
    flow,
    agents: asAgents(v.agents),
    meta: asMeta(v.meta),
    lastActivityAt: num(v.lastActivityAt) ?? 0,
    beatAt: num(v.beatAt) ?? 0,
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

export type LiveRead =
  | { state: 'missing' }
  | { state: 'ok'; records: LiveRecord[]; raw: Obj }
  /** Not read, or not a live file: never written over. */
  | { state: 'bad'; why: string }

const path = (project: string): string => `${dataDir(project)}/${LIVE_FILE}`

const UNREADABLE = `${LIVE_FILE} could not be read; it is left as it is and the panel starts without it`
const NOT_LIVE = `${LIVE_FILE} holds no flowdeck state; it is left as it is and the panel starts without it`

// The file's records; a record that holds no flow is left out here and kept in the file.
export async function readLive(io: Io, project: string): Promise<LiveRead> {
  const got = await getFile(io, path(project))
  if (got.state === 'missing') return { state: 'missing' }
  if (got.state === 'unreadable') return { state: 'bad', why: UNREADABLE }
  const raw = parseJson(got.text)
  if (!isObj(raw) || !isObj(raw.sessions)) return { state: 'bad', why: NOT_LIVE }
  const records = Object.entries(raw.sessions).flatMap(([sid, v]) => {
    const r = asRecord(v, sid)
    return r ? [r] : []
  })
  return { state: 'ok', records, raw }
}

/** `bad`: why the file may not be written (the same words as readLive's); `failed`: the write itself failed or was too big. */
export type LiveWrite = { state: 'ok' } | { state: 'failed' } | { state: 'bad'; why: string }

// Read, change, write: `change` gets the records by session id as the file holds them now (or none for a missing file)
// and returns them as they should be; every other field of the file stays. A write past 3,900,000 bytes is not sent.
export async function changeLive(io: Io, project: string, change: (sessions: Obj) => Obj): Promise<LiveWrite> {
  const got = await getFile(io, path(project))
  if (got.state === 'unreadable') return { state: 'bad', why: UNREADABLE }
  const raw = got.state === 'ok' ? parseJson(got.text) : {}
  if (got.state === 'ok' && !(isObj(raw) && isObj(raw.sessions))) return { state: 'bad', why: NOT_LIVE }
  const base = isObj(raw) ? raw : {}
  const sessions = change(isObj(base.sessions) ? { ...base.sessions } : {})
  return (await writeData(io, dataDir(project), LIVE_FILE, { ...base, version: LIVE_VERSION, sessions }, WRITE_MAX)) ? { state: 'ok' } : { state: 'failed' }
}

export const without = (sessions: Obj, ids: string[]): Obj => Object.fromEntries(Object.entries(sessions).filter(([sid]) => !ids.includes(sid)))

// The runs still running when their session ended, ended then: their status stays, so they read `Running at finish`.
export const endRuns = (list: AgentRun[], at: number): AgentRun[] =>
  list.map(a => {
    if (a.status !== 'running' || a.endedAt !== undefined) return a
    const { tool: _t, isAsked: _a, ...rest } = a
    return { ...rest, endedAt: at }
  })

// What the panel holds, as one short key: a change of it is activity.
export const liveKey = (flow: Flow, agents: AgentRun[], meta: LiveMeta | null): string => keyOf(JSON.stringify({ flow, agents, meta }))

// Whether a record of another session is to be closed now: its session ended, or has not written it for LIVE_STALE_MS.
// Else that session may still run in another window, and the record is left for a later check.
export const isGone = (r: LiveRecord, now: number): boolean => r.endedAt !== undefined || now - r.beatAt >= LIVE_STALE_MS
