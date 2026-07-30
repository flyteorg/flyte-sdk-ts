/**
 * Browser-side session test runner — bundled and injected on the Flyte origin.
 * Uses the real SDK + generated Connect clients, not raw fetch.
 */
import { create } from '@bufbuild/protobuf'

import { Flyte, createBrowserAuth, phaseName } from '../src'
import { ProjectIdentifierSchema } from '../src/gen/flyteidl2/common/identifier_pb'
import { ListTasksRequestSchema } from '../src/gen/flyteidl2/task/task_service_pb'

export interface SessionTestResult {
  tasks: string[]
  runName: string
  runUrl: string
  finalPhase: string
}

export async function runSessionTest(config: {
  endpoint: string
  org: string
  project: string
  domain: string
}): Promise<SessionTestResult> {
  const { endpoint, org, project, domain } = config

  const flyte = await Flyte.init({
    endpoint,
    org,
    auth: createBrowserAuth({
      endpoint,
      loginRedirectPath: '/v2/projects',
    }),
  })

  const listRes = await flyte.services.task.listTasks(
    create(ListTasksRequestSchema, {
      request: { limit: 3 },
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
  const tasks = listRes.tasks.map((t) => t.taskId?.name).filter(Boolean) as string[]

  const run = await flyte.run({
    task: 'reuse_concurrency.noop',
    project,
    domain,
    inputs: { x: 1 },
  })

  const details = await run.wait({
    intervalMs: 2000,
    timeoutMs: 5 * 60_000,
    onPhase: (p) => console.log('[session test] phase:', phaseName(p)),
  })

  return {
    tasks,
    runName: run.name,
    runUrl: run.url,
    finalPhase: phaseName(details.action?.status?.phase ?? 0),
  }
}

// IIFE entrypoint for Playwright injection
declare global {
  interface Window {
    __flyteSessionTest?: typeof runSessionTest
  }
}
if (typeof window !== 'undefined') {
  window.__flyteSessionTest = runSessionTest
}
