/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * flytectl/uctl-style YAML config file support (Node only), e.g.
 * `~/.flyte/config.yaml`:
 *
 * ```yaml
 * admin:
 *   endpoint: dns:///acme.example.com
 *   authType: Pkce
 * task:
 *   org: acme
 *   project: my-project
 *   domain: development
 * ```
 */

import { parse as parseYaml } from 'yaml'

import type { AuthMode, FlyteConfig } from './config'
import { FlyteConfigError } from './errors'

/** `admin.authType` values accepted in config files (Python/Go SDK names). */
const AUTH_TYPE_TO_MODE: Record<string, AuthMode> = {
  pkce: 'pkce',
  clientsecret: 'client_credentials',
  deviceflow: 'device_flow',
  externalcommand: 'external_command',
}

interface FileConfig {
  admin?: {
    endpoint?: string
    insecure?: boolean
    insecureSkipVerify?: boolean
    caCertFilePath?: string
    authType?: string
    clientId?: string
    clientSecretLocation?: string
    clientSecretEnvVar?: string
    command?: string[]
    proxyCommand?: string[]
    scopes?: string[]
    audience?: string
  }
  task?: {
    org?: string
    project?: string
    domain?: string
  }
}

/**
 * Parses flytectl/uctl-style YAML config content into a {@link FlyteConfig}.
 * Exposed for testing; most callers want {@link loadConfigFile} or
 * `Flyte.initFromConfig`.
 */
export function parseConfigFile(content: string, source = 'config'): FlyteConfig {
  let fc: FileConfig
  try {
    fc = (parseYaml(content) ?? {}) as FileConfig
  } catch (cause) {
    throw new FlyteConfigError(`Failed to parse config file ${source}: ${String(cause)}`)
  }

  const admin = fc.admin ?? {}
  const task = fc.task ?? {}

  const config: FlyteConfig = {
    endpoint: admin.endpoint,
    insecure: admin.insecure,
    insecureSkipVerify: admin.insecureSkipVerify,
    caCertFilePath: admin.caCertFilePath,
    org: task.org,
    project: task.project,
    domain: task.domain,
    auth: {},
  }

  const auth = config.auth as NonNullable<FlyteConfig['auth']>
  if (admin.authType) {
    const mode = AUTH_TYPE_TO_MODE[admin.authType.toLowerCase()]
    if (!mode) {
      throw new FlyteConfigError(
        `Unsupported authType "${admin.authType}" in ${source} ` +
          '(valid: Pkce, ClientSecret, DeviceFlow, ExternalCommand).',
      )
    }
    auth.mode = mode
  }
  if (admin.clientId) auth.clientId = admin.clientId
  if (admin.clientSecretLocation) auth.clientSecretLocation = admin.clientSecretLocation
  if (admin.clientSecretEnvVar) auth.clientSecretEnvVar = admin.clientSecretEnvVar
  if (admin.command && admin.command.length > 0) auth.command = admin.command
  if (admin.proxyCommand && admin.proxyCommand.length > 0) {
    auth.proxyCommand = admin.proxyCommand
  }
  if (admin.scopes && admin.scopes.length > 0) auth.scopes = admin.scopes
  if (admin.audience) auth.audience = admin.audience

  // No explicit authType: client credentials present → client_credentials;
  // a command → external_command; otherwise interactive PKCE, matching the
  // Go and Python SDK defaults for config-file initialization.
  if (!auth.mode) {
    if (auth.clientId && (auth.clientSecretLocation || auth.clientSecretEnvVar)) {
      auth.mode = 'client_credentials'
    } else if (auth.command) {
      auth.mode = 'external_command'
    } else {
      auth.mode = 'pkce'
    }
  }

  return config
}

/** Reads a flytectl/uctl-style YAML config file into a {@link FlyteConfig}. */
export async function loadConfigFile(path: string): Promise<FlyteConfig> {
  const fs = await import('node:fs/promises')
  let content: string
  try {
    content = await fs.readFile(path, 'utf8')
  } catch (cause) {
    throw new FlyteConfigError(`Failed to read config file ${path}: ${String(cause)}`)
  }
  return parseConfigFile(content, path)
}

/**
 * Returns the first existing config file, using the same search order as the
 * Go and Python SDKs:
 *
 * `./config.yaml`, `./.flyte/config.yaml`, `<git root>/.flyte/config.yaml`,
 * `$UCTL_CONFIG`, `$FLYTECTL_CONFIG`, `~/.union/config.yaml`,
 * `~/.flyte/config.yaml`.
 *
 * Returns `undefined` when nothing is found.
 */
export async function findConfigPath(): Promise<string | undefined> {
  const [fs, path, os] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
    import('node:os'),
  ])

  const candidates: string[] = []
  const cwd = process.cwd()
  candidates.push(path.join(cwd, 'config.yaml'), path.join(cwd, '.flyte', 'config.yaml'))

  const gitRoot = await findGitRoot(cwd)
  if (gitRoot && gitRoot !== cwd) {
    candidates.push(path.join(gitRoot, '.flyte', 'config.yaml'))
  }

  for (const envVar of ['UCTL_CONFIG', 'FLYTECTL_CONFIG']) {
    const p = process.env[envVar]
    if (p) candidates.push(p)
  }

  const home = os.homedir()
  if (home) {
    candidates.push(
      path.join(home, '.union', 'config.yaml'),
      path.join(home, '.flyte', 'config.yaml'),
    )
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  return undefined
}

async function findGitRoot(start: string): Promise<string | undefined> {
  const [fs, path] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ])
  let dir = start
  for (;;) {
    try {
      await fs.stat(path.join(dir, '.git'))
      return dir
    } catch {
      // not here; walk up
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
