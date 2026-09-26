/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'

import { ActionIdentifierSchema, RunIdentifierSchema } from '../src/gen/flyteidl2/common/identifier_pb'
import {
  ActionDetailsSchema,
  ActionStatusSchema,
  ErrorInfoSchema,
} from '../src/gen/flyteidl2/workflow/run_definition_pb'
import { ActionPhase } from '../src/phase'
import { watchActionPhases } from '../src/watch'
import { fakeContext } from './helpers/fakeContext'

const ACTION_ID = create(ActionIdentifierSchema, {
  run: create(RunIdentifierSchema, {
    org: 'acme',
    project: 'my-project',
    domain: 'development',
    name: 'run-1',
  }),
  name: 'a0',
})

/** An ActionDetails carrying just a phase (and an error message when failed). */
function details(phase: ActionPhase, errorMessage?: string) {
  return create(ActionDetailsSchema, {
    id: ACTION_ID,
    status: create(ActionStatusSchema, { phase }),
    ...(errorMessage
      ? { result: { case: 'errorInfo' as const, value: create(ErrorInfoSchema, { message: errorMessage }) } }
      : {}),
  })
}

/** A server-streaming response that yields the given phases then ends. */
async function* streamOf(...phases: (ActionPhase | { phase: ActionPhase; error: string })[]) {
  for (const p of phases) {
    const [phase, error] = typeof p === 'object' ? [p.phase, p.error] : [p, undefined]
    yield { details: details(phase, error) }
  }
}

describe('watchActionPhases', () => {
  it('yields each phase update and stops at a terminal phase', async () => {
    const watchActionDetails = vi.fn(() =>
      streamOf(ActionPhase.QUEUED, ActionPhase.RUNNING, ActionPhase.SUCCEEDED),
    )
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID)) updates.push(u)

    expect(updates.map((u) => u.phase)).toEqual([
      ActionPhase.QUEUED,
      ActionPhase.RUNNING,
      ActionPhase.SUCCEEDED,
    ])
    expect(watchActionDetails).toHaveBeenCalledTimes(1)
  })

  it('stops at RECOVERED, which is terminal', async () => {
    const watchActionDetails = vi.fn(() => streamOf(ActionPhase.RECOVERED, ActionPhase.RUNNING))
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID)) updates.push(u)

    expect(updates.map((u) => u.phase)).toEqual([ActionPhase.RECOVERED])
  })

  it('surfaces the failure message on a FAILED update', async () => {
    const watchActionDetails = vi.fn(() =>
      streamOf({ phase: ActionPhase.FAILED, error: 'boom' }),
    )
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID)) updates.push(u)

    expect(updates[0]?.error).toBe('boom')
  })

  it('defaults the failure message when the server sends none', async () => {
    const watchActionDetails = vi.fn(() => streamOf(ActionPhase.FAILED))
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID)) updates.push(u)

    expect(updates[0]?.error).toBe('action failed')
  })

  it('skips messages with no status', async () => {
    const watchActionDetails = vi.fn(async function* () {
      yield { details: create(ActionDetailsSchema, { id: ACTION_ID }) }
      yield { details: details(ActionPhase.SUCCEEDED) }
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID)) updates.push(u)

    expect(updates.map((u) => u.phase)).toEqual([ActionPhase.SUCCEEDED])
  })

  it('reconnects when the stream closes before a terminal phase', async () => {
    // The server closes the stream mid-run (idle timeout, rollout); the watch
    // reconnects and picks up where it left off.
    const watchActionDetails = vi
      .fn()
      .mockImplementationOnce(() => streamOf(ActionPhase.QUEUED))
      .mockImplementationOnce(() => streamOf(ActionPhase.RUNNING, ActionPhase.SUCCEEDED))
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID, { reconnectBackoffMs: 1 })) {
      updates.push(u)
    }

    expect(watchActionDetails).toHaveBeenCalledTimes(2)
    expect(updates.map((u) => u.phase)).toEqual([
      ActionPhase.QUEUED,
      ActionPhase.RUNNING,
      ActionPhase.SUCCEEDED,
    ])
  })

  it('reconnects after a transport error', async () => {
    const watchActionDetails = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new ConnectError('connection reset', Code.Unavailable)
      })
      .mockImplementationOnce(() => streamOf(ActionPhase.SUCCEEDED))
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID, { reconnectBackoffMs: 1 })) {
      updates.push(u)
    }

    expect(updates.map((u) => u.phase)).toEqual([ActionPhase.SUCCEEDED])
  })

  it('gives up after too many consecutive failures', async () => {
    const watchActionDetails = vi.fn(() => {
      throw new ConnectError('always down', Code.Unavailable)
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const drain = async () => {
      for await (const _ of watchActionPhases(ctx, ACTION_ID, { reconnectBackoffMs: 1 })) {
        // drain
      }
    }
    await expect(drain()).rejects.toThrow(/failed after 6 attempts/)
    expect(watchActionDetails).toHaveBeenCalledTimes(6)
  })

  it('returns quietly when the watch is canceled', async () => {
    const watchActionDetails = vi.fn(() => {
      throw new ConnectError('canceled', Code.Canceled)
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID)) updates.push(u)

    expect(updates).toEqual([])
  })

  it('stops watching when the abort signal fires', async () => {
    const controller = new AbortController()
    const watchActionDetails = vi.fn(async function* () {
      yield { details: details(ActionPhase.RUNNING) }
      controller.abort()
      yield { details: details(ActionPhase.RUNNING) }
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID, { signal: controller.signal })) {
      updates.push(u)
    }

    // The in-flight stream drains, but no reconnect is attempted.
    expect(watchActionDetails).toHaveBeenCalledTimes(1)
    expect(updates.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to polling when streaming is unimplemented', async () => {
    const watchActionDetails = vi.fn(() => {
      throw new ConnectError('no streaming here', Code.Unimplemented)
    })
    const phases = [ActionPhase.QUEUED, ActionPhase.RUNNING, ActionPhase.SUCCEEDED]
    let call = 0
    const getActionDetails = vi.fn(async () => ({
      details: details(phases[Math.min(call++, phases.length - 1)]!),
    }))
    const { ctx } = fakeContext({
      services: { run: { watchActionDetails, getActionDetails } as never },
    })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID, { pollIntervalMs: 1 })) {
      updates.push(u)
    }

    expect(updates.map((u) => u.phase)).toEqual(phases)
  })

  it('does not re-yield an unchanged phase while polling', async () => {
    const watchActionDetails = vi.fn(() => {
      throw new ConnectError('no streaming here', Code.Unimplemented)
    })
    const phases = [
      ActionPhase.RUNNING,
      ActionPhase.RUNNING,
      ActionPhase.RUNNING,
      ActionPhase.SUCCEEDED,
    ]
    let call = 0
    const getActionDetails = vi.fn(async () => ({
      details: details(phases[Math.min(call++, phases.length - 1)]!),
    }))
    const { ctx } = fakeContext({
      services: { run: { watchActionDetails, getActionDetails } as never },
    })

    const updates = []
    for await (const u of watchActionPhases(ctx, ACTION_ID, { pollIntervalMs: 1 })) {
      updates.push(u)
    }

    expect(updates.map((u) => u.phase)).toEqual([ActionPhase.RUNNING, ActionPhase.SUCCEEDED])
  })
})
