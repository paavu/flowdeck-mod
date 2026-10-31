import type { EngineInterface } from 'claude-code'

const DESCRIPTION_MAX = 120
const REASON_MAX = 300
const APPROVE = 'Approve'
const DECLINE = 'Decline'

export const NEEDS_APPROVAL =
  "Fable needs the user's approval. Ask the user in chat with the failure reason; do not retry Fable without a yes."
export const DECLINED =
  'The user did not approve Fable. Keep the task on Opus heavy, or report to the user why it is stuck; do not retry Fable.'
export const GUARD_FAILED = 'flowdeck could not ask for approval, so Fable was not used. Keep the task on Opus heavy or report to the user.'

type Call = { subagent_type?: unknown; model?: unknown; description?: unknown; prompt?: unknown }

export const cut = (text: unknown, max: number): string => {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export const isFable = (e: Call): boolean =>
  /(^|:)flowdeck-fable$/.test(String(e.subagent_type ?? '').trim()) || String(e.model ?? '').trim().toLowerCase() === 'fable'

export const question = (e: Call): string =>
  `flowdeck wants to use Fable (the reserve tier) for: ${cut(e.description, DESCRIPTION_MAX) || 'a task'}. Reason: ${cut(e.prompt, REASON_MAX) || 'none given'}. Approve?`

// The text to deny a Fable launch with, or null when the user approved it (for this call only) or the call is not Fable.
export async function fableRefusal($: EngineInterface, e: Call): Promise<string | null> {
  if (!isFable(e)) return null
  try {
    const answer = await $.ui.ask(question(e), [APPROVE, DECLINE])
    return answer === APPROVE ? null : DECLINED
  } catch (error) {
    // A TypeError means this engine has no ask to call; a rejection is a dismissed question or a run with nobody to ask.
    return error instanceof TypeError ? NEEDS_APPROVAL : DECLINED
  }
}
