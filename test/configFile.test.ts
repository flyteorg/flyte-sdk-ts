/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { findConfigPath, loadConfigFile, parseConfigFile } from '../src/configFile'
import { FlyteConfigError } from '../src/errors'

describe('parseConfigFile', () => {
  it('maps a flytectl/uctl-style config to FlyteConfig', () => {
    const config = parseConfigFile(`
admin:
  endpoint: dns:///demo.hosted.unionai.cloud
image:
  builder: remote
task:
  org: demo
  project: flytesnacks
  domain: development
`)
    expect(config).toMatchObject({
      endpoint: 'dns:///demo.hosted.unionai.cloud',
      org: 'demo',
      project: 'flytesnacks',
      domain: 'development',
    })
  })

  it('defaults to the interactive PKCE flow when no credentials are configured', () => {
    const config = parseConfigFile('admin:\n  endpoint: dns:///acme.example.com\n')
    expect(config.auth?.mode).toBe('pkce')
  })

  it('maps each authType to its auth mode', () => {
    const modeFor = (authType: string) =>
      parseConfigFile(`admin:\n  endpoint: e.example.com\n  authType: ${authType}\n`).auth?.mode
    expect(modeFor('Pkce')).toBe('pkce')
    expect(modeFor('ClientSecret')).toBe('client_credentials')
    expect(modeFor('DeviceFlow')).toBe('device_flow')
    expect(modeFor('ExternalCommand')).toBe('external_command')
    // Names are matched case-insensitively, as flytectl writes them variously.
    expect(modeFor('clientsecret')).toBe('client_credentials')
  })

  it('rejects an unknown authType', () => {
    expect(() =>
      parseConfigFile('admin:\n  endpoint: e.example.com\n  authType: Magic\n'),
    ).toThrow(/Unsupported authType/)
  })

  it('infers client_credentials from a client id plus a secret location', () => {
    const config = parseConfigFile(`
admin:
  endpoint: acme.example.com
  clientId: my-client
  clientSecretLocation: /etc/secrets/client_secret
`)
    expect(config.auth).toMatchObject({
      mode: 'client_credentials',
      clientId: 'my-client',
      clientSecretLocation: '/etc/secrets/client_secret',
    })
  })

  it('infers external_command from a command', () => {
    const config = parseConfigFile(`
admin:
  endpoint: acme.example.com
  command:
    - print-token
    - --quiet
`)
    expect(config.auth).toMatchObject({
      mode: 'external_command',
      command: ['print-token', '--quiet'],
    })
  })

  it('carries insecure and scopes through', () => {
    const config = parseConfigFile(`
admin:
  endpoint: localhost:8089
  insecure: true
  scopes:
    - all
    - offline
`)
    expect(config.insecure).toBe(true)
    expect(config.auth?.scopes).toEqual(['all', 'offline'])
  })

  it('carries TLS trust settings through', () => {
    // A uctl config for a private-CA cluster must reproduce here, or
    // initFromConfig silently cannot reach the cluster.
    const config = parseConfigFile(`
admin:
  endpoint: acme.internal
  insecureSkipVerify: true
  caCertFilePath: /etc/ssl/corp-ca.pem
`)
    expect(config.insecureSkipVerify).toBe(true)
    expect(config.caCertFilePath).toBe('/etc/ssl/corp-ca.pem')
  })

  it('carries a proxy command and audience through', () => {
    const config = parseConfigFile(`
admin:
  endpoint: acme.example.com
  proxyCommand:
    - mint-proxy-token
    - --quiet
  audience: https://acme.example.com
`)
    expect(config.auth?.proxyCommand).toEqual(['mint-proxy-token', '--quiet'])
    expect(config.auth?.audience).toBe('https://acme.example.com')
    // A proxy command alone does not change how the user authenticates.
    expect(config.auth?.mode).toBe('pkce')
  })

  it('tolerates an empty file', () => {
    const config = parseConfigFile('')
    expect(config.endpoint).toBeUndefined()
    expect(config.auth?.mode).toBe('pkce')
  })

  it('rejects malformed YAML', () => {
    expect(() => parseConfigFile('admin:\n  endpoint: "unterminated\n')).toThrow(
      FlyteConfigError,
    )
  })
})

describe('loadConfigFile', () => {
  it('reads and parses a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-config-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, 'admin:\n  endpoint: acme.example.com\ntask:\n  project: p\n')
    const config = await loadConfigFile(path)
    expect(config).toMatchObject({ endpoint: 'acme.example.com', project: 'p' })
  })

  it('reports a missing file clearly', async () => {
    await expect(loadConfigFile('/definitely/not/here.yaml')).rejects.toThrow(
      /Failed to read config file/,
    )
  })
})

describe('findConfigPath', () => {
  const savedCwd = process.cwd()
  const savedEnv = { ...process.env }

  afterEach(() => {
    process.chdir(savedCwd)
    process.env = { ...savedEnv }
  })

  it('prefers ./config.yaml in the working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-search-'))
    await writeFile(join(dir, 'config.yaml'), 'admin: {}\n')
    process.chdir(dir)
    // realpath: macOS resolves the temp dir through a /private symlink.
    const { realpath } = await import('node:fs/promises')
    expect(await findConfigPath()).toBe(join(await realpath(dir), 'config.yaml'))
  })

  it('falls back to $UCTL_CONFIG when the working directory has none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-search-'))
    const envPath = join(dir, 'from-env.yaml')
    await writeFile(envPath, 'admin: {}\n')
    const empty = await mkdtemp(join(tmpdir(), 'flyte-empty-'))
    process.chdir(empty)
    process.env.UCTL_CONFIG = envPath
    delete process.env.FLYTECTL_CONFIG
    expect(await findConfigPath()).toBe(envPath)
  })
})
