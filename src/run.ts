/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** A handle to a single run: inspect status, wait for completion, fetch outputs. */

import { create } from '@bufbuild/protobuf'

import type { ClientContext } from './context'
import { FlyteError, FlyteTimeoutError } from './errors'
import type { ActionIdentifier, RunIdentifier } from './gen/flyteidl2/common/identifier_pb'
import {
  SelectClusterRequest_Operation,
  SelectClusterRequestSchema,
} from './gen/flyteidl2/cluster/payload_pb'
import type { GetActionDataResponse } from './gen/flyteidl2/dataproxy/dataproxy_service_pb'
import type { RunDetails } from './gen/flyteidl2/workflow/run_definition_pb'
import { ActionPhase, isTerminal, phaseName } from './phase'

export interface WaitOptions {
  /** Poll interval in milliseconds. Default 2000. */
  intervalMs?: number
  /** Give up after this many milliseconds. Default: no timeout. */
  timeoutMs?: number
  /** Optional callback invoked on every phase change. */
  onPhase?: (phase: ActionPhase) => void
  /** Abort signal to stop waiting. */
  signal?: AbortSignal
}

export class RunHandle {
  constructor(
    private readonly ctx: ClientContext,
    /** Identifier of the run. */
    readonly runId: RunIdentifier,
    /** Identifier of the run's root action. */
    readonly actionId: ActionIdentifier,
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
    return res.details
  }

  /** Returns the current phase of the run's root action. */
  async phase(): Promise<ActionPhase> {
    const details = await this.details()
    return details.action?.status?.phase ?? ActionPhase.UNSPECIFIED
  }

  /**
   * Polls until the run reaches a terminal phase (or the timeout elapses) and
   * returns the final run details.
   */
  async wait(options: WaitOptions = {}): Promise<RunDetails> {
    const intervalMs = options.intervalMs ?? 2000
    const deadline =
      options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined
    let lastPhase: ActionPhase | undefined

    for (;;) {
      if (options.signal?.aborted) {
        throw new FlyteError(`Waiting for run ${this.name} was aborted.`)
      }
      const details = await this.details()
      const phase = details.action?.status?.phase ?? ActionPhase.UNSPECIFIED
      if (phase !== lastPhase) {
        lastPhase = phase
        options.onPhase?.(phase)
      }
      if (isTerminal(phase)) {
        return details
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new FlyteTimeoutError(
          `Run ${this.name} did not complete within ${options.timeoutMs}ms (last phase: ${phaseName(phase)}).`,
        )
      }
      await sleep(Math.min(intervalMs, deadline ? deadline - Date.now() : intervalMs))
    }
  }

  /**
   * Fetches the run's inputs and outputs. Resolves the dataplane cluster via
   * `SelectCluster`, then reads action data from that cluster's DataProxy.
   */
  async outputs(): Promise<GetActionDataResponse> {
    const selectRes = await this.ctx.services.cluster.selectCluster(
      create(SelectClusterRequestSchema, {
        resource: { case: 'actionId', value: this.actionId },
        operation: SelectClusterRequest_Operation.GET_ACTION_DATA,
      }),
    )
    if (!selectRes.clusterEndpoint) {
      throw new FlyteError('SelectCluster did not return a cluster endpoint.')
    }
    const dataproxy = this.ctx.dataproxyForCluster(selectRes.clusterEndpoint)
    return dataproxy.getActionData({ actionId: this.actionId })
  }

  /** Aborts the run. */
  async abort(reason?: string): Promise<void> {
    await this.ctx.services.run.abortRun({ runId: this.runId, reason })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
