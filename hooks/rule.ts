// Task tracking: whether flowdeck's flow rule goes into every session's system prompt. One choice for every project,
// kept in the engine store under `rule`; on from install, and only an explicit `off` stops it (`unset`, saved by earlier
// releases, counts as on). `/flowdeck:flowdeck` turns the rule on for its own session whatever the choice.
import type { Rule } from '../types'

export const RULE_KEY = 'rule'

/** A stored value read tolerantly: anything but `on` or `off` is `unset`. */
export const asRule = (v: unknown): Rule => (v === 'on' || v === 'off' ? v : 'unset')

/** Whether the store holds a choice already made (or `unset` saved by an earlier release), so no migration runs. */
export const isStoredRule = (v: unknown): boolean => v === 'on' || v === 'off' || v === 'unset'

/** Whether a choice tracks tasks: everything but an explicit `off`. */
export const isTracking = (r: Rule): boolean => r !== 'off'

/** The top row's switch: off turns on, on and unset turn off. */
export const toggledRule = (r: Rule): Rule => (isTracking(r) ? 'off' : 'on')

/** Characters a token of a tool's JSON schema, as Claude Code's `/context` counts it (measured on 2.1.312: 2.0). */
export const SCHEMA_CHARS_PER_TOKEN = 2

/** Tokens in `chars` characters: English prose at about 3.6 characters a token (an estimate, no tokenizer). */
export const estimateTokens = (chars: number, perToken = 3.6): number => Math.round(chars / perToken)
