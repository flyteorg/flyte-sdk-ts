/**
 * Human-in-the-loop: run a task that pauses on a condition, then signal it.
 * See examples/README.md · Run: pnpm example:approve
 *
 * Needs a deployed task that awaits a condition. `FLYTE_TASK` should name it;
 * the default matches the e2e fixture in test/e2e/fixtures/sdk_ts_e2e.py.
 */

import { ActionPhase, Flyte, phaseName } from '../src'
import { env } from './_env'

async function main() {
  const flyte = await Flyte.initFromConfig(process.env.FLYTE_CONFIG)
  const taskName = env('FLYTE_TASK') ?? 'sdk_ts_e2e.needs_approval'

  const run = await flyte.run({ task: taskName, inputs: { amount: 42 } })
  console.log(`Started ${run.name} — ${run.url}`)

  // Wait for the task to register its condition and pause on it.
  console.log('Waiting for the approval condition...')
  let condition
  while (!condition) {
    const paused = await run.listConditions()
    condition = paused.find((c) => c.phase === ActionPhase.PAUSED)
    if (!condition) await new Promise((r) => setTimeout(r, 3000))
  }

  console.log(`Condition "${condition.name}": ${condition.prompt}`)
  await condition.signal(true)
  console.log('Approved.')

  const details = await run.wait({ onPhase: (p) => console.log(`  ${phaseName(p)}`) })
  console.log(`Final phase: ${phaseName(details.action?.status?.phase ?? 0)}`)
  console.log('Outputs:', await run.outputs())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
