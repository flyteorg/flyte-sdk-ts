/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'

import { ActionType } from '../src/action'
import { FlyteError, FlyteNotFoundError, FlyteRunFailedError } from '../src/errors'
import {
  ActionIdentifierSchema,
  RunIdentifierSchema,
} from '../src/gen/flyteidl2/common/identifier_pb'
import { SimpleType } from '../src/gen/flyteidl2/core/types_pb'
import { SelectClusterResponseSchema } from '../src/gen/flyteidl2/cluster/payload_pb'
import { OutputsSchema } from '../src/gen/flyteidl2/task/common_pb'
import { TaskSpecSchema } from '../src/gen/flyteidl2/task/task_definition_pb'
import { TaskTemplateSchema } from '../src/gen/flyteidl2/core/tasks_pb'
import {
  ActionDetailsSchema,
  ActionMetadataSchema,
  ActionSchema,
  ActionStatusSchema,
  ErrorInfoSchema,
  RunDetailsSchema,
} from '../src/gen/flyteidl2/workflow/run_definition_pb'
import { ActionPhase } from '../src/phase'
import { RunHandle } from '../src/run'
import {
  callArg,
  fakeContext,
  intLiteral,
  namedLiteral,
  simpleType,
  typedInterface,
  variable,
  variableMap,
} from './helpers/fakeContext'

const RUN_ID = create(RunIdentifierSchema, {
  org: 'acme',
  project: 'my-project',
  domain: 'development',
  name: 'run-1',
})
const ACTION_ID = create(ActionIdentifierSchema, { run: RUN_ID, name: 'a0' })

const OUTPUT_INTERFACE = typedInterface(
  undefined,
  variableMap(variable('o0', simpleType(SimpleType.INTEGER))),
)

function terminalDetails(phase = ActionPhase.SUCCEEDED) {
  return create(ActionDetailsSchema, {
    id: ACTION_ID,
    status: create(ActionStatusSchema, { phase }),
  })
}

describe('RunHandle identity', () => {
  it('exposes the run scope and a console URL', () => {
    const { ctx } = fakeContext()
    const run = new RunHandle(ctx, RUN_ID, ACTION_ID)
    expect(run.name).toBe('run-1')
    expect(run.project).toBe('my-project')
    expect(run.domain).toBe('development')
    expect(run.org).toBe('acme')
    expect(run.url).toBe(
      'https://acme.example.com/v2/domain/development/project/my-project/runs/run-1',
    )
  })
})

describe('RunHandle.details', () => {
  it('returns the run details', async () => {
    const getRunDetails = vi.fn(async () => ({
      details: create(RunDetailsSchema, { action: terminalDetails() }),
    }))
    const { ctx } = fakeContext({ services: { run: { getRunDetails } as never } })

    const details = await new RunHandle(ctx, RUN_ID, ACTION_ID).details()

    expect(details.action?.status?.phase).toBe(ActionPhase.SUCCEEDED)
  })

  it('throws when the server returns no details', async () => {
    const getRunDetails = vi.fn(async () => ({ details: undefined }))
    const { ctx } = fakeContext({ services: { run: { getRunDetails } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).details()).rejects.toThrow(
      /Run run-1 returned no details/,
    )
  })
})

describe('RunHandle.rawData', () => {
  const dataProxyOutputs = create(OutputsSchema, {
    literals: [namedLiteral('o0', intLiteral(7))],
  })

  it('reads through the dataplane cluster resolved by SelectCluster', async () => {
    const selectCluster = vi.fn(async () =>
      create(SelectClusterResponseSchema, { clusterEndpoint: 'https://dp.example.com' }),
    )
    const getActionData = vi.fn(async () => ({ outputs: dataProxyOutputs }))
    const { ctx } = fakeContext({
      services: {
        cluster: { selectCluster } as never,
        dataproxy: { getActionData } as never,
      },
    })

    const raw = await new RunHandle(ctx, RUN_ID, ACTION_ID).rawData()

    expect(raw.outputs?.literals.map((l) => l.name)).toEqual(['o0'])
    expect(selectCluster).toHaveBeenCalledTimes(1)
  })

  it('falls back to the run service when the data proxy has no record', async () => {
    // Cache-hit and recovered actions never executed, so the data proxy's
    // per-attempt records are empty; the run service serves their outputs.
    const selectCluster = vi.fn(async () =>
      create(SelectClusterResponseSchema, { clusterEndpoint: 'https://dp.example.com' }),
    )
    const proxyGetActionData = vi.fn(async () => {
      throw new ConnectError('no execution data', Code.NotFound)
    })
    const runGetActionData = vi.fn(async () => ({ outputs: dataProxyOutputs }))
    const { ctx } = fakeContext({
      services: {
        cluster: { selectCluster } as never,
        dataproxy: { getActionData: proxyGetActionData } as never,
        run: { getActionData: runGetActionData } as never,
      },
    })

    const raw = await new RunHandle(ctx, RUN_ID, ACTION_ID).rawData()

    expect(runGetActionData).toHaveBeenCalledTimes(1)
    expect(raw.outputs?.literals).toHaveLength(1)
  })

  it('falls back to the run service on older control planes without a data proxy', async () => {
    const selectCluster = vi.fn(async () => {
      throw new ConnectError('no cluster service', Code.Unimplemented)
    })
    const runGetActionData = vi.fn(async () => ({ outputs: dataProxyOutputs }))
    const { ctx } = fakeContext({
      services: {
        cluster: { selectCluster } as never,
        run: { getActionData: runGetActionData } as never,
      },
    })

    await new RunHandle(ctx, RUN_ID, ACTION_ID).rawData()

    expect(runGetActionData).toHaveBeenCalledTimes(1)
  })

  it('propagates unexpected data proxy errors', async () => {
    const selectCluster = vi.fn(async () => {
      throw new ConnectError('permission denied', Code.PermissionDenied)
    })
    const { ctx } = fakeContext({ services: { cluster: { selectCluster } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).rawData()).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('RunHandle.outputs', () => {
  it('converts outputs to native values using the task interface', async () => {
    const selectCluster = vi.fn(async () =>
      create(SelectClusterResponseSchema, { clusterEndpoint: 'https://dp.example.com' }),
    )
    const getActionData = vi.fn(async () => ({
      outputs: create(OutputsSchema, { literals: [namedLiteral('o0', intLiteral(7))] }),
    }))
    const { ctx, calls } = fakeContext({
      services: {
        cluster: { selectCluster } as never,
        dataproxy: { getActionData } as never,
      },
      literalsToLaunchFormJson: () => ({ json: { properties: { o0: { default: 7 } } } }),
    })
    const run = new RunHandle(ctx, RUN_ID, ACTION_ID, OUTPUT_INTERFACE, terminalDetails())

    expect(await run.outputs()).toEqual({ o0: 7 })
    expect(calls.literalsToLaunchFormJson[0]?.variables).toBe(OUTPUT_INTERFACE.outputs)
  })

  it('refuses to fetch outputs for a failed run', async () => {
    const { ctx } = fakeContext()
    const run = new RunHandle(
      ctx,
      RUN_ID,
      ACTION_ID,
      OUTPUT_INTERFACE,
      create(ActionDetailsSchema, {
        id: ACTION_ID,
        status: create(ActionStatusSchema, { phase: ActionPhase.FAILED }),
        result: {
          case: 'errorInfo',
          value: create(ErrorInfoSchema, { message: 'task raised ValueError' }),
        },
      }),
    )

    await expect(run.outputs()).rejects.toBeInstanceOf(FlyteRunFailedError)
  })

  it('waits first when the run is still in progress', async () => {
    const watchActionDetails = vi.fn(async function* () {
      yield { details: terminalDetails() }
    })
    const selectCluster = vi.fn(async () =>
      create(SelectClusterResponseSchema, { clusterEndpoint: 'https://dp.example.com' }),
    )
    const getActionData = vi.fn(async () => ({ outputs: create(OutputsSchema, {}) }))
    const getRunDetails = vi.fn(async () => ({
      details: create(RunDetailsSchema, { action: terminalDetails() }),
    }))
    const { ctx } = fakeContext({
      services: {
        run: { watchActionDetails, getRunDetails } as never,
        cluster: { selectCluster } as never,
        dataproxy: { getActionData } as never,
      },
    })
    const run = new RunHandle(
      ctx,
      RUN_ID,
      ACTION_ID,
      OUTPUT_INTERFACE,
      create(ActionDetailsSchema, {
        id: ACTION_ID,
        status: create(ActionStatusSchema, { phase: ActionPhase.RUNNING }),
      }),
    )

    expect(await run.outputs()).toEqual({})
    expect(watchActionDetails).toHaveBeenCalledTimes(1)
  })
})

describe('RunHandle.wait', () => {
  it('returns run details once terminal', async () => {
    const watchActionDetails = vi.fn(async function* () {
      yield {
        details: create(ActionDetailsSchema, {
          id: ACTION_ID,
          status: create(ActionStatusSchema, { phase: ActionPhase.RUNNING }),
        }),
      }
      yield { details: terminalDetails() }
    })
    const getRunDetails = vi.fn(async () => ({
      details: create(RunDetailsSchema, { action: terminalDetails() }),
    }))
    const { ctx } = fakeContext({
      services: { run: { watchActionDetails, getRunDetails } as never },
    })
    const seen: ActionPhase[] = []

    const details = await new RunHandle(ctx, RUN_ID, ACTION_ID).wait({
      onPhase: (p) => seen.push(p),
    })

    expect(seen).toEqual([ActionPhase.RUNNING, ActionPhase.SUCCEEDED])
    expect(details.action?.status?.phase).toBe(ActionPhase.SUCCEEDED)
  })

  it('throws on failure by default', async () => {
    const watchActionDetails = vi.fn(async function* () {
      yield { details: terminalDetails(ActionPhase.FAILED) }
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).wait()).rejects.toBeInstanceOf(
      FlyteRunFailedError,
    )
  })

  it('returns failed details when throwOnFailure is false', async () => {
    const watchActionDetails = vi.fn(async function* () {
      yield { details: terminalDetails(ActionPhase.FAILED) }
    })
    const getRunDetails = vi.fn(async () => ({
      details: create(RunDetailsSchema, { action: terminalDetails(ActionPhase.FAILED) }),
    }))
    const { ctx } = fakeContext({
      services: { run: { watchActionDetails, getRunDetails } as never },
    })

    const details = await new RunHandle(ctx, RUN_ID, ACTION_ID).wait({
      throwOnFailure: false,
    })

    expect(details.action?.status?.phase).toBe(ActionPhase.FAILED)
  })

  it('reports an aborted wait', async () => {
    const controller = new AbortController()
    controller.abort()
    const watchActionDetails = vi.fn(async function* () {
      // Aborted before any update arrives.
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    await expect(
      new RunHandle(ctx, RUN_ID, ACTION_ID).wait({ signal: controller.signal }),
    ).rejects.toThrow(/was aborted/)
  })

  it('reports a stream that ended without any update', async () => {
    const watchActionDetails = vi.fn(async function* () {
      // no updates, and no reconnect because the generator just ends
    })
    const { ctx } = fakeContext({ services: { run: { watchActionDetails } as never } })

    await expect(
      new RunHandle(ctx, RUN_ID, ACTION_ID).wait({ signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(FlyteError)
  })
})

describe('RunHandle.abort', () => {
  it('sends the run id and reason', async () => {
    const abortRun = vi.fn(async () => ({}))
    const { ctx } = fakeContext({ services: { run: { abortRun } as never } })

    await new RunHandle(ctx, RUN_ID, ACTION_ID).abort('stop')

    expect(abortRun).toHaveBeenCalledWith({ runId: RUN_ID, reason: 'stop' })
  })

  it('treats an already-gone run as aborted', async () => {
    const abortRun = vi.fn(async () => {
      throw new ConnectError('gone', Code.NotFound)
    })
    const { ctx } = fakeContext({ services: { run: { abortRun } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).abort()).resolves.toBeUndefined()
  })

  it('propagates other abort failures', async () => {
    const abortRun = vi.fn(async () => {
      throw new ConnectError('nope', Code.PermissionDenied)
    })
    const { ctx } = fakeContext({ services: { run: { abortRun } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).abort()).rejects.toThrow(/nope/)
  })
})

describe('RunHandle.listActions', () => {
  function action(name: string, actionType = ActionType.TASK) {
    return create(ActionSchema, {
      id: create(ActionIdentifierSchema, { run: RUN_ID, name }),
      metadata: create(ActionMetadataSchema, { actionType }),
      status: create(ActionStatusSchema, { phase: ActionPhase.SUCCEEDED }),
    })
  }

  it('pages through the full list', async () => {
    const listActions = vi
      .fn()
      .mockResolvedValueOnce({ actions: [action('a0'), action('a1')], token: 'next' })
      .mockResolvedValueOnce({ actions: [action('a2')], token: '' })
    const { ctx } = fakeContext({ services: { run: { listActions } as never } })

    const actions = await new RunHandle(ctx, RUN_ID, ACTION_ID).listActions()

    expect(actions.map((a) => a.name)).toEqual(['a0', 'a1', 'a2'])
    expect(listActions).toHaveBeenCalledTimes(2)
    // The second page continues from the first page's token.
    const second = callArg<{ request?: { token?: string } }>(listActions, 1)
    expect(second.request?.token).toBe('next')
  })

  it('carries phase and type through from the listing', async () => {
    const listActions = vi.fn(async () => ({
      actions: [action('a1', ActionType.CONDITION)],
      token: '',
    }))
    const { ctx } = fakeContext({ services: { run: { listActions } as never } })

    const [condition] = await new RunHandle(ctx, RUN_ID, ACTION_ID).listActions()

    expect(condition?.actionType).toBe(ActionType.CONDITION)
    expect(condition?.phase).toBe(ActionPhase.SUCCEEDED)
  })

  it('fetches only condition actions with full details for listConditions', async () => {
    const listActions = vi.fn(async () => ({
      actions: [action('a0'), action('a1', ActionType.CONDITION)],
      token: '',
    }))
    const getActionDetails = vi.fn(async (req: { actionId: { name: string } }) => ({
      details: create(ActionDetailsSchema, {
        id: create(ActionIdentifierSchema, { run: RUN_ID, name: req.actionId.name }),
        metadata: create(ActionMetadataSchema, { actionType: ActionType.CONDITION }),
      }),
    }))
    const { ctx } = fakeContext({
      services: { run: { listActions, getActionDetails } as never },
    })

    const conditions = await new RunHandle(ctx, RUN_ID, ACTION_ID).listConditions()

    expect(conditions.map((c) => c.name)).toEqual(['a1'])
    // Only the condition is re-fetched; the task action is not.
    expect(getActionDetails).toHaveBeenCalledTimes(1)
  })
})

describe('RunHandle.action', () => {
  it('fetches one action by name', async () => {
    const getActionDetails = vi.fn(async () => ({
      details: create(ActionDetailsSchema, {
        id: create(ActionIdentifierSchema, { run: RUN_ID, name: 'a3' }),
      }),
    }))
    const { ctx } = fakeContext({ services: { run: { getActionDetails } as never } })

    const action = await new RunHandle(ctx, RUN_ID, ACTION_ID).action('a3')

    expect(action.name).toBe('a3')
  })

  it('reports a missing action as not found', async () => {
    const getActionDetails = vi.fn(async () => {
      throw new ConnectError('nope', Code.NotFound)
    })
    const { ctx } = fakeContext({ services: { run: { getActionDetails } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).action('a9')).rejects.toBeInstanceOf(
      FlyteNotFoundError,
    )
  })

  it('rejects a non-condition action passed to condition()', async () => {
    const getActionDetails = vi.fn(async () => ({
      details: create(ActionDetailsSchema, {
        id: create(ActionIdentifierSchema, { run: RUN_ID, name: 'a0' }),
        metadata: create(ActionMetadataSchema, { actionType: ActionType.TASK }),
      }),
    }))
    const { ctx } = fakeContext({ services: { run: { getActionDetails } as never } })

    await expect(new RunHandle(ctx, RUN_ID, ACTION_ID).condition('a0')).rejects.toThrow(
      /is not a condition/,
    )
  })
})

describe('RunHandle output interface discovery', () => {
  it('picks up the task interface from a watch update', async () => {
    // A run attached by name may not know its interface yet; the task spec on
    // the root action supplies it.
    const detailsWithSpec = create(ActionDetailsSchema, {
      id: ACTION_ID,
      status: create(ActionStatusSchema, { phase: ActionPhase.SUCCEEDED }),
      spec: {
        case: 'task',
        value: create(TaskSpecSchema, {
          taskTemplate: create(TaskTemplateSchema, { interface: OUTPUT_INTERFACE }),
        }),
      },
    })
    const watchActionDetails = vi.fn(async function* () {
      yield { details: detailsWithSpec }
    })
    const getRunDetails = vi.fn(async () => ({
      details: create(RunDetailsSchema, { action: detailsWithSpec }),
    }))
    const selectCluster = vi.fn(async () =>
      create(SelectClusterResponseSchema, { clusterEndpoint: 'https://dp.example.com' }),
    )
    const getActionData = vi.fn(async () => ({
      outputs: create(OutputsSchema, { literals: [namedLiteral('o0', intLiteral(7))] }),
    }))
    const { ctx, calls } = fakeContext({
      services: {
        run: { watchActionDetails, getRunDetails, getActionData } as never,
        cluster: { selectCluster } as never,
        dataproxy: { getActionData } as never,
      },
      literalsToLaunchFormJson: () => ({ json: { properties: { o0: { default: 7 } } } }),
    })

    const run = new RunHandle(ctx, RUN_ID, ACTION_ID)
    await run.wait()
    expect(await run.outputs()).toEqual({ o0: 7 })
    expect(calls.literalsToLaunchFormJson[0]?.variables).toEqual(OUTPUT_INTERFACE.outputs)
  })
})
