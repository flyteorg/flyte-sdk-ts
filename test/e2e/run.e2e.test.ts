/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * End-to-end tests against a real Flyte control plane. See ./README.md for
 * how they connect and which fixture tasks they need.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import {
  ActionPhase,
  ActionType,
  FlyteNotFoundError,
  FlyteRunFailedError,
  isSuccess,
  phaseName,
  TaskDetails,
  type Flyte,
} from '../../src'
import { flyte, task, uniqueRunName } from './setup'

let client: Flyte

beforeAll(async () => {
  client = await flyte()
  // Fail fast with a clear message if the fixtures are not deployed.
  await client.getTask(task('add'))
})

describe('task lookup', () => {
  it('resolves the latest version of a deployed task', async () => {
    const details = await client.getTask(task('add'))
    expect(details).toBeInstanceOf(TaskDetails)
    expect(details.name).toBe(task('add'))
    expect(details.version).toBeTruthy()
    expect(details.project).toBe(client.config.project)
    expect(details.domain).toBe(client.config.domain)
  })

  it('exposes the typed interface and registered defaults', async () => {
    const details = await client.getTask(task('add'))
    expect(details.interface?.inputs?.variables.map((v) => v.key)).toEqual(['x', 'y'])
    expect(details.interface?.outputs?.variables.map((v) => v.key)).toEqual(['o0'])
    // `y` has a default of 10 in the fixture.
    expect(details.defaultInputs.map((p) => p.name)).toContain('y')
  })

  it('reports an unknown task', async () => {
    await expect(client.getTask(task('does_not_exist'))).rejects.toBeInstanceOf(
      FlyteNotFoundError,
    )
  })
})

describe('running a task', () => {
  it('runs, waits, and returns typed outputs', async () => {
    const run = await client.run({ task: task('add'), inputs: { x: 5, y: 7 } })
    expect(run.name).toBeTruthy()
    expect(run.url).toContain(run.name)

    const phases: string[] = []
    const details = await run.wait({ onPhase: (p) => phases.push(phaseName(p)) })

    expect(isSuccess(details.action?.status?.phase ?? ActionPhase.UNSPECIFIED)).toBe(true)
    expect(phases.at(-1)).toMatch(/SUCCEEDED|RECOVERED/)
    expect(await run.outputs()).toEqual({ o0: 12 })
  })

  it('applies the registered default for an omitted input', async () => {
    // `y` defaults to 10, so the result is x + 10 without passing y.
    const run = await client.run({ task: task('add'), inputs: { x: 1 }, wait: true })
    expect(await run.outputs()).toEqual({ o0: 11 })
  })

  it('round-trips every simple scalar type and a collection', async () => {
    const run = await client.run({
      task: task('echo_types'),
      inputs: {
        name: 'hello',
        count: 3,
        ratio: 1.5,
        flag: true,
        tags: ['a', 'b'],
      },
      wait: true,
    })
    expect(await run.outputs()).toEqual({
      o0: { name: 'hello', count: '3', ratio: '1.5', flag: 'True', tags: 'a,b' },
    })
  })

  it('honors an explicit run name', async () => {
    const runName = uniqueRunName('named')
    const run = await client.run({ task: task('add'), inputs: { x: 1 }, runName })
    expect(run.name).toBe(runName)
    await run.wait()
  })

  it('is idempotent when a run name is reused', async () => {
    // Creating a run with an existing name attaches to that run rather than
    // launching a second one: the original outputs come back and the new
    // inputs are ignored. (Control planes that reject the duplicate instead
    // surface a FlyteAlreadyExistsError.)
    const runName = uniqueRunName('idem')
    const first = await client.run({
      task: task('add'),
      inputs: { x: 1, y: 2 },
      runName,
      wait: true,
    })
    expect(await first.outputs()).toEqual({ o0: 3 })

    const second = await client.run({
      task: task('add'),
      inputs: { x: 100, y: 200 },
      runName,
    })

    expect(second.name).toBe(runName)
    expect(await second.outputs()).toEqual({ o0: 3 })
    const named = (await client.listRuns({}, 50)).filter(
      (r) => r.action?.id?.run?.name === runName,
    )
    expect(named).toHaveLength(1)
  })

  it('applies run options', async () => {
    const run = await client.run({
      task: task('add'),
      inputs: { x: 2 },
      labels: { 'ts-sdk-e2e': 'true' },
      annotations: { 'ts-sdk-e2e-note': 'run-options' },
      envVars: { TS_SDK_E2E: '1' },
      overwriteCache: true,
      wait: true,
    })
    const details = await run.details()
    expect(details.runSpec?.labels?.values).toMatchObject({ 'ts-sdk-e2e': 'true' })
    expect(details.runSpec?.annotations?.values).toMatchObject({
      'ts-sdk-e2e-note': 'run-options',
    })
    expect(await run.outputs()).toEqual({ o0: 12 })
  })

  it('accepts a pre-fetched task', async () => {
    const details = await client.getTask(task('add'))
    const run = await client.run({ task: details, inputs: { x: 3, y: 4 }, wait: true })
    expect(await run.outputs()).toEqual({ o0: 7 })
  })

  it('runs with inline inputs when offloading is disabled', async () => {
    const run = await client.run({
      task: task('add'),
      inputs: { x: 8, y: 1 },
      offload: false,
      wait: true,
    })
    expect(await run.outputs()).toEqual({ o0: 9 })
  })

  it('rejects an unknown input before contacting the control plane', async () => {
    await expect(
      client.run({ task: task('add'), inputs: { x: 1, nope: 2 } }),
    ).rejects.toThrow(/Unknown input "nope"/)
  })

  it('rejects a missing required input', async () => {
    await expect(client.run({ task: task('add'), inputs: {} })).rejects.toThrow(
      /Missing required input "x"/,
    )
  })
})

describe('streaming progress', () => {
  it('streams phase updates through to a terminal phase', async () => {
    const run = await client.run({ task: task('add'), inputs: { x: 1 } })

    const phases: ActionPhase[] = []
    for await (const update of run.watch()) {
      phases.push(update.phase)
    }

    expect(phases.length).toBeGreaterThan(0)
    expect(isSuccess(phases.at(-1)!)).toBe(true)
    // Every server update is surfaced, so a phase can repeat while its
    // sub-state changes; the sequence never goes backwards.
    const ranks = phases.map(phaseRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('stops watching when the caller aborts', async () => {
    const run = await client.run({ task: task('parent'), inputs: { n: 3 } })
    const controller = new AbortController()

    const phases: ActionPhase[] = []
    for await (const update of run.watch({ signal: controller.signal })) {
      phases.push(update.phase)
      controller.abort()
    }

    expect(phases.length).toBeGreaterThanOrEqual(1)
    await run.abort('e2e: done watching').catch(() => {})
  })
})

describe('failures', () => {
  it('reports the failure message from a failed run', async () => {
    const run = await client.run({
      task: task('always_fails'),
      inputs: { message: 'e2e expected failure' },
    })

    await expect(run.wait()).rejects.toBeInstanceOf(FlyteRunFailedError)

    // With throwOnFailure disabled the terminal details are inspectable.
    const details = await run.wait({ throwOnFailure: false })
    expect(details.action?.status?.phase).toBe(ActionPhase.FAILED)

    const rootAction = await run.action('a0')
    expect(rootAction.errorInfo?.message).toMatch(/e2e expected failure/)
  })

  it('refuses to return outputs for a failed run', async () => {
    const run = await client.run({
      task: task('always_fails'),
      inputs: { message: 'no outputs here' },
    })
    await run.wait({ throwOnFailure: false })
    await expect(run.outputs()).rejects.toBeInstanceOf(FlyteRunFailedError)
  })
})

describe('actions', () => {
  it('lists the actions of a run that fans out to children', async () => {
    const run = await client.run({ task: task('parent'), inputs: { n: 3 }, wait: true })

    const actions = await run.listActions()

    // The root action plus one child per iteration.
    expect(actions.length).toBeGreaterThanOrEqual(4)
    const root = actions.find((a) => a.name === 'a0')
    expect(root).toBeDefined()
    expect(root!.actionType).toBe(ActionType.TASK)
    expect(root!.parent).toBe('')

    const children = actions.filter((a) => a.parent === 'a0')
    expect(children.length).toBeGreaterThanOrEqual(3)
    for (const child of actions) {
      expect(isSuccess(child.phase)).toBe(true)
    }
    // parent sums add(i, 1) for i in 0..2 = 1 + 2 + 3.
    expect(await run.outputs()).toEqual({ o0: 6 })
  })

  it('fetches one action with full details', async () => {
    const run = await client.run({ task: task('add'), inputs: { x: 1 }, wait: true })

    const action = await run.action('a0')

    expect(action.name).toBe('a0')
    expect(action.runName).toBe(run.name)
    expect(isSuccess(action.phase)).toBe(true)
    expect(action.attempts).toBeGreaterThanOrEqual(1)
    expect(action.attemptDetails.length).toBeGreaterThanOrEqual(1)
    // An already-terminal action needs no watching.
    await expect(action.wait()).resolves.toBeDefined()
  })

  it('reports an unknown action', async () => {
    const run = await client.run({ task: task('add'), inputs: { x: 1 }, wait: true })
    await expect(run.action('no-such-action')).rejects.toBeInstanceOf(FlyteNotFoundError)
  })
})

describe('conditions', () => {
  it('signals a paused condition and lets the run finish', async () => {
    const run = await client.run({ task: task('needs_approval'), inputs: { amount: 42 } })

    // Wait for the condition action to appear and pause.
    const condition = await pollFor(
      async () => {
        const conditions = await run.listConditions()
        return conditions.find((c) => c.phase === ActionPhase.PAUSED)
      },
      { timeoutMs: 5 * 60_000, intervalMs: 3000 },
    )

    expect(condition.actionType).toBe(ActionType.CONDITION)
    expect(condition.prompt).toMatch(/Approve spending 42/)
    expect(condition.description).toBe('Approve or reject the spend')

    await condition.signal(true)

    await run.wait({ timeoutMs: 5 * 60_000 })
    expect(await run.outputs()).toEqual({ o0: 'approved=True amount=42' })

    const signalled = await run.condition(condition.name)
    expect(isSuccess(signalled.phase)).toBe(true)
    expect(signalled.signalInfo).toBeDefined()
  })
})

describe('attaching to existing runs', () => {
  it('lists runs and re-attaches by name', async () => {
    const launched = await client.run({ task: task('add'), inputs: { x: 4, y: 4 }, wait: true })

    const runs = await client.listRuns({}, 20)
    expect(runs.length).toBeGreaterThan(0)

    // A handle attached by name knows nothing up front, so this also covers
    // discovering the task interface from the run's root action.
    const attached = await client.getRun(launched.name)
    expect(attached.name).toBe(launched.name)
    expect(isSuccess(await attached.phase())).toBe(true)
    expect(await attached.outputs()).toEqual({ o0: 8 })
  })
})

describe('aborting', () => {
  it('aborts a running run', async () => {
    const run = await client.run({ task: task('parent'), inputs: { n: 50 } })

    await run.abort('e2e: abort test')

    const details = await run.wait({ throwOnFailure: false, timeoutMs: 5 * 60_000 })
    expect(details.action?.status?.phase).toBe(ActionPhase.ABORTED)
    const rootAction = await run.action('a0')
    expect(rootAction.abortInfo?.reason).toMatch(/e2e: abort test/)
  })
})

/** Orders the phases a healthy run passes through, for monotonicity checks. */
function phaseRank(phase: ActionPhase): number {
  const order = [
    ActionPhase.UNSPECIFIED,
    ActionPhase.QUEUED,
    ActionPhase.WAITING_FOR_RESOURCES,
    ActionPhase.INITIALIZING,
    ActionPhase.RUNNING,
    ActionPhase.PAUSED,
    ActionPhase.SUCCEEDED,
  ]
  const rank = order.indexOf(phase)
  if (rank < 0) throw new Error(`unexpected phase in a successful run: ${phaseName(phase)}`)
  return rank
}

/** Polls `fn` until it returns a value, or throws when the timeout elapses. */
async function pollFor<T>(
  fn: () => Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${options.timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, options.intervalMs))
  }
}
