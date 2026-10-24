import { describe, expect, test } from 'claude-code/testing'

import { agentState, HOUSEKEEPING, splitHead, stateText } from '../hooks/agent-state'
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
