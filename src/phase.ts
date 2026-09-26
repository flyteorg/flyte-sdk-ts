/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Helpers around the `flyteidl2.common.ActionPhase` enum. */

import { ActionPhase } from './gen/flyteidl2/common/phase_pb'

export { ActionPhase }

/** Human-readable phase name, e.g. `SUCCEEDED`. */
export function phaseName(phase: ActionPhase): string {
  return ActionPhase[phase] ?? 'UNKNOWN'
}

const TERMINAL_PHASES: ReadonlySet<ActionPhase> = new Set([
  ActionPhase.SUCCEEDED,
  ActionPhase.FAILED,
  ActionPhase.ABORTED,
  ActionPhase.TIMED_OUT,
  ActionPhase.RECOVERED,
])

/** True once the action can no longer change phase. */
export function isTerminal(phase: ActionPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/**
 * True if the action finished successfully. RECOVERED counts: it marks an
 * action whose result was reused from a source run without re-executing.
 */
export function isSuccess(phase: ActionPhase): boolean {
  return phase === ActionPhase.SUCCEEDED || phase === ActionPhase.RECOVERED
}
