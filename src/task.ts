/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Fetching deployed tasks and inspecting their typed interfaces. */

import { create } from '@bufbuild/protobuf'
import { Code } from '@connectrpc/connect'

import type { ClientContext } from './context'
import { FlyteError, FlyteNotFoundError, isConnectCode } from './errors'
import { Sort_Direction, SortSchema } from './gen/flyteidl2/common/list_pb'
import type { TypedInterface } from './gen/flyteidl2/core/interface_pb'
import type { NamedParameter } from './gen/flyteidl2/task/common_pb'
import type { TaskDetails as TaskDetailsPb } from './gen/flyteidl2/task/task_definition_pb'
import {
  TaskIdentifierSchema,
  TaskNameSchema,
} from './gen/flyteidl2/task/task_definition_pb'

/** A reference to a deployed task. A bare string is shorthand for `{ name }`. */
export interface TaskRef {
  /** Full task name, e.g. `my_env.my_task`. */
  name: string
  /** Task version. When omitted, the latest deployed version is used. */
  version?: string
  /** Project override for this task. Defaults to the call/client scope. */
  project?: string
  /** Domain override for this task. Defaults to the call/client scope. */
  domain?: string
}

/**
 * A fetched task: its identity plus the full registered spec (typed
 * interface, default inputs, metadata). Mirrors the Go SDK's TaskDetails and
 * the Python SDK's flyte.remote.TaskDetails.
 */
export class TaskDetails {
  constructor(
    /** The underlying protobuf, for advanced use. */
    readonly pb: TaskDetailsPb,
  ) {}

  get name(): string {
    return this.pb.taskId?.name ?? ''
  }
  get version(): string {
    return this.pb.taskId?.version ?? ''
  }
  get project(): string {
    return this.pb.taskId?.project ?? ''
  }
  get domain(): string {
    return this.pb.taskId?.domain ?? ''
  }
  get org(): string {
    return this.pb.taskId?.org ?? ''
  }

  /** The task's typed input/output interface. */
  get interface(): TypedInterface | undefined {
    return this.pb.spec?.taskTemplate?.interface
  }

  /** The task's registered default input parameters. */
  get defaultInputs(): NamedParameter[] {
    return this.pb.spec?.defaultInputs ?? []
  }
}

/** Fetches a deployed task, resolving the latest version when none is pinned. */
export async function getTaskDetails(
  ctx: ClientContext,
  ref: TaskRef,
  scope: { org: string; project: string; domain: string },
): Promise<TaskDetails> {
  if (!ref.name) {
    throw new FlyteError('Task name is required.')
  }
  const project = ref.project ?? scope.project
  const domain = ref.domain ?? scope.domain

  const version =
    ref.version ?? (await latestTaskVersion(ctx, { ...scope, project, domain, name: ref.name }))

  try {
    const res = await ctx.services.task.getTaskDetails({
      taskId: create(TaskIdentifierSchema, {
        org: scope.org,
        project,
        domain,
        name: ref.name,
        version,
      }),
    })
    if (!res.details) {
      throw new FlyteError(`GetTaskDetails returned no details for task "${ref.name}".`)
    }
    return new TaskDetails(res.details)
  } catch (err) {
    if (isConnectCode(err, Code.NotFound)) {
      throw new FlyteNotFoundError(
        `Task "${ref.name}" version ${version} not found in ${project}/${domain}.`,
        { cause: err },
      )
    }
    throw err
  }
}

/** Returns the most recently created version of the named task. */
async function latestTaskVersion(
  ctx: ClientContext,
  ref: { org: string; project: string; domain: string; name: string },
): Promise<string> {
  const res = await ctx.services.task.listVersions({
    taskName: create(TaskNameSchema, {
      org: ref.org,
      project: ref.project,
      domain: ref.domain,
      name: ref.name,
    }),
    request: {
      limit: 1,
      sortByFields: [
        create(SortSchema, { key: 'created_at', direction: Sort_Direction.DESCENDING }),
      ],
    },
  })
  const version = res.versions[0]?.version
  if (!version) {
    throw new FlyteNotFoundError(
      `No deployed versions found for task "${ref.name}" in ${ref.project}/${ref.domain}.`,
    )
  }
  return version
}
