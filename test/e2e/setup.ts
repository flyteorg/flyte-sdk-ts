/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Shared client setup for the end-to-end tests. See ./README.md. */

import { Flyte } from '../../src'

/** Task environment the fixture tasks are deployed under. */
export const ENV = process.env.FLYTE_E2E_ENV ?? 'sdk_ts_e2e'

/** Fully qualified name of a fixture task. */
export const task = (name: string): string => `${ENV}.${name}`

let client: Promise<Flyte> | undefined

/**
 * Connects using `FLYTE_API_KEY` when set (headless, for CI) and otherwise a
 * flytectl/uctl-style config file. Memoized so the whole suite shares one
 * client and one token.
 */
export function flyte(): Promise<Flyte> {
  client ??= process.env.FLYTE_API_KEY
    ? Flyte.init({
        auth: { apiKey: process.env.FLYTE_API_KEY },
        project: process.env.FLYTE_PROJECT,
        domain: process.env.FLYTE_DOMAIN,
      })
    : Flyte.initFromConfig(process.env.FLYTE_CONFIG)
  return client
}

/** A run name unique to this process, so parallel suites never collide. */
export function uniqueRunName(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `ts-e2e-${prefix}-${suffix}`
}
