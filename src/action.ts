/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * A handle to a single action of a run: the root task, a child task, a
 * condition, or a trace. Instances from listings carry identity, metadata,
 * and last known status; after `refresh()` (or when fetched via
 * `RunHandle.action`) they additionally carry full details: error/abort/
 * signal info and per-attempt records.
 */

import type { ClientContext } from './context'
import { FlyteRunFailedError, FlyteTimeoutError } from './errors'
import type { ActionIdentifier } from './gen/flyteidl2/common/identifier_pb'
import type {
  AbortInfo,
  ActionAttempt,
  ActionDetails,
  ErrorInfo,
  SignalInfo,
} from './gen/flyteidl2/workflow/run_definition_pb'
import { ActionType } from './gen/flyteidl2/workflow/run_definition_pb'
import { ActionPhase, isSuccess, isTerminal, phaseName } from './phase'
import type { WatchOptions, WatchUpdate } from './watch'
import { watchActionPhases } from './watch'

export { ActionType }

export interface ActionWaitOptions extends WatchOptions {
  /** Give up after this many milliseconds. Default: no timeout. */
  timeoutMs?: number
  /** Optional callback invoked on every phase change. */
  onPhase?: (phase: ActionPhase) => void
}

export class ActionHandle {
  constructor(
    protected readonly ctx: ClientContext,
    protected pb: ActionDetails,
  ) {}

  /** Identifier of this action. */
  get id(): ActionIdentifier | undefined {
    return this.pb.id
  }

  /** Action name (e.g. `a0` for the root action). */
  get name(): string {
    return this.pb.id?.name ?? ''
  }

  /** Name of the run this action belongs to. */
  get runName(): string {
    return this.pb.id?.run?.name ?? ''
  }

  /** Name of the parent action (empty for the root action). */
  get parent(): string {
    return this.pb.metadata?.parent ?? ''
  }

  /** Whether this is a task, condition, or trace action. */
  get actionType(): ActionType {
    return this.pb.metadata?.actionType ?? ActionType.UNSPECIFIED
  }

  /** Last observed phase. Call `refresh()` (or `wait`/`watch`) to update. */
  get phase(): ActionPhase {
    return this.pb.status?.phase ?? ActionPhase.UNSPECIFIED
  }

  /** How many attempts have been made so far. */
  get attempts(): number {
    return this.pb.status?.attempts ?? 0
  }

  /** Source action identifier when this action was recovered from a previous run. */
  get recoveredFrom(): ActionIdentifier | undefined {
    return this.pb.metadata?.recoveredFrom
  }

  /** Failure details when the action failed. Populated on full details. */
  get errorInfo(): ErrorInfo | undefined {
    return this.pb.result.case === 'errorInfo' ? this.pb.result.value : undefined
  }

  /** Abort reason and principal when the action was aborted. Populated on full details. */
  get abortInfo(): AbortInfo | undefined {
    return this.pb.result.case === 'abortInfo' ? this.pb.result.value : undefined
  }

  /** Signal principal and payload for a signalled condition. Populated on full details. */
  get signalInfo(): SignalInfo | undefined {
    return this.pb.result.case === 'signalInfo' ? this.pb.result.value : undefined
  }

  /** Per-attempt records (error info, logs, timings). Populated on full details. */
  get attemptDetails(): ActionAttempt[] {
    return this.pb.attempts
  }

  /** The underlying protobuf, for advanced use. */
  get details(): ActionDetails {
    return this.pb
  }

  /** Re-fetches the action's full details, updating the handle in place. */
  async refresh(): Promise<this> {
    const res = await this.ctx.services.run.getActionDetails({ actionId: this.pb.id })
    if (res.details) {
      this.pb = res.details
    }
    return this
  }

  /**
   * Streams status updates until the action reaches a terminal phase.
   * Transient stream drops are reconnected transparently.
   */
  async *watch(options: WatchOptions = {}): AsyncGenerator<WatchUpdate, void> {
    if (!this.pb.id) return
    for await (const update of watchActionPhases(this.ctx, this.pb.id, options)) {
      this.pb = update.details
      yield update
    }
  }

  /**
   * Waits until the action reaches a terminal phase and returns its details.
   * Throws {@link FlyteRunFailedError} when it did not succeed (RECOVERED
   * counts as success).
   */
  async wait(options: ActionWaitOptions = {}): Promise<ActionDetails> {
    if (!isTerminal(this.phase)) {
      const timeoutSignal =
        options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined
      const signal = combineSignals(options.signal, timeoutSignal)
      let lastPhase: ActionPhase | undefined
      for await (const update of this.watch({ ...options, signal })) {
        if (update.phase !== lastPhase) {
          lastPhase = update.phase
          options.onPhase?.(update.phase)
        }
      }
      if (timeoutSignal?.aborted && !isTerminal(this.phase)) {
        throw new FlyteTimeoutError(
          `Action "${this.name}" did not complete within ${options.timeoutMs}ms ` +
            `(last phase: ${phaseName(this.phase)}).`,
        )
      }
    }
    this.throwIfNotSuccessful()
    return this.pb
  }

  /** Throws {@link FlyteRunFailedError} when the action is terminal and unsuccessful. */
  throwIfNotSuccessful(): void {
    const phase = this.phase
    if (!isTerminal(phase) || isSuccess(phase)) return
    const message = this.errorInfo?.message ?? this.abortInfo?.reason
    throw new FlyteRunFailedError(
      `Action "${this.name}" ended in ${phaseName(phase)}${message ? `: ${message}` : '.'}`,
      phaseName(phase),
      message,
    )
  }

  /**
   * Requests termination of this single action; sibling actions keep
   * running. The server rejects aborts of trace actions and other
   * non-abortable states.
   */
  async abort(reason?: string): Promise<void> {
    await this.ctx.services.run.abortAction({
      actionId: this.pb.id,
      reason: reason ?? '',
    })
  }
}

/** Combines abort signals, tolerating undefined entries. */
export function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}
