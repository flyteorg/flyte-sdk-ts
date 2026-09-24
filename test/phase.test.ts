/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { describe, expect, it } from 'vitest'

import { ActionPhase, isSuccess, isTerminal, phaseName } from '../src/phase'

describe('phaseName', () => {
  it('returns the short enum name', () => {
    expect(phaseName(ActionPhase.SUCCEEDED)).toBe('SUCCEEDED')
    expect(phaseName(ActionPhase.WAITING_FOR_RESOURCES)).toBe('WAITING_FOR_RESOURCES')
  })

  it('falls back to UNKNOWN for phases this SDK build does not know', () => {
    expect(phaseName(99 as ActionPhase)).toBe('UNKNOWN')
  })
})

describe('isTerminal', () => {
  it.each([
    ActionPhase.SUCCEEDED,
    ActionPhase.FAILED,
    ActionPhase.ABORTED,
    ActionPhase.TIMED_OUT,
    ActionPhase.RECOVERED,
  ])('treats %s as terminal', (phase) => {
    expect(isTerminal(phase)).toBe(true)
  })

  it.each([
    ActionPhase.UNSPECIFIED,
    ActionPhase.QUEUED,
    ActionPhase.WAITING_FOR_RESOURCES,
    ActionPhase.INITIALIZING,
    ActionPhase.RUNNING,
    ActionPhase.PAUSED,
  ])('treats %s as non-terminal', (phase) => {
    expect(isTerminal(phase)).toBe(false)
  })
})

describe('isSuccess', () => {
  it('counts SUCCEEDED and RECOVERED as success', () => {
    // RECOVERED marks an action whose result was reused from a source run
    // without re-executing, so it is a successful outcome.
    expect(isSuccess(ActionPhase.SUCCEEDED)).toBe(true)
    expect(isSuccess(ActionPhase.RECOVERED)).toBe(true)
  })

  it('does not count other terminal phases as success', () => {
    expect(isSuccess(ActionPhase.FAILED)).toBe(false)
    expect(isSuccess(ActionPhase.ABORTED)).toBe(false)
    expect(isSuccess(ActionPhase.TIMED_OUT)).toBe(false)
    expect(isSuccess(ActionPhase.RUNNING)).toBe(false)
  })
})
