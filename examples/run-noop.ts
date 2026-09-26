/**
 * Minimal client_credentials example — run a task and wait.
 * See examples/README.md · Auth: client_credentials · Run: pnpm example:run
 */
import { Flyte, phaseName } from '../src'
import { exampleScope, optionalTaskName, requireEnv } from './_env'

async function main() {
  const scope = exampleScope()
  const task = optionalTaskName()
  requireEnv('FLYTE_API_KEY')

  const flyte = await Flyte.init({
    endpoint: scope.endpoint,
    org: scope.org,
    auth: { apiKey: process.env.FLYTE_API_KEY },
  })

  console.log(`Running ${task} in ${scope.project}/${scope.domain}...`)
  const run = await flyte.run({
    task,
    project: scope.project,
    domain: scope.domain,
    inputs: { x: 1 },
  })
  console.log('run:', run.name, run.url)
  const details = await run.wait({
    timeoutMs: 10 * 60_000,
    onPhase: (p) => console.log('  phase:', phaseName(p)),
  })
  console.log('final:', phaseName(details.action?.status?.phase ?? 0))
  const outputs = await run.outputs()
  for (const [name, value] of Object.entries(outputs)) {
    console.log(' ', name, '=', value)
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
