import { config as loadDotenv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const examplesDir = path.dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: path.resolve(examplesDir, '../.env') })

/** Shared env helpers for Node examples — no hardcoded endpoints or orgs. */

export function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim().length > 0 ? v.trim() : undefined
}

export function requireEnv(name: string): string {
  const v = env(name)
  if (!v) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill in values.`)
  }
  return v
}

export interface ExampleScope {
  endpoint: string
  org: string
  project: string
  domain: string
}

/** Scope used by integration examples (from env). */
export function exampleScope(): ExampleScope {
  return {
    endpoint: requireEnv('FLYTE_ENDPOINT'),
    org: requireEnv('FLYTE_ORG'),
    project: requireEnv('FLYTE_PROJECT'),
    domain: requireEnv('FLYTE_DOMAIN'),
  }
}

export function optionalTaskName(): string {
  return env('FLYTE_TASK') ?? 'my_task'
}
