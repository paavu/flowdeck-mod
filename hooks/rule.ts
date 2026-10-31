// Task tracking: whether flowdeck's flow rule goes into every session's system prompt. One choice for every project,
// kept in the engine store under `rule`; `unset` until the user picks one (the panel's strip asks). `/flowdeck:flowdeck`
// turns the rule on for its own session whatever the choice.
import type { Rule } from '../types'

export const RULE_KEY = 'rule'

/** A stored value read tolerantly: anything but `on` or `off` is `unset`. */
export const asRule = (v: unknown): Rule => (v === 'on' || v === 'off' ? v : 'unset')

/** Whether the store holds a choice already made (or `unset` saved by a fresh install), so no migration runs. */
export const isStoredRule = (v: unknown): boolean => v === 'on' || v === 'off' || v === 'unset'

/** The top row's switch: on turns off, unset and off turn on. */
export const toggledRule = (r: Rule): Rule => (r === 'on' ? 'off' : 'on')

/** Engine-store keys only an earlier flowdeck wrote: any of them set means the mod ran before the choice existed. */
export const PRIOR_STORE_KEYS = ['history', 'keepWarm', 'contextShown', 'usageShown', 'usageRemaining', 'historyShown'] as const

/** Names in `<project>/.claude/flowdeck/` that only a recorded flow leaves (the folder's `.gitignore` is not one). */
export const isPriorFile = (name: string): boolean =>
  name === 'flow-live.json' || name === 'archive-index.json' || name === 'archive' || name === 'archive-migrated.json' || /^history.*\.json$/.test(name)

/** Characters a token of a tool's JSON schema, as Claude Code's `/context` counts it (measured on 2.1.312: 2.0). */
export const SCHEMA_CHARS_PER_TOKEN = 2

/** Tokens in `chars` characters: English prose at about 3.6 characters a token (an estimate, no tokenizer). */
export const estimateTokens = (chars: number, perToken = 3.6): number => Math.round(chars / perToken)
