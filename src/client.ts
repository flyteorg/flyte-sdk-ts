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
 * const run = await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })
 * await run.wait()
 * const outputs = await run.outputs()
 * ```
 */

import { create } from '@bufbuild/protobuf'
import { Code } from '@connectrpc/connect'

import { discoverPublicClientConfig } from './auth'
import type {
  AuthOptions,
  FlyteConfig,
  ResolvedAuth,
  ResolvedConfig,
  RunSourceName,
} from './config'
import { resolveConfig } from './config'
import { findConfigPath, loadConfigFile } from './configFile'
import { createContext, type ClientContext, type Services } from './context'
import { DataClient } from './data'
import {
  FlyteAlreadyExistsError,
  FlyteConfigError,
  FlyteError,
  FlyteNotFoundError,
  isConnectCode,
} from './errors'
import {
  ProjectIdentifierSchema,
  RunIdentifierSchema,
} from './gen/flyteidl2/common/identifier_pb'
import { InputsSchema } from './gen/flyteidl2/task/common_pb'
import type { CreateRunRequest } from './gen/flyteidl2/workflow/run_service_pb'
import {
  CreateRunRequestSchema,
  ListRunsRequestSchema,
} from './gen/flyteidl2/workflow/run_service_pb'
import type { Run } from './gen/flyteidl2/workflow/run_definition_pb'
import {
  ActionDetailsSchema,
  RunSource,
} from './gen/flyteidl2/workflow/run_definition_pb'
import { UploadInputsRequestSchema } from './gen/flyteidl2/dataproxy/dataproxy_service_pb'
import { prepareInputs, taskInputsShape, type RunInputs } from './io'
import type { RunOptions } from './options'
import { buildRunSpec } from './options'
import { RunHandle, type WaitOptions } from './run'
import type { TaskRef } from './task'
import { getTaskDetails, TaskDetails } from './task'
import { createTlsFetch } from './tls'

async function applyDiscoveredAuthHeader(
  resolved: ResolvedConfig,
  explicitHeader: string | undefined,
  fetchFn: typeof fetch | undefined,
): Promise<void> {
  if (explicitHeader) return
  const bearerModes: ResolvedAuth['mode'][] = [
    'client_credentials',
    'bearer',
    'bearer_dynamic',
    'pkce',
    'device_flow',
    'external_command',
  ]
  if (!bearerModes.includes(resolved.auth.mode)) return
  try {
    const pub = await discoverPublicClientConfig(resolved.endpoint, fetchFn)
    const key = (pub.authorizationMetadataKey || 'authorization').toLowerCase()
    ;(resolved.auth as ResolvedAuth & { authorizationHeader: string }).authorizationHeader = key
  } catch {
    // keep default authorization
  }
}

/** True when these auth options carry credentials of their own. */
function suppliesCredentials(auth: AuthOptions | undefined): boolean {
  if (!auth) return false
  return Boolean(
    auth.apiKey ||
      auth.clientSecret ||
      auth.clientSecretEnvVar ||
      auth.clientSecretLocation ||
      auth.bearerToken ||
      auth.getAccessToken ||
      auth.command ||
      auth.session,
  )
}

const RUN_SOURCES: Record<RunSourceName, RunSource> = {
  web: RunSource.WEB,
  cli: RunSource.CLI,
  unspecified: RunSource.UNSPECIFIED,
}

export type { TaskRef }

export type TaskInput = string | TaskRef | TaskDetails

/**
 * Arguments for {@link Flyte.run}. `project` and `domain` come from the call
 * or fall back to the client defaults; `org` defaults to the client's org.
 */
export interface RunArgs extends RunOptions {
  /**
   * Task to run: a name (uses the latest version), `{ name, version }`, or a
   * {@link TaskDetails} previously fetched with {@link Flyte.getTask}.
   */
  task: TaskInput
  /** Project to run in. Falls back to the client default. */
  project?: string
  /** Domain to run in. Falls back to the client default. */
  domain?: string
  /** Org override. Defaults to the client's configured org. */
  org?: string
  /**
   * Plain JavaScript inputs; validated against the task's typed interface
   * and converted to typed literals. Omitted inputs fall back to the task's
   * registered defaults.
   */
  inputs?: RunInputs
  /** Explicit run name. When omitted, the server generates one. */
  runName?: string
  /**
   * Offload inputs through DataProxy before creating the run (recommended
   * and required for large inputs). Defaults to `true`; older control planes
   * without DataProxy fall back to inline inputs automatically.
   */
  offload?: boolean
  /** If true, wait for the run to reach a terminal phase before returning. */
  wait?: boolean
  /** Options forwarded to {@link RunHandle.wait} when `wait` is true. */
  waitOptions?: WaitOptions
}

/** Org/project/domain scope passed to run lookups and listings. */
export interface RunScope {
  /** Project. Falls back to the client default. */
  project?: string
  /** Domain. Falls back to the client default. */
  domain?: string
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
    // Resolve the TLS-aware fetch first: discovery and token requests must
    // trust the same certificates as the RPCs.
    const tlsFetch = await createTlsFetch(resolved.tls)
    await applyDiscoveredAuthHeader(resolved, config?.auth?.authorizationHeader, tlsFetch)
    return new Flyte(createContext(resolved, { fetch: tlsFetch }))
  }

  /**
   * Initializes the client from a flytectl/uctl-style YAML config file
   * (e.g. `~/.flyte/config.yaml`). When `path` is omitted, the standard
   * locations are searched. Node only. Overrides are merged on top of the
   * file's values.
   */
  static async initFromConfig(path?: string, overrides?: FlyteConfig): Promise<Flyte> {
    const resolvedPath = path ?? (await findConfigPath())
    if (!resolvedPath) {
      throw new FlyteConfigError(
        'No config file found; searched ./config.yaml, ./.flyte/, the git root, ' +
          '$UCTL_CONFIG, $FLYTECTL_CONFIG, ~/.union/, and ~/.flyte/.',
      )
    }
    const fileConfig = await loadConfigFile(resolvedPath)
    const fileAuth = { ...fileConfig.auth }
    // The file always carries a mode (PKCE by default). Overrides that supply
    // their own credentials must not be shadowed by it, so a CI process can
    // pass an API key against a developer's interactive config.
    if (!overrides?.auth?.mode && suppliesCredentials(overrides?.auth)) {
      delete fileAuth.mode
    }
    return Flyte.init({
      ...fileConfig,
      ...overrides,
      auth: { ...fileAuth, ...overrides?.auth },
    })
  }

  /**
   * Initializes the client from a platform API key (base64 of
   * `endpoint:clientId:clientSecret:org`). When omitted, the
   * `FLYTE_API_KEY` environment variable is used.
   */
  static async initFromApiKey(apiKey?: string): Promise<Flyte> {
    const key = apiKey ?? process.env?.FLYTE_API_KEY
    if (!key) {
      throw new FlyteConfigError(
        'No API key provided and FLYTE_API_KEY is not set.',
      )
    }
    return Flyte.init({ auth: { apiKey: key } })
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
   * Fetches a deployed task: its identity plus the full registered spec
   * (typed interface, default inputs). When no version is pinned, the latest
   * deployed version is resolved. Pass the result to {@link run} to skip the
   * lookup there.
   */
  async getTask(task: string | TaskRef, scope: RunScope = {}): Promise<TaskDetails> {
    const ref: TaskRef = typeof task === 'string' ? { name: task } : task
    // A project/domain on the ref itself wins over the call scope, which in
    // turn wins over the client defaults.
    return getTaskDetails(
      this.ctx,
      ref,
      this.requireScope({
        org: scope.org,
        project: ref.project ?? scope.project,
        domain: ref.domain ?? scope.domain,
      }),
    )
  }

  /**
   * Triggers a run of an already-deployed task.
   *
   * ```ts
   * const run = await flyte.run({
   *   task: 'my_env.my_task',
   *   project: 'my-project',
   *   domain: 'development',
   *   inputs: { x: 1 },
   *   envVars: { LOG_LEVEL: 'DEBUG' },
   * })
   * ```
   */
  async run(args: RunArgs): Promise<RunHandle> {
    const scope = this.requireScope(args)

    const details =
      args.task instanceof TaskDetails
        ? args.task
        : await this.getTask(args.task, scope)

    const shape = taskInputsShape(details.name, details.interface?.inputs, details.defaultInputs)
    const literals = await prepareInputs(this.ctx, shape, args.inputs ?? {})
    const inputsMsg = create(InputsSchema, { literals })

    const taskId = details.pb.taskId
    if (!taskId) {
      throw new FlyteError(`Task "${details.name}" has no identifier.`)
    }

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

    // Offload inputs via the data proxy (the current SDK launch path).
    // Older control planes without the data proxy get inline inputs instead.
    let inputWrapper: CreateRunRequest['inputWrapper']
    if (args.offload === false) {
      inputWrapper = { case: 'inputs', value: inputsMsg }
    } else {
      try {
        const uploaded = await this.ctx.services.dataproxy.uploadInputs(
          create(UploadInputsRequestSchema, {
            id: idField,
            task: taskField,
            inputs: inputsMsg,
            baseDir: args.runBaseDir ?? '',
          }),
        )
        if (!uploaded.offloadedInputData) {
          throw new FlyteError('UploadInputs did not return offloaded input data.')
        }
        inputWrapper = {
          case: 'offloadedInputData',
          value: uploaded.offloadedInputData,
        }
      } catch (err) {
        if (!isConnectCode(err, Code.Unimplemented)) throw err
        inputWrapper = { case: 'inputs', value: inputsMsg }
      }
    }

    let res
    try {
      res = await this.ctx.services.run.createRun(
        create(CreateRunRequestSchema, {
          id: idField,
          task: taskField,
          inputWrapper,
          runSpec: buildRunSpec(args, scope),
          source: RUN_SOURCES[this.ctx.config.runSource],
        }),
      )
    } catch (err) {
      if (isConnectCode(err, Code.AlreadyExists)) {
        throw new FlyteAlreadyExistsError(
          args.runName
            ? `A run named "${args.runName}" already exists in ${scope.project}/${scope.domain}.`
            : `A run for task "${details.name}" already exists in ${scope.project}/${scope.domain}.`,
          { cause: err },
        )
      }
      throw err
    }

    const handle = this.handleFromRun(res.run, details)
    if (args.wait) {
      await handle.wait(args.waitOptions)
    }
    return handle
  }

  /** Returns a handle for an existing run by name. */
  async getRun(runName: string, scope: RunScope = {}): Promise<RunHandle> {
    const { org, project, domain } = this.requireScope(scope)
    if (!runName) {
      throw new FlyteError('Run name is required.')
    }
    const runId = create(RunIdentifierSchema, {
      org,
      project,
      domain,
      name: runName,
    })
    let res
    try {
      res = await this.ctx.services.run.getRunDetails({ runId })
    } catch (err) {
      if (isConnectCode(err, Code.NotFound)) {
        throw new FlyteNotFoundError(
          `Run "${runName}" not found in ${project}/${domain}.`,
          { cause: err },
        )
      }
      throw err
    }
    const action = res.details?.action
    if (!action?.id) {
      throw new FlyteError(`Run ${runName} has no root action id.`)
    }
    // The resolved task spec on the root action drives output conversion the
    // same way the spec fetched by getTask does for freshly launched runs.
    const iface =
      action.spec.case === 'task' ? action.spec.value.taskTemplate?.interface : undefined
    return new RunHandle(this.ctx, runId, action.id, iface, action)
  }

  /** Lists runs for a project. */
  async listRuns(scope: RunScope = {}, limit = 20): Promise<Run[]> {
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

  private handleFromRun(run: Run | undefined, details: TaskDetails): RunHandle {
    const actionId = run?.action?.id
    if (!actionId?.run) {
      throw new FlyteError('CreateRun response did not include a run action id.')
    }
    const initialDetails = run?.action
      ? create(ActionDetailsSchema, {
          id: run.action.id,
          metadata: run.action.metadata,
          status: run.action.status,
        })
      : undefined
    return new RunHandle(this.ctx, actionId.run, actionId, details.interface, initialDetails)
  }

  /**
   * Resolves the org/project/domain for a call. Only project and domain are
   * required: single-tenant deployments have no org, and a hostname with two
   * or fewer labels yields none, so `org` is sent empty there.
   */
  private requireScope(scope: RunScope): {
    org: string
    project: string
    domain: string
  } {
    const project = scope.project ?? this.ctx.config.project
    const domain = scope.domain ?? this.ctx.config.domain
    if (!project || !domain) {
      throw new FlyteConfigError(
        'project and domain are required. Provide them on the call or as defaults ' +
          'via Flyte.init({ project, domain }).',
      )
    }
    return { org: scope.org ?? this.ctx.config.org ?? '', project, domain }
  }
}
