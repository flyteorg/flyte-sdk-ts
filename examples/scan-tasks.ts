/**
 * List deployed tasks and their required inputs (client_credentials).
 * See examples/README.md · Run: pnpm example:scan-tasks
 */
import { create } from '@bufbuild/protobuf'
import { Flyte } from '../src'
import { ProjectIdentifierSchema } from '../src/gen/flyteidl2/common/identifier_pb'
import { ListTasksRequestSchema } from '../src/gen/flyteidl2/task/task_service_pb'
import { TaskSpecToLaunchFormJsonRequestSchema } from '../src/gen/flyteidl2/workflow/translator_service_pb'
import { exampleScope, requireEnv } from './_env'

async function main() {
  requireEnv('FLYTE_API_KEY')
  const scope = exampleScope()
  const flyte = await Flyte.init({
    endpoint: scope.endpoint,
    org: scope.org,
    auth: { apiKey: process.env.FLYTE_API_KEY },
  })
  const tasksRes = await flyte.services.task.listTasks(
    create(ListTasksRequestSchema, {
      request: { limit: 30 },
      scopeBy: {
        case: 'projectId',
        value: create(ProjectIdentifierSchema, {
          organization: scope.org,
          domain: scope.domain,
          name: scope.project,
        }),
      },
    }),
  )
  for (const t of tasksRes.tasks) {
    const id = t.taskId!
    const details = await flyte.services.task.getTaskDetails({ taskId: id })
    const form = await flyte.services.translator.taskSpecToLaunchFormJson(
      create(TaskSpecToLaunchFormJsonRequestSchema, {
        taskSpec: details.details?.spec,
      }),
    )
    const json = form.json as Record<string, unknown> | undefined
    const required = (json?.required ?? []) as string[]
    console.log(
      id.name,
      '| required:',
      required.length ? required.join(',') : '(none)',
    )
  }
}
main()
