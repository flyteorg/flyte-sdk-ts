/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Streaming phase updates for actions via `RunService.WatchActionDetails`,
 * with transparent reconnects (idle timeouts, server rollouts) and a polling
 * fallback for transports that reject server streaming.
 */

import { Code, ConnectError } from '@connectrpc/connect'
import { create } from '@bufbuild/protobuf'

import type { ClientContext } from './context'
import { FlyteError } from './errors'
import type { ActionIdentifier } from './gen/flyteidl2/common/identifier_pb'
import type { ActionDetails } from './gen/flyteidl2/workflow/run_definition_pb'
import { WatchActionDetailsRequestSchema } from './gen/flyteidl2/workflow/run_service_pb'
import { ActionPhase, isTerminal } from './phase'

/** A single status update emitted while watching an action. */
export interface WatchUpdate {
  /** Current execution phase. */
  phase: ActionPhase
  /** Full action details carried by this update. */
  details: ActionDetails
  /** Failure message when the action failed. */
  error?: string
}

export interface WatchOptions {
  /** Abort signal to stop watching early. */
  signal?: AbortSignal
  /** Poll interval for the non-streaming fallback. Default 2000. */
  pollIntervalMs?: number
  /**
   * Base delay between reconnect attempts after a stream drop; the nth
   * attempt waits `n` times this. Default 1000.
   */
  reconnectBackoffMs?: number
}

/** Bounds reconnect attempts that make no progress before giving up. */
const MAX_CONSECUTIVE_FAILURES = 5

function toUpdate(details: ActionDetails): WatchUpdate {
  const phase = details.status?.phase ?? ActionPhase.UNSPECIFIED
  const update: WatchUpdate = { phase, details }
  if (phase === ActionPhase.FAILED) {
    update.error =
      (details.result.case === 'errorInfo' ? details.result.value.message : '') ||
      'action failed'
  }
  return update
}

/**
 * Streams status updates for one action until it reaches a terminal phase.
 * Transient stream drops are reconnected transparently with linear backoff;
 * transports that reject server streaming fall back to polling.
 *
 * Every server update is yielded, so a phase can repeat while its sub-state
 * (attempt count, cache status) changes. The polling fallback has no server
 * events to relay and yields only on phase change. Use
 * {@link RunHandle.wait}'s `onPhase` when you want phase changes alone.
 */
export async function* watchActionPhases(
  ctx: ClientContext,
  actionId: ActionIdentifier,
  options: WatchOptions = {},
): AsyncGenerator<WatchUpdate, void> {
  const { signal } = options
  let failures = 0
  let terminal = false

  while (!terminal && !signal?.aborted) {
    try {
      const stream = ctx.services.run.watchActionDetails(
        create(WatchActionDetailsRequestSchema, { actionId }),
        { signal },
      )
      for await (const res of stream) {
        if (!res.details?.status) continue
        failures = 0
        const update = toUpdate(res.details)
        yield update
        if (isTerminal(update.phase)) {
          terminal = true
          break
        }
      }
      if (terminal) return
      // Normal end of stream before a terminal phase: the server closed it
      // (idle timeout, rollout). Treat like a drop and reconnect.
      failures++
    } catch (err) {
      if (signal?.aborted || isCanceled(err)) return
      if (err instanceof ConnectError && err.code === Code.Unimplemented) {
        yield* pollActionPhases(ctx, actionId, options)
        return
      }
      failures++
      if (failures > MAX_CONSECUTIVE_FAILURES) {
        throw new FlyteError(
          `Watching action "${actionId.name}" failed after ${failures} attempts.`,
          { cause: err },
        )
      }
    }
    if (failures > MAX_CONSECUTIVE_FAILURES) {
      throw new FlyteError(
        `Watch stream for action "${actionId.name}" kept closing before the action finished.`,
      )
    }
    await sleep(failures * (options.reconnectBackoffMs ?? 1000), signal)
  }
}

/** Polling fallback with the same yield semantics as the streaming watch. */
async function* pollActionPhases(
  ctx: ClientContext,
  actionId: ActionIdentifier,
  options: WatchOptions,
): AsyncGenerator<WatchUpdate, void> {
  const intervalMs = options.pollIntervalMs ?? 2000
  let lastPhase: ActionPhase | undefined
  while (!options.signal?.aborted) {
    const res = await ctx.services.run.getActionDetails(
      { actionId },
      { signal: options.signal },
    )
    if (res.details?.status) {
      const update = toUpdate(res.details)
      if (update.phase !== lastPhase) {
        lastPhase = update.phase
        yield update
      }
      if (isTerminal(update.phase)) return
    }
    await sleep(intervalMs, options.signal)
  }
}

function isCanceled(err: unknown): boolean {
  return err instanceof ConnectError && err.code === Code.Canceled
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // An abort that already happened fires no event, so check it up front
  // rather than waiting out the full delay.
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms))
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}
