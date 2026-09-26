/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * A handle to a single run: inspect status, stream progress, wait for
 * completion, fetch typed outputs, and drill into individual actions.
 */

import { create } from '@bufbuild/protobuf'
import { Code } from '@connectrpc/connect'

import { ActionHandle, combineSignals } from './action'
import { ConditionHandle } from './condition'
import type { ClientContext } from './context'
import {
  FlyteError,
  FlyteNotFoundError,
  FlyteTimeoutError,
  isConnectCode,
} from './errors'
import type { ActionIdentifier, RunIdentifier } from './gen/flyteidl2/common/identifier_pb'
import { ActionIdentifierSchema } from './gen/flyteidl2/common/identifier_pb'
import {
  SelectClusterRequest_Operation,
  SelectClusterRequestSchema,
} from './gen/flyteidl2/cluster/payload_pb'
import type { TypedInterface } from './gen/flyteidl2/core/interface_pb'
import type { Inputs, Outputs } from './gen/flyteidl2/task/common_pb'
import type {
  ActionDetails,
  RunDetails,
} from './gen/flyteidl2/workflow/run_definition_pb'
import {
  ActionDetailsSchema,
  ActionType,
} from './gen/flyteidl2/workflow/run_definition_pb'
import { ListActionsRequestSchema } from './gen/flyteidl2/workflow/run_service_pb'
import { literalsToValues } from './io'
import { ActionPhase, isSuccess, isTerminal, phaseName } from './phase'
import type { WatchOptions, WatchUpdate } from './watch'
import { watchActionPhases } from './watch'

export interface WaitOptions {
  /**
   * Poll interval in milliseconds, used when the transport does not support
   * streaming. Default 2000.
   */
  intervalMs?: number
  /** Give up after this many milliseconds. Default: no timeout. */
  timeoutMs?: number
  /** Optional callback invoked on every phase change. */
  onPhase?: (phase: ActionPhase) => void
  /** Abort signal to stop waiting. */
  signal?: AbortSignal
  /**
   * Throw {@link FlyteRunFailedError} when the run ends in FAILED, ABORTED,
   * or TIMED_OUT. Defaults to `true` (matching the Go SDK's `Wait`); pass
   * `false` to inspect the terminal details yourself.
   */
  throwOnFailure?: boolean
}

/** The run's raw wire-format inputs and outputs. */
export interface RawRunData {
  inputs?: Inputs
  outputs?: Outputs
}

export class RunHandle {
  constructor(
    private readonly ctx: ClientContext,
    /** Identifier of the run. */
    readonly runId: RunIdentifier,
    /** Identifier of the run's root action. */
    readonly actionId: ActionIdentifier,
    /** Typed interface of the launched task, when known at construction. */
    private taskInterface?: TypedInterface,
    private lastDetails?: ActionDetails,
  ) {}

  get name(): string {
    return this.runId.name
  }
  get project(): string {
    return this.runId.project
  }
  get domain(): string {
    return this.runId.domain
  }
  get org(): string {
    return this.runId.org
  }

  /** Best-effort console URL for this run. */
  get url(): string {
    const { endpoint } = this.ctx.config
    return `${endpoint}/v2/domain/${this.domain}/project/${this.project}/runs/${this.name}`
  }

  /** Fetches full run details from the control plane. */
  async details(): Promise<RunDetails> {
    const res = await this.ctx.services.run.getRunDetails({ runId: this.runId })
    if (!res.details) {
      throw new FlyteError(`Run ${this.name} returned no details.`)
    }
    if (res.details.action) {
      this.rememberDetails(res.details.action)
    }
    return res.details
  }

  /**
   * The last phase this handle observed, without contacting the server.
   * `UNSPECIFIED` until the first `details()`, `wait()`, or `watch()` — use
   * {@link phase} to fetch it.
   */
  get lastPhase(): ActionPhase {
    return this.lastDetails?.status?.phase ?? ActionPhase.UNSPECIFIED
  }

  /** Fetches the current phase of the run's root action. */
  async phase(): Promise<ActionPhase> {
    const details = await this.details()
    return details.action?.status?.phase ?? ActionPhase.UNSPECIFIED
  }

  /**
   * Streams status updates until the run reaches a terminal phase.
   * Transient stream drops are reconnected transparently; abort the signal
   * to stop watching early.
   *
   * Every server update is yielded, so the same phase can appear more than
   * once as its sub-state changes. Use {@link wait}'s `onPhase` callback when
   * you only care about phase transitions.
   */
  async *watch(options: WatchOptions = {}): AsyncGenerator<WatchUpdate, void> {
    for await (const update of watchActionPhases(this.ctx, this.actionId, options)) {
      this.rememberDetails(update.details)
      yield update
    }
  }

  /**
   * Waits until the run reaches a terminal phase and returns the final run
   * details. Throws {@link FlyteRunFailedError} when the run did not succeed
   * unless `throwOnFailure: false` is passed (RECOVERED counts as success).
   */
  async wait(options: WaitOptions = {}): Promise<RunDetails> {
    const timeoutSignal =
      options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined
    const signal = combineSignals(options.signal, timeoutSignal)

    let lastPhase: ActionPhase | undefined
    let last: ActionDetails | undefined
    for await (const update of this.watch({
      signal,
      pollIntervalMs: options.intervalMs,
    })) {
      last = update.details
      if (update.phase !== lastPhase) {
        lastPhase = update.phase
        options.onPhase?.(update.phase)
      }
    }

    const phase = last?.status?.phase ?? ActionPhase.UNSPECIFIED
    if (!isTerminal(phase)) {
      if (timeoutSignal?.aborted) {
        throw new FlyteTimeoutError(
          `Run ${this.name} did not complete within ${options.timeoutMs}ms ` +
            `(last phase: ${phaseName(phase)}).`,
        )
      }
      if (options.signal?.aborted) {
        throw new FlyteError(`Waiting for run ${this.name} was aborted.`)
      }
      throw new FlyteError(`Watch stream for run ${this.name} ended without updates.`)
    }

    if (options.throwOnFailure !== false && !isSuccess(phase)) {
      this.rootAction().throwIfNotSuccessful()
    }
    return this.details()
  }

  /**
   * Fetches the run's typed outputs as plain JavaScript values keyed by
   * output name (e.g. `o0`). Waits for completion first when the run is
   * still in progress, and throws {@link FlyteRunFailedError} when it did
   * not succeed.
   */
  async outputs(options: WaitOptions = {}): Promise<Record<string, unknown>> {
    const phase = this.lastDetails?.status?.phase
    if (phase === undefined || !isTerminal(phase)) {
      await this.wait(options)
    }
    if (!this.lastDetails) {
      // Never fetch data for a run whose outcome was not observed.
      await this.details()
    }
    this.rootAction().throwIfNotSuccessful()

    const raw = await this.rawData()
    const literals = raw.outputs?.literals ?? []
    const iface = await this.resolveTaskInterface()
    return literalsToValues(this.ctx, literals, iface?.outputs)
  }

  /**
   * Fetches the run's raw wire-format inputs and outputs. Prefers the
   * dataplane's DataProxy (resolved via `SelectCluster`), and falls back to
   * the run service for cache-hit/recovered actions that never executed and
   * for older control planes.
   */
  async rawData(): Promise<RawRunData> {
    try {
      const selectRes = await this.ctx.services.cluster.selectCluster(
        create(SelectClusterRequestSchema, {
          resource: { case: 'actionId', value: this.actionId },
          operation: SelectClusterRequest_Operation.GET_ACTION_DATA,
        }),
      )
      if (selectRes.clusterEndpoint) {
        const dataproxy = this.ctx.dataproxyForCluster(selectRes.clusterEndpoint)
        const res = await dataproxy.getActionData({ actionId: this.actionId })
        return { inputs: res.inputs, outputs: res.outputs }
      }
    } catch (err) {
      if (!isConnectCode(err, Code.NotFound) && !isConnectCode(err, Code.Unimplemented)) {
        throw err
      }
      // Cache-hit and recovered actions never executed, so the data proxy
      // has no per-attempt records; their outputs are served from the
      // action's stored outputs URI by the run service instead.
    }
    const legacy = await this.ctx.services.run.getActionData({ actionId: this.actionId })
    return { inputs: legacy.inputs, outputs: legacy.outputs }
  }

  /** Aborts the run. The reason is recorded on the run. */
  async abort(reason?: string): Promise<void> {
    try {
      await this.ctx.services.run.abortRun({ runId: this.runId, reason })
    } catch (err) {
      if (isConnectCode(err, Code.NotFound)) return
      throw err
    }
  }

  /**
   * Lists all actions of the run, paginating through the full list. The
   * results are lightweight; call {@link action} or `ActionHandle.refresh`
   * for full details on a specific action.
   */
  async listActions(): Promise<ActionHandle[]> {
    const actions: ActionHandle[] = []
    const seenTokens = new Set<string>()
    let token = ''
    for (;;) {
      const res = await this.ctx.services.run.listActions(
        create(ListActionsRequestSchema, {
          runId: this.runId,
          request: { limit: 100, token },
        }),
      )
      for (const a of res.actions) {
        actions.push(
          new ActionHandle(
            this.ctx,
            create(ActionDetailsSchema, {
              id: a.id,
              metadata: a.metadata,
              status: a.status,
            }),
          ),
        )
      }
      token = res.token
      // A server that echoes the same token would otherwise loop forever,
      // accumulating duplicates.
      if (!token || seenTokens.has(token)) return actions
      seenTokens.add(token)
    }
  }

  /** Fetches one action of the run by name, with full details. */
  async action(name: string): Promise<ActionHandle> {
    return this.fetchAction(name, (details) => new ActionHandle(this.ctx, details))
  }

  /** Returns the run's condition actions with full details. */
  async listConditions(): Promise<ConditionHandle[]> {
    const actions = await this.listActions()
    const conditions: ConditionHandle[] = []
    for (const a of actions) {
      if (a.actionType !== ActionType.CONDITION) continue
      // Re-fetch for full details: the condition spec and signal info are
      // not part of the listing.
      conditions.push(await this.condition(a.name))
    }
    return conditions
  }

  /** Fetches one condition action of the run by name. */
  async condition(name: string): Promise<ConditionHandle> {
    const handle = await this.fetchAction(
      name,
      (details) => new ConditionHandle(this.ctx, details),
    )
    if (handle.actionType !== ActionType.CONDITION) {
      throw new FlyteError(
        `Action "${name}" of run ${this.name} is not a condition.`,
      )
    }
    return handle
  }

  private async fetchAction<T>(
    name: string,
    build: (details: ActionDetails) => T,
  ): Promise<T> {
    try {
      const res = await this.ctx.services.run.getActionDetails({
        actionId: create(ActionIdentifierSchema, { run: this.runId, name }),
      })
      if (!res.details) {
        throw new FlyteNotFoundError(`Action "${name}" of run ${this.name} not found.`)
      }
      return build(res.details)
    } catch (err) {
      if (isConnectCode(err, Code.NotFound)) {
        throw new FlyteNotFoundError(`Action "${name}" of run ${this.name} not found.`, {
          cause: err,
        })
      }
      throw err
    }
  }

  private rememberDetails(details: ActionDetails): void {
    this.lastDetails = details
    if (!this.taskInterface && details.spec.case === 'task') {
      this.taskInterface = details.spec.value.taskTemplate?.interface
    }
  }

  private rootAction(): ActionHandle {
    return new ActionHandle(this.ctx, this.lastDetails ?? create(ActionDetailsSchema, {}))
  }

  private async resolveTaskInterface(): Promise<TypedInterface | undefined> {
    if (!this.taskInterface) {
      await this.details()
    }
    return this.taskInterface
  }
}
