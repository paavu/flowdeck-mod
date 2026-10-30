import { describe, expect, test } from 'claude-code/testing'

import { agentState, HOUSEKEEPING, progressOf, splitHead, stateText, stepCount } from '../hooks/agent-state'
import { STATE_COLOR } from '../hooks/plan-view'

describe('agent state on the progress line', () => {
  test('a running agent is Running in blue-violet', () => {
    expect(agentState({ status: 'running' })).toEqual({ name: 'Running', color: STATE_COLOR.running })
  })

  test('a running agent waiting on a permission dialog is Needs approval in amber', () => {
    expect(agentState({ status: 'running', isAsked: true })).toEqual({ name: 'Needs approval', color: STATE_COLOR.needs_input })
  })

  test('a finished run is Done in green and a failed one Error in red', () => {
    expect(agentState({ status: 'done' })).toEqual({ name: 'Done', color: STATE_COLOR.done })
    expect(agentState({ status: 'failed' })).toEqual({ name: 'Error', color: STATE_COLOR.error })
  })

  test('a finished run ignores a leftover approval flag', () => {
    expect(agentState({ status: 'done', isAsked: true }).name).toBe('Done')
  })

  test('the running text names the live tool; no tool yet is plain Running', () => {
    expect(stateText({ status: 'running', tool: 'Bash' })).toBe('Running · Bash')
    expect(stateText({ status: 'running' })).toBe('Running')
  })

  test('Needs approval, Done and Error do not carry the tool word', () => {
    expect(stateText({ status: 'running', isAsked: true, tool: 'Bash' })).toBe('Needs approval')
    expect(stateText({ status: 'done', tool: 'Bash' })).toBe('Done')
    expect(stateText({ status: 'failed', tool: 'Bash' })).toBe('Error')
  })

  test('a run saved while still running (status running, an end) is Running at finish in blue-violet, without a tool word', () => {
    expect(agentState({ status: 'running', endedAt: 5 })).toEqual({ name: 'Running at finish', color: STATE_COLOR.running })
    expect(stateText({ status: 'running', endedAt: 5, tool: 'Bash' })).toBe('Running at finish')
    expect(agentState({ status: 'done', endedAt: 5 }).name).toBe('Done')
  })

  test('the housekeeping tools are flowdeck’s own step, progress and plan', () => {
    expect([...HOUSEKEEPING].sort()).toEqual(['mcp__flowdeck__plan', 'mcp__flowdeck__progress', 'mcp__flowdeck__step'])
    expect(HOUSEKEEPING.has('Bash')).toBe(false)
  })

  test('splitHead keeps the coloured head whole, or all of a line cut inside it', () => {
    expect(splitHead('Running · Bash · 2/5', 'Running · Bash')).toEqual(['Running · Bash', ' · 2/5'])
    expect(splitHead('Running · Ba…', 'Running · Bash')).toEqual(['Running · Ba…', ''])
    expect(splitHead('Running · Bash · 2…', 'Running · Bash')).toEqual(['Running · Bash', ' · 2…'])
  })
})

describe('the step number on a row', () => {
  test('a running run names its active step: 5 done of 7 with the 6th active reads 6/7; the bar stays 5/7', () => {
    const a = { status: 'running' as const, stepDone: 5, stepTotal: 7, stepNote: 'run suite' }
    expect(stepCount(a)).toBe('6/7')
    expect(Math.abs((progressOf(a as any) ?? 0) - 5 / 7) < 1e-9).toBe(true)
    expect(stepCount({ ...a, stepDone: 0 })).toBe('1/7')
    expect(stepCount({ ...a, stepDone: 7 })).toBe('7/7') // never past the total
  })

  test('without an active step, or once the run ended, the done count', () => {
    expect(stepCount({ status: 'running', stepDone: 5, stepTotal: 7 })).toBe('5/7')
    expect(stepCount({ status: 'done', stepDone: 7, stepTotal: 7 })).toBe('7/7')
    expect(stepCount({ status: 'done', stepDone: 5, stepTotal: 7, stepNote: 'run suite' })).toBe('5/7') // Incomplete
    expect(stepCount({ status: 'failed', stepDone: 5, stepTotal: 7, stepNote: 'run suite' })).toBe('5/7')
    expect(stepCount({ status: 'running', endedAt: 1, stepDone: 5, stepTotal: 7, stepNote: 'run suite' })).toBe('5/7') // Running at finish
  })
})
