/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { ActionHandle, ActionType } from '../src/action'
import { ConditionHandle } from '../src/condition'
import { FlyteRunFailedError, FlyteTimeoutError } from '../src/errors'
import {
  ActionIdentifierSchema,
  RunIdentifierSchema,
} from '../src/gen/flyteidl2/common/identifier_pb'
import { SimpleType } from '../src/gen/flyteidl2/core/types_pb'
import {
  AbortInfoSchema,
  ActionDetailsSchema,
  ActionMetadataSchema,
  ActionStatusSchema,
  ConditionActionSchema,
  ErrorInfoSchema,
  SignalInfoSchema,
} from '../src/gen/flyteidl2/workflow/run_definition_pb'
import { ActionPhase } from '../src/phase'
import { callArg, fakeContext, intLiteral, simpleType } from './helpers/fakeContext'

const RUN_ID = create(RunIdentifierSchema, {
  org: 'acme',
  project: 'my-project',
  domain: 'development',
  name: 'run-1',
})

function actionId(name = 'a0') {
  return create(ActionIdentifierSchema, { run: RUN_ID, name })
}

function actionDetails(overrides: Parameters<typeof create<typeof ActionDetailsSchema>>[1] = {}) {
  return create(ActionDetailsSchema, { id: actionId(), ...overrides })
}

async function* streamOf(...phases: ActionPhase[]) {
  for (const phase of phases) {
    yield {
      details: actionDetails({ status: create(ActionStatusSchema, { phase }) }),
    }
  }
}

describe('ActionHandle accessors', () => {
  it('exposes identity, metadata, and status', () => {
    const { ctx } = fakeContext()
    const handle = new ActionHandle(
      ctx,
      create(ActionDetailsSchema, {
        id: actionId('a3'),
        metadata: create(ActionMetadataSchema, {
          parent: 'a0',
          actionType: ActionType.TASK,
          recoveredFrom: actionId('a3-old'),
        }),
        status: create(ActionStatusSchema, { phase: ActionPhase.RUNNING, attempts: 2 }),
      }),
    )
    expect(handle.name).toBe('a3')
    expect(handle.runName).toBe('run-1')
    expect(handle.parent).toBe('a0')
    expect(handle.actionType).toBe(ActionType.TASK)
    expect(handle.phase).toBe(ActionPhase.RUNNING)
    expect(handle.attempts).toBe(2)
    expect(handle.recoveredFrom?.name).toBe('a3-old')
  })

  it('defaults cleanly when metadata and status are absent', () => {
    const { ctx } = fakeContext()
    const handle = new ActionHandle(ctx, create(ActionDetailsSchema, {}))
    expect(handle.name).toBe('')
    expect(handle.runName).toBe('')
    expect(handle.parent).toBe('')
    expect(handle.phase).toBe(ActionPhase.UNSPECIFIED)
    expect(handle.attempts).toBe(0)
    expect(handle.errorInfo).toBeUndefined()
    expect(handle.abortInfo).toBeUndefined()
    expect(handle.signalInfo).toBeUndefined()
  })

  it('exposes exactly one of error, abort, and signal info', () => {
    const { ctx } = fakeContext()
    const failed = new ActionHandle(
      ctx,
      actionDetails({
        result: { case: 'errorInfo', value: create(ErrorInfoSchema, { message: 'boom' }) },
      }),
    )
    expect(failed.errorInfo?.message).toBe('boom')
    expect(failed.abortInfo).toBeUndefined()

    const aborted = new ActionHandle(
      ctx,
      actionDetails({
        result: { case: 'abortInfo', value: create(AbortInfoSchema, { reason: 'user asked' }) },
      }),
    )
    expect(aborted.abortInfo?.reason).toBe('user asked')
    expect(aborted.errorInfo).toBeUndefined()

    const signalled = new ActionHandle(
      ctx,
      actionDetails({
        result: {
          case: 'signalInfo',
          value: create(SignalInfoSchema, { output: intLiteral(1) }),
        },
      }),
    )
    expect(signalled.signalInfo?.output).toEqual(intLiteral(1))
    expect(signalled.errorInfo).toBeUndefined()
  })
})

describe('ActionHandle.refresh', () => {
  it('replaces the handle state in place', async () => {
    const getActionDetails = vi.fn(async () => ({
      details: actionDetails({
        status: create(ActionStatusSchema, { phase: ActionPhase.SUCCEEDED }),
      }),
    }))
    const { ctx } = fakeContext({ services: { run: { getActionDetails } as never } })
    const handle = new ActionHandle(
      ctx,
      actionDetails({ status: create(ActionStatusSchema, { phase: ActionPhase.RUNNING }) }),
    )

    await handle.refresh()

    expect(handle.phase).toBe(ActionPhase.SUCCEEDED)
    expect(getActionDetails).toHaveBeenCalledWith({ actionId: handle.id })
  })

  it('keeps the existing state when the server returns no details', async () => {
    const getActionDetails = vi.fn(async () => ({ details: undefined }))
    const { ctx } = fakeContext({ services: { run: { getActionDetails } as never } })
    const handle = new ActionHandle(
      ctx,
      actionDetails({ status: create(ActionStatusSchema, { phase: ActionPhase.RUNNING }) }),
    )

    await handle.refresh()

    expect(handle.phase).toBe(ActionPhase.RUNNING)
  })
})

describe('ActionHandle.wait', () => {
  it('watches to a terminal phase, reporting each phase change once', async () => {
    const watchActionDetails = vi.fn(() =>
      streamOf(ActionPhase.QUEUED, ActionPhase.RUNNING, ActionPhase.RUNNING, ActionPhase.SUCCEEDED),
    )
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })
    const handle = new ActionHandle(ctx, actionDetails())
    const seen: ActionPhase[] = []

    await handle.wait({ onPhase: (p) => seen.push(p) })

    expect(seen).toEqual([ActionPhase.QUEUED, ActionPhase.RUNNING, ActionPhase.SUCCEEDED])
    expect(handle.phase).toBe(ActionPhase.SUCCEEDED)
  })

  it('does not watch an action that is already terminal', async () => {
    const watchActionDetails = vi.fn()
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })
    const handle = new ActionHandle(
      ctx,
      actionDetails({ status: create(ActionStatusSchema, { phase: ActionPhase.SUCCEEDED }) }),
    )

    await handle.wait()

    expect(watchActionDetails).not.toHaveBeenCalled()
  })

  it('throws with the failure message when the action failed', async () => {
    const watchActionDetails = vi.fn(async function* () {
      yield {
        details: actionDetails({
          status: create(ActionStatusSchema, { phase: ActionPhase.FAILED }),
          result: {
            case: 'errorInfo' as const,
            value: create(ErrorInfoSchema, { message: 'task raised ValueError' }),
          },
        }),
      }
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })
    const handle = new ActionHandle(ctx, actionDetails())

    await expect(handle.wait()).rejects.toThrow(
      /Action "a0" ended in FAILED: task raised ValueError/,
    )
    await expect(handle.wait()).rejects.toBeInstanceOf(FlyteRunFailedError)
  })

  it('reports the abort reason when the action was aborted', async () => {
    const { ctx } = fakeContext()
    const handle = new ActionHandle(
      ctx,
      actionDetails({
        status: create(ActionStatusSchema, { phase: ActionPhase.ABORTED }),
        result: { case: 'abortInfo', value: create(AbortInfoSchema, { reason: 'user asked' }) },
      }),
    )

    await expect(handle.wait()).rejects.toThrow(/ended in ABORTED: user asked/)
  })

  it('accepts RECOVERED as success', async () => {
    const { ctx } = fakeContext()
    const handle = new ActionHandle(
      ctx,
      actionDetails({ status: create(ActionStatusSchema, { phase: ActionPhase.RECOVERED }) }),
    )

    await expect(handle.wait()).resolves.toBeDefined()
  })

  it('times out when the action never reaches a terminal phase', async () => {
    // A stream that stays open with a non-terminal phase until aborted.
    const watchActionDetails = vi.fn(async function* (
      _req: unknown,
      opts?: { signal?: AbortSignal },
    ) {
      yield {
        details: actionDetails({
          status: create(ActionStatusSchema, { phase: ActionPhase.RUNNING }),
        }),
      }
      await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve()))
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })
    const handle = new ActionHandle(ctx, actionDetails())

    await expect(handle.wait({ timeoutMs: 50 })).rejects.toBeInstanceOf(FlyteTimeoutError)
  })
})

describe('ActionHandle.abort', () => {
  it('sends the action id and reason', async () => {
    const abortAction = vi.fn(async () => ({}))
    const { ctx } = fakeContext({ services: { run: { abortAction } as never } })
    const handle = new ActionHandle(ctx, actionDetails())

    await handle.abort('no longer needed')

    expect(abortAction).toHaveBeenCalledWith({
      actionId: handle.id,
      reason: 'no longer needed',
    })
  })

  it('sends an empty reason when none is given', async () => {
    const abortAction = vi.fn(async () => ({}))
    const { ctx } = fakeContext({ services: { run: { abortAction } as never } })

    await new ActionHandle(ctx, actionDetails()).abort()

    expect(abortAction).toHaveBeenCalledWith({ actionId: actionId(), reason: '' })
  })
})

describe('ConditionHandle', () => {
  function conditionHandle(type = simpleType(SimpleType.BOOLEAN), parent = 'a0') {
    const signalEvent = vi.fn(async () => ({}))
    const { ctx } = fakeContext({ services: { run: { signalEvent } as never } })
    const handle = new ConditionHandle(
      ctx,
      create(ActionDetailsSchema, {
        id: actionId('a1'),
        metadata: create(ActionMetadataSchema, {
          parent,
          actionType: ActionType.CONDITION,
        }),
        status: create(ActionStatusSchema, { phase: ActionPhase.PAUSED }),
        spec: {
          case: 'condition',
          value: create(ConditionActionSchema, {
            name: 'approve',
            prompt: 'Ship it?',
            description: 'Approve the deploy',
            type,
          }),
        },
      }),
    )
    return { handle, signalEvent }
  }

  it('exposes the condition spec', () => {
    const { handle } = conditionHandle()
    expect(handle.prompt).toBe('Ship it?')
    expect(handle.description).toBe('Approve the deploy')
    expect(handle.actionType).toBe(ActionType.CONDITION)
  })

  it('returns empty strings when the spec is not loaded', () => {
    const { ctx } = fakeContext()
    const handle = new ConditionHandle(ctx, create(ActionDetailsSchema, {}))
    expect(handle.condition).toBeUndefined()
    expect(handle.prompt).toBe('')
    expect(handle.description).toBe('')
  })

  it('signals a boolean, carrying the parent action name', async () => {
    const { handle, signalEvent } = conditionHandle()

    await handle.signal(true)

    expect(signalEvent).toHaveBeenCalledTimes(1)
    const req = callArg<{
      parentActionName: string
      payload: { value: { case: string; value: unknown } }
    }>(signalEvent)
    expect(req.parentActionName).toBe('a0')
    expect(req.payload.value).toEqual({ case: 'boolValue', value: true })
  })

  it('signals a string', async () => {
    const { handle, signalEvent } = conditionHandle(simpleType(SimpleType.STRING))
    await handle.signal('ship')
    expect(payloadOf(signalEvent)).toEqual({ case: 'stringValue', value: 'ship' })
  })

  it('sends a whole number as an int by default', async () => {
    const { handle, signalEvent } = conditionHandle(simpleType(SimpleType.INTEGER))
    await handle.signal(5)
    expect(payloadOf(signalEvent)).toEqual({ case: 'intValue', value: 5n })
  })

  it('sends a whole number as a float when the condition declares FLOAT', async () => {
    // 1 on a float condition must not be narrowed to an int, or the server
    // rejects the signal as a type mismatch.
    const { handle, signalEvent } = conditionHandle(simpleType(SimpleType.FLOAT))
    await handle.signal(1)
    expect(payloadOf(signalEvent)).toEqual({ case: 'floatValue', value: 1 })
  })

  it('sends a fractional number as a float even without a declared type', async () => {
    const { handle, signalEvent } = conditionHandle(simpleType(SimpleType.NONE))
    await handle.signal(1.5)
    expect(payloadOf(signalEvent)).toEqual({ case: 'floatValue', value: 1.5 })
  })

  it('refuses a fractional value on an integer condition', async () => {
    // Truncating would record a value the caller never sent on what is
    // typically a human approval.
    const { handle, signalEvent } = conditionHandle(simpleType(SimpleType.INTEGER))
    await expect(handle.signal(1.7)).rejects.toThrow(
      /expects an integer, but 1.7 is fractional/,
    )
    expect(signalEvent).not.toHaveBeenCalled()
  })

  it('sends a bigint as an int', async () => {
    const { handle, signalEvent } = conditionHandle(simpleType(SimpleType.INTEGER))
    await handle.signal(9007199254740993n)
    expect(payloadOf(signalEvent)).toEqual({ case: 'intValue', value: 9007199254740993n })
  })
})

function payloadOf(signalEvent: { mock: { calls: unknown[][] } }): unknown {
  return callArg<{ payload: { value: { case: string; value: unknown } } }>(signalEvent)
    .payload.value
}
