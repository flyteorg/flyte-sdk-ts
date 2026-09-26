/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'

import { FlyteNotFoundError } from '../src/errors'
import { Sort_Direction } from '../src/gen/flyteidl2/common/list_pb'
import { SimpleType } from '../src/gen/flyteidl2/core/types_pb'
import { TaskTemplateSchema } from '../src/gen/flyteidl2/core/tasks_pb'
import {
  TaskDetailsSchema,
  TaskIdentifierSchema,
  TaskSpecSchema,
} from '../src/gen/flyteidl2/task/task_definition_pb'
import { getTaskDetails, TaskDetails } from '../src/task'
import {
  callArg,
  defaultParameter,
  fakeContext,
  intLiteral,
  simpleType,
  typedInterface,
  variable,
  variableMap,
} from './helpers/fakeContext'

const SCOPE = { org: 'acme', project: 'my-project', domain: 'development' }
const INT = simpleType(SimpleType.INTEGER)

function taskDetailsPb(version = 'v1') {
  return create(TaskDetailsSchema, {
    taskId: create(TaskIdentifierSchema, {
      org: 'acme',
      project: 'my-project',
      domain: 'development',
      name: 'my_env.my_task',
      version,
    }),
    spec: create(TaskSpecSchema, {
      taskTemplate: create(TaskTemplateSchema, {
        interface: typedInterface(variableMap(variable('x', INT))),
      }),
      defaultInputs: [defaultParameter('x', INT, intLiteral(1))],
    }),
  })
}

describe('TaskDetails', () => {
  it('exposes identity, interface, and default inputs', () => {
    const details = new TaskDetails(taskDetailsPb('abc123'))
    expect(details.name).toBe('my_env.my_task')
    expect(details.version).toBe('abc123')
    expect(details.project).toBe('my-project')
    expect(details.domain).toBe('development')
    expect(details.org).toBe('acme')
    expect(details.interface?.inputs?.variables.map((v) => v.key)).toEqual(['x'])
    expect(details.defaultInputs.map((p) => p.name)).toEqual(['x'])
  })

  it('defaults to empty values for an unpopulated protobuf', () => {
    const details = new TaskDetails(create(TaskDetailsSchema, {}))
    expect(details.name).toBe('')
    expect(details.version).toBe('')
    expect(details.interface).toBeUndefined()
    expect(details.defaultInputs).toEqual([])
  })
})

describe('getTaskDetails', () => {
  it('resolves the latest version when none is pinned', async () => {
    const listVersions = vi.fn(async () => ({ versions: [{ version: 'latest-abc' }] }))
    const getTaskDetailsRpc = vi.fn(async () => ({ details: taskDetailsPb('latest-abc') }))
    const { ctx } = fakeContext({
      services: {
        task: { listVersions, getTaskDetails: getTaskDetailsRpc } as never,
      },
    })

    const details = await getTaskDetails(ctx, { name: 'my_env.my_task' }, SCOPE)

    expect(details.version).toBe('latest-abc')
    // The newest version is the first result sorted by created_at descending.
    const req = callArg<{
      request?: { limit?: number; sortByFields?: { key: string; direction: number }[] }
    }>(listVersions)
    expect(req.request?.limit).toBe(1)
    expect(req.request?.sortByFields?.[0]).toMatchObject({
      key: 'created_at',
      direction: Sort_Direction.DESCENDING,
    })
    expect(callArg(getTaskDetailsRpc)).toMatchObject({
      taskId: { name: 'my_env.my_task', version: 'latest-abc' },
    })
  })

  it('skips version resolution when a version is pinned', async () => {
    const listVersions = vi.fn()
    const getTaskDetailsRpc = vi.fn(async () => ({ details: taskDetailsPb('pinned') }))
    const { ctx } = fakeContext({
      services: { task: { listVersions, getTaskDetails: getTaskDetailsRpc } as never },
    })

    await getTaskDetails(ctx, { name: 'my_env.my_task', version: 'pinned' }, SCOPE)

    expect(listVersions).not.toHaveBeenCalled()
  })

  it('honors per-task project and domain overrides', async () => {
    const listVersions = vi.fn(async () => ({ versions: [{ version: 'v' }] }))
    const getTaskDetailsRpc = vi.fn(async () => ({ details: taskDetailsPb() }))
    const { ctx } = fakeContext({
      services: { task: { listVersions, getTaskDetails: getTaskDetailsRpc } as never },
    })

    await getTaskDetails(
      ctx,
      { name: 'my_env.my_task', project: 'other-project', domain: 'staging' },
      SCOPE,
    )

    expect(callArg(getTaskDetailsRpc)).toMatchObject({
      taskId: { project: 'other-project', domain: 'staging', org: 'acme' },
    })
  })

  it('requires a task name', async () => {
    const { ctx } = fakeContext()
    await expect(getTaskDetails(ctx, { name: '' }, SCOPE)).rejects.toThrow(
      /Task name is required/,
    )
  })

  it('reports a task with no deployed versions', async () => {
    const listVersions = vi.fn(async () => ({ versions: [] }))
    const { ctx } = fakeContext({ services: { task: { listVersions } as never } })

    await expect(getTaskDetails(ctx, { name: 'nope' }, SCOPE)).rejects.toThrow(
      /No deployed versions found for task "nope" in my-project\/development/,
    )
  })

  it('reports a missing pinned version as not found', async () => {
    const getTaskDetailsRpc = vi.fn(async () => {
      throw new ConnectError('gone', Code.NotFound)
    })
    const { ctx } = fakeContext({
      services: { task: { getTaskDetails: getTaskDetailsRpc } as never },
    })

    const promise = getTaskDetails(ctx, { name: 'my_env.my_task', version: 'v9' }, SCOPE)
    await expect(promise).rejects.toBeInstanceOf(FlyteNotFoundError)
    await expect(
      getTaskDetails(ctx, { name: 'my_env.my_task', version: 'v9' }, SCOPE),
    ).rejects.toThrow(/version v9 not found in my-project\/development/)
  })

  it('throws when the server returns no details', async () => {
    const getTaskDetailsRpc = vi.fn(async () => ({ details: undefined }))
    const { ctx } = fakeContext({
      services: { task: { getTaskDetails: getTaskDetailsRpc } as never },
    })

    await expect(
      getTaskDetails(ctx, { name: 'my_env.my_task', version: 'v1' }, SCOPE),
    ).rejects.toThrow(/returned no details/)
  })
})
