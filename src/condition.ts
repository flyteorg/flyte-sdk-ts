/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Condition actions: pause points created by a task (via
 * `flyte.new_condition(...)` in the Python SDK) that wait for an external
 * signal — the building block for human-in-the-loop approvals.
 */

import { create } from '@bufbuild/protobuf'

import { ActionHandle } from './action'
import { FlyteError } from './errors'
import { SimpleType } from './gen/flyteidl2/core/types_pb'
import type { ConditionAction } from './gen/flyteidl2/workflow/run_definition_pb'
import type { EventPayload } from './gen/flyteidl2/workflow/run_service_pb'
import {
  EventPayloadSchema,
  SignalEventRequestSchema,
} from './gen/flyteidl2/workflow/run_service_pb'

/** Value types a condition can be signalled with. */
export type SignalValue = boolean | string | number | bigint

export class ConditionHandle extends ActionHandle {
  /** The condition spec (prompt, expected type, timeout). Populated on full details. */
  get condition(): ConditionAction | undefined {
    return this.details.spec.case === 'condition' ? this.details.spec.value : undefined
  }

  /** Prompt shown to the user when the condition is awaited. */
  get prompt(): string {
    return this.condition?.prompt ?? ''
  }

  /** The condition's description. */
  get description(): string {
    return this.condition?.description ?? ''
  }

  /**
   * Delivers the value the condition is waiting for, resuming the paused
   * task. The payload type is chosen from the condition's declared type when
   * known (so `signal(1)` on a float condition sends a float); the server
   * validates the value and rejects mismatches and double signals.
   */
  async signal(value: SignalValue): Promise<void> {
    await this.ctx.services.run.signalEvent(
      create(SignalEventRequestSchema, {
        actionId: this.details.id,
        parentActionName: this.parent,
        payload: this.eventPayload(value),
      }),
    )
  }

  private eventPayload(value: SignalValue): EventPayload {
    const declared =
      this.condition?.type?.type.case === 'simple'
        ? this.condition.type.type.value
        : undefined

    let payload: EventPayload['value']
    switch (typeof value) {
      case 'boolean':
        payload = { case: 'boolValue', value }
        break
      case 'string':
        payload = { case: 'stringValue', value }
        break
      case 'bigint':
        payload = { case: 'intValue', value }
        break
      case 'number':
        if (declared === SimpleType.FLOAT) {
          payload = { case: 'floatValue', value }
        } else if (declared === SimpleType.INTEGER) {
          // Truncating here would silently record a value the caller never
          // sent, on what is typically a human approval.
          if (!Number.isInteger(value)) {
            throw new FlyteError(
              `Condition "${this.name}" expects an integer, but ${value} is fractional.`,
            )
          }
          payload = { case: 'intValue', value: BigInt(value) }
        } else if (Number.isInteger(value)) {
          payload = { case: 'intValue', value: BigInt(value) }
        } else {
          payload = { case: 'floatValue', value }
        }
        break
      default:
        throw new FlyteError(
          `Unsupported signal value type (want boolean, string, number, or bigint).`,
        )
    }
    return create(EventPayloadSchema, { value: payload })
  }
}
