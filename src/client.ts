/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * The Flyte client: one object that gives you all the options.
 *
 * ```ts
 * const flyte = await Flyte.init({
 *   endpoint: 'https://my.flyte.host',
 *   auth: { apiKey: process.env.FLYTE_API_KEY },
 *   project: 'my-project',
 *   domain: 'development',
 * })
 *
 * const run = await flyte.run('my_task', { x: 1, name: 'hello' })
 * const details = await run.wait()
 * const { outputs } = await run.outputs()
 * ```
 */

import { create } from '@bufbuild/protobuf'
import type { JsonObject } from '@bufbuild/protobuf'

import { discoverPublicClientConfig } from './auth'
import type { FlyteConfig, ResolvedAuth, ResolvedConfig } from './config'
import { resolveConfig } from './config'
import { createContext, type ClientContext, type Services } from './context'
import { DataClient } from './data'
import { FlyteConfigError, FlyteError } from './errors'
import {
  ProjectIdentifierSchema,
  RunIdentifierSchema,
} from './gen/flyteidl2/common/identifier_pb'
import { InputsSchema } from './gen/flyteidl2/task/common_pb'
import type { RunSpec } from './gen/flyteidl2/task/run_pb'
import {
  TaskIdentifierSchema,
  TaskNameSchema,
} from './gen/flyteidl2/task/task_definition_pb'
import type { CreateRunRequest } from './gen/flyteidl2/workflow/run_service_pb'
import {
  CreateRunRequestSchema,
  ListRunsRequestSchema,
} from './gen/flyteidl2/workflow/run_service_pb'
import type { Run } from './gen/flyteidl2/workflow/run_definition_pb'
import { RunSource } from './gen/flyteidl2/workflow/run_definition_pb'
import { UploadInputsRequestSchema } from './gen/flyteidl2/dataproxy/dataproxy_service_pb'
import { JsonValuesToLiteralsRequestSchema } from './gen/flyteidl2/workflow/translator_service_pb'
import { RunHandle, type WaitOptions } from './run'

async function applyDiscoveredAuthHeader(
  resolved: ResolvedConfig,
  explicitHeader?: string,
): Promise<void> {
  if (explicitHeader) return
  if (
    resolved.auth.mode !== 'client_credentials' &&
    resolved.auth.mode !== 'bearer' &&
    resolved.auth.mode !== 'bearer_dynamic'
  ) {
    return
  }
  try {
    const pub = await discoverPublicClientConfig(resolved.endpoint)
    const key = (pub.authorizationMetadataKey || 'authorization').toLowerCase()
    ;(resolved.auth as ResolvedAuth & { authorizationHeader: string }).authorizationHeader = key
  } catch {
    // keep default authorization
  }
}

/** A reference to a deployed task. A bare string is shorthand for `{ name }`. */
export interface TaskRef {
  name: string
  /** Task version. When omitted, the latest deployed version is used. */
  version?: string
}

export type TaskInput = string | TaskRef

/**
 * Arguments for {@link Flyte.run}. `project` and `domain` are always passed on
 * the call itself; `org` defaults to the client's org (from the API key).
 */
export interface RunArgs {
  /** Task to run: a name (uses the latest version) or `{ name, version }`. */
  task: TaskInput
  /** Project to run in. Required. */
  project: string
  /** Domain to run in. Required. */
  domain: string
  /** Org override. Defaults to the client's configured org. */
  org?: string
  /** Plain JSON inputs; converted to typed literals server-side. */
  inputs?: JsonObject
  /** Explicit run name. When omitted, the server generates one. */
  runName?: string
  /**
   * Offload inputs through DataProxy before creating the run (recommended and
   * required for large inputs). Defaults to `true`.
   */
  offload?: boolean
  /** Optional run spec (labels, envs, interruptible, cache overrides, ...). */
  runSpec?: RunSpec
  /** If true, wait for the run to reach a terminal phase before returning. */
  wait?: boolean
  /** Options forwarded to {@link RunHandle.wait} when `wait` is true. */
  waitOptions?: WaitOptions
}

/** Org/project/domain scope passed to run lookups and listings. */
export interface RunScope {
  /** Project. Required. */
  project: string
  /** Domain. Required. */
  domain: string
  /** Org override. Defaults to the client's configured org. */
  org?: string
}

export class Flyte {
  private constructor(private readonly ctx: ClientContext) {
    this.data = new DataClient(ctx)
  }

  /** Data upload/download helpers. */
  readonly data: DataClient

  /** Resolves configuration and constructs a client. */
  static async init(config?: FlyteConfig): Promise<Flyte> {
    const resolved = resolveConfig(config)
    await applyDiscoveredAuthHeader(resolved, config?.auth?.authorizationHeader)
    return new Flyte(createContext(resolved))
  }

  /** Direct access to the underlying generated Connect service clients. */
  get services(): Services {
    return this.ctx.services
  }

  /** Resolved default org/project/domain and endpoint. */
  get config() {
    return this.ctx.config
  }

  /**
   * Triggers a run of an already-deployed task. `project` and `domain` are
   * passed on the call itself.
   *
   * ```ts
   * await flyte.run({
   *   task: 'my_task',
   *   project: 'my-project',
   *   domain: 'development',
   *   inputs: { x: 1 },
   * })
   * ```
   */
  async run(args: RunArgs): Promise<RunHandle> {
    const scope = this.requireScope(args)
    const ref: TaskRef = typeof args.task === 'string' ? { name: args.task } : args.task
    const version = ref.version ?? (await this.latestVersion({ ...scope, name: ref.name }))

    const taskId = create(TaskIdentifierSchema, {
      org: scope.org,
      project: scope.project,
      domain: scope.domain,
      name: ref.name,
      version,
    })

    // Fetch the task interface so inputs can be typed correctly.
    const taskDetails = await this.ctx.services.task.getTaskDetails({ taskId })
    const variables = taskDetails.details?.spec?.taskTemplate?.interface?.inputs

    const { literals } = await this.ctx.services.translator.jsonValuesToLiterals(
      create(JsonValuesToLiteralsRequestSchema, {
        variables,
        values: args.inputs ?? {},
      }),
    )
    const inputsMsg = create(InputsSchema, { literals })

    const idField: CreateRunRequest['id'] = args.runName
      ? {
          case: 'runId',
          value: create(RunIdentifierSchema, {
            org: scope.org,
            project: scope.project,
            domain: scope.domain,
            name: args.runName,
          }),
        }
      : {
          case: 'projectId',
          value: create(ProjectIdentifierSchema, {
            organization: scope.org,
            domain: scope.domain,
            name: scope.project,
          }),
        }

    const taskField: CreateRunRequest['task'] = { case: 'taskId', value: taskId }

    let inputWrapper: CreateRunRequest['inputWrapper']
    if (args.offload === false) {
      inputWrapper = { case: 'inputs', value: inputsMsg }
    } else {
      const uploaded = await this.ctx.services.dataproxy.uploadInputs(
        create(UploadInputsRequestSchema, {
          id: idField,
          task: taskField,
          inputs: inputsMsg,
        }),
      )
      if (!uploaded.offloadedInputData) {
        throw new FlyteError('UploadInputs did not return offloaded input data.')
      }
      inputWrapper = {
        case: 'offloadedInputData',
        value: uploaded.offloadedInputData,
      }
    }

    const res = await this.ctx.services.run.createRun(
      create(CreateRunRequestSchema, {
        id: idField,
        task: taskField,
        inputWrapper,
        runSpec: args.runSpec,
        source: RunSource.CLI,
      }),
    )

    const handle = this.handleFromRun(res.run)
    if (args.wait) {
      await handle.wait(args.waitOptions)
    }
    return handle
  }

  /** Returns a handle for an existing run by name. */
  async getRun(runName: string, scope: RunScope): Promise<RunHandle> {
    const { org, project, domain } = this.requireScope(scope)
    const runId = create(RunIdentifierSchema, {
      org,
      project,
      domain,
      name: runName,
    })
    const res = await this.ctx.services.run.getRunDetails({ runId })
    const actionId = res.details?.action?.id
    if (!actionId) {
      throw new FlyteError(`Run ${runName} has no root action id.`)
    }
    return new RunHandle(this.ctx, runId, actionId)
  }

  /** Lists runs for a project. */
  async listRuns(scope: RunScope, limit = 20): Promise<Run[]> {
    const { org, project, domain } = this.requireScope(scope)
    const res = await this.ctx.services.run.listRuns(
      create(ListRunsRequestSchema, {
        request: { limit },
        scopeBy: {
          case: 'projectId',
          value: create(ProjectIdentifierSchema, {
            organization: org,
            domain,
            name: project,
          }),
        },
      }),
    )
    return res.runs
  }

  private handleFromRun(run: Run | undefined): RunHandle {
    const actionId = run?.action?.id
    if (!actionId?.run) {
      throw new FlyteError('CreateRun response did not include a run action id.')
    }
    return new RunHandle(this.ctx, actionId.run, actionId)
  }

  private async latestVersion(ref: {
    org: string
    project: string
    domain: string
    name: string
  }): Promise<string> {
    const res = await this.ctx.services.task.listVersions({
      taskName: create(TaskNameSchema, {
        org: ref.org,
        project: ref.project,
        domain: ref.domain,
        name: ref.name,
      }),
      request: { limit: 1 },
    })
    const version = res.versions[0]?.version
    if (!version) {
      throw new FlyteError(
        `No deployed versions found for task "${ref.name}" in ${ref.project}/${ref.domain}.`,
      )
    }
    return version
  }

  private requireScope(scope: RunScope): {
    org: string
    project: string
    domain: string
  } {
    const org = scope.org ?? this.ctx.config.org
    if (!org) {
      throw new FlyteConfigError(
        'org is required. Provide it on the call or via the API key / Flyte.init({ org }).',
      )
    }
    if (!scope.project || !scope.domain) {
      throw new FlyteConfigError('project and domain are required on the call.')
    }
    return { org, project: scope.project, domain: scope.domain }
  }
}
