/**
 * Config-file init + full run lifecycle — no env vars, no API key.
 * See examples/README.md · Auth: from config file · Run: pnpm example:config
 *
 * Reads a flytectl/uctl-style config (e.g. `~/.flyte/config.yaml`), which
 * supplies the endpoint, org, project, and domain. With no `authType` in the
 * file this uses the interactive PKCE browser login and caches the token, so
 * only the first run opens a browser.
 */

import { Flyte, phaseName } from '../src'
import { optionalTaskName } from './_env'

async function main() {
  const flyte = await Flyte.initFromConfig(process.env.FLYTE_CONFIG)
  const { endpoint, org, project, domain } = flyte.config
  console.log(`Connected to ${endpoint} (${org}/${project}/${domain})`)

  // Inspect the task before running it: the resolved version and its interface.
  const task = await flyte.getTask(optionalTaskName())
  console.log(`Task ${task.name} @ ${task.version}`)
  console.log(
    '  inputs:',
    task.interface?.inputs?.variables.map((v) => v.key).join(', ') || '(none)',
  )

  const run = await flyte.run({ task, inputs: { x: 1 } })
  console.log(`Started ${run.name} — ${run.url}`)

  // Stream every status update the control plane sends.
  for await (const { phase, details } of run.watch()) {
    console.log(`  ${phaseName(phase)} (attempt ${details.status?.attempts ?? 0})`)
  }

  console.log('Outputs:', await run.outputs())

  // Drill into the actions the run was made of.
  for (const action of await run.listActions()) {
    console.log(`  action ${action.name} ${phaseName(action.phase)} parent=${action.parent || '-'}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
