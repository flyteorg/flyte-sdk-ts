/**
 * Full client_credentials flow — run, wait, fetch outputs.
 * See examples/README.md · Auth: client_credentials · Run: pnpm example:quickstart
 */

import { Flyte, phaseName } from '../src'
import { exampleScope, optionalTaskName, requireEnv } from './_env'

async function main() {
  requireEnv('FLYTE_API_KEY')
  const scope = exampleScope()

  const flyte = await Flyte.init({
    endpoint: scope.endpoint,
    org: scope.org,
    auth: { apiKey: process.env.FLYTE_API_KEY },
  })

  const run = await flyte.run({
    task: optionalTaskName(),
    project: scope.project,
    domain: scope.domain,
    inputs: { x: 1, name: 'hello' },
  })
  console.log(`Started run ${run.name}`)
  console.log(`Console: ${run.url}`)

  const details = await run.wait({
    intervalMs: 2000,
    onPhase: (p) => console.log(`  phase: ${phaseName(p)}`),
  })
  console.log(`Final phase: ${phaseName(details.action?.status?.phase ?? 0)}`)

  const { outputs } = await run.outputs()
  console.log('Outputs:', outputs?.literals.map((l) => l.name))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
