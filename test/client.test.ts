/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientContext } from '../src/context'

// Flyte.init builds its own transport; swap in a fake context so the client's
// launch logic can be tested without a control plane, and stub the anonymous
// auth-header discovery so no network call is attempted.
const contextMock = vi.hoisted(() => ({ current: undefined as ClientContext | undefined }))
vi.mock('../src/context', () => ({
  // Keep the fake services but honor the config the client resolved, the same
  // way the real createContext does.
  createContext: (config: ClientContext['config']) => ({ ...contextMock.current, config }),
}))
vi.mock('../src/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth')>()),
  discoverPublicClientConfig: async () => ({ authorizationMetadataKey: 'authorization' }),
}))

const { Flyte } = await import('../src/client')
const { FlyteAlreadyExistsError, FlyteConfigError } = await import('../src/errors')
const { OffloadedInputDataSchema } = await import('../src/gen/flyteidl2/common/run_pb')
const { TaskTemplateSchema } = await import('../src/gen/flyteidl2/core/tasks_pb')
const { TaskDetailsSchema, TaskIdentifierSchema, TaskSpecSchema } = await import(
  '../src/gen/flyteidl2/task/task_definition_pb'
)
const { ActionIdentifierSchema, RunIdentifierSchema } = await import(
  '../src/gen/flyteidl2/common/identifier_pb'
)
const {
  ActionDetailsSchema,
  ActionSchema,
  ActionStatusSchema,
  RunDetailsSchema,
  RunSchema,
  RunSource,
} = await import('../src/gen/flyteidl2/workflow/run_definition_pb')
const { SimpleType } = await import('../src/gen/flyteidl2/core/types_pb')
const { ActionPhase } = await import('../src/phase')
const {
  callArg,
  defaultParameter,
  fakeContext,
  intLiteral,
  simpleType,
  typedInterface,
  variable,
  variableMap,
} = await import('./helpers/fakeContext')

const INT = simpleType(SimpleType.INTEGER)
const RUN_ID = create(RunIdentifierSchema, {
  org: 'acme',
  project: 'my-project',
  domain: 'development',
  name: 'run-1',
})
const ACTION_ID = create(ActionIdentifierSchema, { run: RUN_ID, name: 'a0' })

function taskDetailsPb(inputs = variableMap(variable('x', INT))) {
  return create(TaskDetailsSchema, {
    taskId: create(TaskIdentifierSchema, {
      org: 'acme',
      project: 'my-project',
      domain: 'development',
      name: 'my_env.my_task',
      version: 'v1',
    }),
    spec: create(TaskSpecSchema, {
      taskTemplate: create(TaskTemplateSchema, { interface: typedInterface(inputs) }),
    }),
  })
}

function createdRun() {
  return create(RunSchema, {
    action: create(ActionSchema, {
      id: ACTION_ID,
      status: create(ActionStatusSchema, { phase: ActionPhase.QUEUED }),
    }),
  })
}

/** Wires a fake context with the task + run services a launch needs. */
function launchFixture(
  overrides: {
    taskDetails?: ReturnType<typeof taskDetailsPb>
    uploadInputs?: ReturnType<typeof vi.fn>
    createRun?: ReturnType<typeof vi.fn>
  } = {},
) {
  const getTaskDetails = vi.fn(async () => ({
    details: overrides.taskDetails ?? taskDetailsPb(),
  }))
  const uploadInputs =
    overrides.uploadInputs ??
    vi.fn(async () => ({
      offloadedInputData: create(OffloadedInputDataSchema, { uri: 's3://inputs.pb' }),
    }))
  const createRun = overrides.createRun ?? vi.fn(async () => ({ run: createdRun() }))

  const { ctx, calls } = fakeContext({
    services: {
      task: { getTaskDetails, listVersions: async () => ({ versions: [{ version: 'v1' }] }) } as never,
      dataproxy: { uploadInputs } as never,
      run: { createRun } as never,
    },
  })
  contextMock.current = ctx
  return { ctx, calls, getTaskDetails, uploadInputs, createRun }
}

const INIT = { endpoint: 'acme.example.com', org: 'acme' }

const API_KEY = Buffer.from('acme.example.com:cid:secret:acme').toString('base64')

/** Writes a config file to a temp dir and returns its path. */
async function writeConfig(contents: string): Promise<string> {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'flyte-init-'))
  const path = join(dir, 'config.yaml')
  await writeFile(path, contents)
  return path
}

describe('Flyte.init', () => {
  beforeEach(() => {
    contextMock.current = undefined
  })

  it('exposes the resolved config', async () => {
    launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'p', domain: 'd' })
    expect(flyte.config).toMatchObject({
      endpoint: 'https://acme.example.com',
      org: 'acme',
      project: 'p',
      domain: 'd',
    })
  })

  it('merges overrides on top of a config file', async () => {
    launchFixture()
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'flyte-init-'))
    const path = join(dir, 'config.yaml')
    await writeFile(
      path,
      'admin:\n  endpoint: dns:///file.example.com\ntask:\n  org: file-org\n  project: file-project\n  domain: development\n',
    )

    const flyte = await Flyte.initFromConfig(path, { project: 'override-project' })

    expect(flyte.config).toMatchObject({
      endpoint: 'https://file.example.com',
      org: 'file-org',
      project: 'override-project',
      domain: 'development',
    })
  })

  it('reports a missing config file path clearly', async () => {
    await expect(Flyte.initFromConfig('/definitely/not/here.yaml')).rejects.toThrow(
      /Failed to read config file/,
    )
  })

  it('lets override credentials win over the config file auth mode', async () => {
    // The file defaults to interactive PKCE. A CI process passing an API key
    // must not be dragged into a browser login it can never complete.
    launchFixture()
    const path = await writeConfig(
      'admin:\n  endpoint: dns:///file.example.com\ntask:\n  org: o\n  project: p\n  domain: d\n',
    )

    const flyte = await Flyte.initFromConfig(path, {
      auth: { apiKey: API_KEY },
    })

    expect(flyte.config.auth.mode).toBe('client_credentials')
  })

  it('keeps the config file auth mode when overrides carry no credentials', async () => {
    launchFixture()
    const path = await writeConfig(
      'admin:\n  endpoint: dns:///file.example.com\ntask:\n  org: o\n  project: p\n  domain: d\n',
    )

    const flyte = await Flyte.initFromConfig(path, { project: 'other' })

    expect(flyte.config.auth.mode).toBe('pkce')
  })

  it('honors an explicit override mode', async () => {
    launchFixture()
    const path = await writeConfig(
      'admin:\n  endpoint: dns:///file.example.com\n  authType: Pkce\ntask:\n  org: o\n  project: p\n  domain: d\n',
    )

    const flyte = await Flyte.initFromConfig(path, {
      auth: { mode: 'device_flow' },
    })

    expect(flyte.config.auth.mode).toBe('device_flow')
  })
})

describe('Flyte.run', () => {
  beforeEach(() => {
    contextMock.current = undefined
  })

  it('launches with offloaded inputs and returns a handle', async () => {
    const { createRun, uploadInputs } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    const run = await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })

    expect(run.name).toBe('run-1')
    expect(uploadInputs).toHaveBeenCalledTimes(1)
    const req = callArg<{
      inputWrapper: { case: string }
      task: { case: string; value: { name: string; version: string } }
      id: { case: string; value: { name: string } }
      source: number
    }>(createRun)
    expect(req.inputWrapper.case).toBe('offloadedInputData')
    expect(req.task).toMatchObject({ case: 'taskId' })
    expect(req.task.value).toMatchObject({ name: 'my_env.my_task', version: 'v1' })
    // Without an explicit run name, the server generates one from the project.
    expect(req.id.case).toBe('projectId')
    // The SDK is normally embedded in a service or web app, so runs are
    // attributed to the web source unless the caller says otherwise.
    expect(req.source).toBe(RunSource.WEB)
  })

  it('attributes runs to the configured source', async () => {
    const { createRun } = launchFixture()
    const flyte = await Flyte.init({
      ...INIT,
      project: 'my-project',
      domain: 'development',
      runSource: 'cli',
    })

    await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })

    expect(callArg<{ source: number }>(createRun).source).toBe(RunSource.CLI)
  })

  it('targets a specific run identifier when a run name is given', async () => {
    const { createRun, uploadInputs } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 }, runName: 'my-run-001' })

    const req = callArg<{ id: { case: string; value: { name: string } } }>(createRun)
    expect(req.id.case).toBe('runId')
    expect(req.id.value.name).toBe('my-run-001')
    // The upload targets the same identifier, so inputs land under the run.
    const upload = callArg<{ id: { case: string } }>(uploadInputs)
    expect(upload.id.case).toBe('runId')
  })

  it('sends inline inputs when offloading is disabled', async () => {
    const { createRun, uploadInputs } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 }, offload: false })

    expect(uploadInputs).not.toHaveBeenCalled()
    const req = callArg<{ inputWrapper: { case: string } }>(createRun)
    expect(req.inputWrapper.case).toBe('inputs')
  })

  it('falls back to inline inputs on control planes without a data proxy', async () => {
    const uploadInputs = vi.fn(async () => {
      throw new ConnectError('no data proxy', Code.Unimplemented)
    })
    const { createRun } = launchFixture({ uploadInputs })
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })

    const req = callArg<{ inputWrapper: { case: string } }>(createRun)
    expect(req.inputWrapper.case).toBe('inputs')
  })

  it('propagates other upload failures', async () => {
    const uploadInputs = vi.fn(async () => {
      throw new ConnectError('disk full', Code.ResourceExhausted)
    })
    launchFixture({ uploadInputs })
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await expect(flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })).rejects.toThrow(
      /disk full/,
    )
  })

  it('reports a duplicate run name clearly', async () => {
    const createRun = vi.fn(async () => {
      throw new ConnectError('exists', Code.AlreadyExists)
    })
    launchFixture({ createRun })
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    const promise = flyte.run({ task: 'my_env.my_task', inputs: { x: 1 }, runName: 'dupe' })
    await expect(promise).rejects.toBeInstanceOf(FlyteAlreadyExistsError)
    await expect(
      flyte.run({ task: 'my_env.my_task', inputs: { x: 1 }, runName: 'dupe' }),
    ).rejects.toThrow(/A run named "dupe" already exists in my-project\/development/)
  })

  it('passes run options through to the run spec', async () => {
    const { createRun } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await flyte.run({
      task: 'my_env.my_task',
      inputs: { x: 1 },
      envVars: { LOG_LEVEL: 'DEBUG' },
      labels: { team: 'ml' },
      overwriteCache: true,
      queue: 'gpu',
      maxActionConcurrency: 2,
    })

    const req = callArg<{
      runSpec: {
        envs?: { values: { key: string; value: string }[] }
        labels?: { values: Record<string, string> }
        overwriteCache: boolean
        queue: string
        maxActionConcurrency: number
      }
    }>(createRun)
    expect(req.runSpec.envs?.values).toEqual([
      { $typeName: 'flyteidl2.core.KeyValuePair', key: 'LOG_LEVEL', value: 'DEBUG' },
    ])
    expect(req.runSpec.labels?.values).toEqual({ team: 'ml' })
    expect(req.runSpec.overwriteCache).toBe(true)
    expect(req.runSpec.queue).toBe('gpu')
    expect(req.runSpec.maxActionConcurrency).toBe(2)
  })

  it('reuses a pre-fetched TaskDetails instead of looking the task up again', async () => {
    const { getTaskDetails } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    const task = await flyte.getTask('my_env.my_task')
    getTaskDetails.mockClear()
    await flyte.run({ task, inputs: { x: 1 } })

    expect(getTaskDetails).not.toHaveBeenCalled()
  })

  it('validates inputs before creating the run', async () => {
    const { createRun } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await expect(
      flyte.run({ task: 'my_env.my_task', inputs: { x: 1, typo: 2 } }),
    ).rejects.toThrow(/Unknown input "typo"/)
    expect(createRun).not.toHaveBeenCalled()
  })

  it('applies registered defaults for omitted inputs', async () => {
    const taskDetails = create(TaskDetailsSchema, {
      taskId: create(TaskIdentifierSchema, { name: 'my_env.my_task', version: 'v1' }),
      spec: create(TaskSpecSchema, {
        taskTemplate: create(TaskTemplateSchema, {
          interface: typedInterface(variableMap(variable('retries', INT))),
        }),
        defaultInputs: [defaultParameter('retries', INT, intLiteral(3))],
      }),
    })
    const { uploadInputs } = launchFixture({ taskDetails })
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    await flyte.run({ task: 'my_env.my_task' })

    const upload = callArg<{ inputs: { literals: { name: string }[] } }>(uploadInputs)
    expect(upload.inputs.literals.map((l) => l.name)).toEqual(['retries'])
  })

  it('falls back to the client project and domain', async () => {
    const { createRun } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'default-project', domain: 'staging' })

    await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })

    const req = callArg<{ id: { value: { name: string; domain: string } } }>(createRun)
    expect(req.id.value).toMatchObject({ name: 'default-project', domain: 'staging' })
  })

  it('lets the call override the client project and domain', async () => {
    const { createRun } = launchFixture()
    const flyte = await Flyte.init({ ...INIT, project: 'default-project', domain: 'staging' })

    await flyte.run({
      task: 'my_env.my_task',
      inputs: { x: 1 },
      project: 'other',
      domain: 'production',
    })

    const req = callArg<{ id: { value: { name: string; domain: string } } }>(createRun)
    expect(req.id.value).toMatchObject({ name: 'other', domain: 'production' })
  })

  it('requires a project and domain from somewhere', async () => {
    launchFixture()
    const flyte = await Flyte.init(INIT)

    await expect(flyte.run({ task: 'my_env.my_task' })).rejects.toBeInstanceOf(FlyteConfigError)
    await expect(flyte.run({ task: 'my_env.my_task' })).rejects.toThrow(
      /project and domain are required/,
    )
  })

  it('runs without an org on single-tenant deployments', async () => {
    // A two-label hostname yields no org, and none is configured. Single-
    // tenant and OSS deployments have no org, so this must still work.
    const { createRun } = launchFixture()
    const flyte = await Flyte.init({
      endpoint: 'example.com',
      project: 'p',
      domain: 'd',
    })

    await flyte.run({ task: 'my_env.my_task', inputs: { x: 1 } })

    const req = callArg<{ id: { value: { organization: string } } }>(createRun)
    expect(req.id.value.organization).toBe('')
  })
})

describe('Flyte.getRun', () => {
  beforeEach(() => {
    contextMock.current = undefined
  })

  it('attaches to an existing run by name', async () => {
    const getRunDetails = vi.fn(async () => ({
      details: create(RunDetailsSchema, {
        action: create(ActionDetailsSchema, {
          id: ACTION_ID,
          status: create(ActionStatusSchema, { phase: ActionPhase.SUCCEEDED }),
        }),
      }),
    }))
    const { ctx } = fakeContext({ services: { run: { getRunDetails } as never } })
    contextMock.current = ctx
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    const run = await flyte.getRun('run-1')

    expect(run.name).toBe('run-1')
    expect(callArg(getRunDetails)).toMatchObject({
      runId: { name: 'run-1', project: 'my-project', domain: 'development', org: 'acme' },
    })
  })

  it('requires a run name', async () => {
    const { ctx } = fakeContext()
    contextMock.current = ctx
    const flyte = await Flyte.init({ ...INIT, project: 'p', domain: 'd' })

    await expect(flyte.getRun('')).rejects.toThrow(/Run name is required/)
  })

  it('reports a run whose details carry no root action', async () => {
    const getRunDetails = vi.fn(async () => ({ details: create(RunDetailsSchema, {}) }))
    const { ctx } = fakeContext({ services: { run: { getRunDetails } as never } })
    contextMock.current = ctx
    const flyte = await Flyte.init({ ...INIT, project: 'p', domain: 'd' })

    await expect(flyte.getRun('run-1')).rejects.toThrow(/has no root action id/)
  })
})

describe('Flyte.listRuns', () => {
  beforeEach(() => {
    contextMock.current = undefined
  })

  it('scopes the listing to the project and passes the limit', async () => {
    const listRuns = vi.fn(async () => ({ runs: [createdRun()] }))
    const { ctx } = fakeContext({ services: { run: { listRuns } as never } })
    contextMock.current = ctx
    const flyte = await Flyte.init({ ...INIT, project: 'my-project', domain: 'development' })

    const runs = await flyte.listRuns({}, 5)

    expect(runs).toHaveLength(1)
    const req = callArg<{
      request: { limit: number }
      scopeBy: { case: string; value: { name: string; domain: string } }
    }>(listRuns)
    expect(req.request.limit).toBe(5)
    expect(req.scopeBy.value).toMatchObject({ name: 'my-project', domain: 'development' })
  })
})
