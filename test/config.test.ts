/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  decodeApiKey,
  normalizeEndpoint,
  orgFromEndpoint,
  resolveConfig,
} from '../src/config'
import { FlyteConfigError } from '../src/errors'

const FLYTE_ENV_VARS = [
  'FLYTE_API_KEY',
  'FLYTE_ENDPOINT',
  'FLYTE_ORG',
  'FLYTE_PROJECT',
  'FLYTE_DOMAIN',
  'FLYTE_CLIENT_ID',
  'FLYTE_CLIENT_SECRET',
] as const

/** Builds a platform API key: base64 of `endpoint:clientId:clientSecret:org`. */
function apiKey(
  endpoint = 'acme.example.com',
  clientId = 'my-client',
  clientSecret = 'sh-secret',
  org = 'acme',
): string {
  return Buffer.from(`${endpoint}:${clientId}:${clientSecret}:${org}`).toString('base64')
}

describe('normalizeEndpoint', () => {
  it('strips the dns:/// gRPC target prefix and defaults to https', () => {
    expect(normalizeEndpoint('dns:///acme.example.com')).toBe('https://acme.example.com')
  })

  it('keeps an explicit scheme and trims trailing slashes', () => {
    expect(normalizeEndpoint('https://acme.example.com/')).toBe('https://acme.example.com')
    expect(normalizeEndpoint('http://acme.example.com//')).toBe('http://acme.example.com')
  })

  it('defaults localhost to http', () => {
    expect(normalizeEndpoint('localhost:8080')).toBe('http://localhost:8080')
    expect(normalizeEndpoint('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('forces http when insecure is set, overriding an https scheme', () => {
    expect(normalizeEndpoint('acme.example.com', true)).toBe('http://acme.example.com')
    expect(normalizeEndpoint('https://acme.example.com', true)).toBe('http://acme.example.com')
  })
})

describe('orgFromEndpoint', () => {
  it("derives the org from the hostname's first DNS label", () => {
    expect(orgFromEndpoint('https://acme.example.com')).toBe('acme')
    expect(orgFromEndpoint('dns:///acme.hosted.unionai.cloud')).toBe('acme')
    expect(orgFromEndpoint('acme.example.com:443')).toBe('acme')
  })

  it('yields undefined for hostnames with two or fewer labels', () => {
    expect(orgFromEndpoint('http://localhost:8080')).toBeUndefined()
    expect(orgFromEndpoint('https://example.com')).toBeUndefined()
  })

  it('yields undefined for IP literals, whose octets are not DNS labels', () => {
    // 127.0.0.1 has four dot-separated parts but no org in the first one.
    expect(orgFromEndpoint('http://127.0.0.1:8090')).toBeUndefined()
    expect(orgFromEndpoint('10.0.0.5')).toBeUndefined()
    expect(orgFromEndpoint('https://[::1]:8080')).toBeUndefined()
  })
})

describe('decodeApiKey', () => {
  it('decodes endpoint, client id, secret, and org', () => {
    expect(decodeApiKey(apiKey())).toEqual({
      endpoint: 'acme.example.com',
      clientId: 'my-client',
      clientSecret: 'sh-secret',
      org: 'acme',
    })
  })

  it('keeps colons in the endpoint', () => {
    const decoded = decodeApiKey(apiKey('dns:///acme.example.com:443'))
    expect(decoded.endpoint).toBe('dns:///acme.example.com:443')
    expect(decoded.org).toBe('acme')
  })

  it('rejects keys with too few parts', () => {
    const bad = Buffer.from('acme.example.com:client').toString('base64')
    expect(() => decodeApiKey(bad)).toThrow(FlyteConfigError)
  })

  it('rejects keys with an empty client id or secret', () => {
    const bad = Buffer.from('acme.example.com:::acme').toString('base64')
    expect(() => decodeApiKey(bad)).toThrow(/required/)
  })
})

describe('resolveConfig', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of FLYTE_ENV_VARS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of FLYTE_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('requires an endpoint', () => {
    expect(() => resolveConfig()).toThrow(/Missing endpoint/)
  })

  it('derives endpoint, org, and credentials from an API key', () => {
    const resolved = resolveConfig({ auth: { apiKey: apiKey() } })
    expect(resolved.endpoint).toBe('https://acme.example.com')
    expect(resolved.org).toBe('acme')
    expect(resolved.auth).toMatchObject({
      mode: 'client_credentials',
      clientId: 'my-client',
      clientSecret: 'sh-secret',
      clientAuthMethod: 'basic',
      scopes: ['all'],
    })
  })

  it('treats the "None" org in an API key as absent and derives it instead', () => {
    const resolved = resolveConfig({ auth: { apiKey: apiKey('acme.example.com', 'c', 's', 'None') } })
    expect(resolved.org).toBe('acme')
  })

  it('prefers explicit config over the API key and env', () => {
    process.env.FLYTE_ORG = 'from-env'
    const resolved = resolveConfig({
      endpoint: 'https://other.example.com',
      org: 'explicit',
      auth: { apiKey: apiKey() },
    })
    expect(resolved.endpoint).toBe('https://other.example.com')
    expect(resolved.org).toBe('explicit')
  })

  it('reads endpoint, org, project, and domain from the environment', () => {
    process.env.FLYTE_ENDPOINT = 'dns:///acme.example.com'
    process.env.FLYTE_ORG = 'env-org'
    process.env.FLYTE_PROJECT = 'env-project'
    process.env.FLYTE_DOMAIN = 'env-domain'
    const resolved = resolveConfig()
    expect(resolved).toMatchObject({
      endpoint: 'https://acme.example.com',
      org: 'env-org',
      project: 'env-project',
      domain: 'env-domain',
    })
  })

  it('carries default project and domain through', () => {
    const resolved = resolveConfig({
      endpoint: 'acme.example.com',
      project: 'my-project',
      domain: 'development',
    })
    expect(resolved.project).toBe('my-project')
    expect(resolved.domain).toBe('development')
  })

  describe('auth mode inference', () => {
    const endpoint = 'acme.example.com'

    it('infers anonymous with no credentials', () => {
      expect(resolveConfig({ endpoint }).auth.mode).toBe('anonymous')
    })

    it('infers session from the shorthand', () => {
      const resolved = resolveConfig({ endpoint, auth: { session: true } })
      expect(resolved.auth).toMatchObject({ mode: 'session', credentials: 'include' })
    })

    it('infers bearer from a static token', () => {
      const resolved = resolveConfig({ endpoint, auth: { bearerToken: 'tok' } })
      expect(resolved.auth).toMatchObject({ mode: 'bearer', bearerToken: 'tok' })
    })

    it('infers bearer_dynamic from getAccessToken', () => {
      const resolved = resolveConfig({
        endpoint,
        auth: { getAccessToken: async () => 'tok' },
      })
      expect(resolved.auth.mode).toBe('bearer_dynamic')
    })

    it('infers external_command from a command', () => {
      const resolved = resolveConfig({ endpoint, auth: { command: ['print-token'] } })
      expect(resolved.auth).toMatchObject({
        mode: 'external_command',
        command: ['print-token'],
      })
    })

    it('infers client_credentials from clientId plus a secret env var', () => {
      process.env.MY_SECRET = 'from-env-var'
      try {
        const resolved = resolveConfig({
          endpoint,
          auth: { clientId: 'c', clientSecretEnvVar: 'MY_SECRET' },
        })
        expect(resolved.auth).toMatchObject({
          mode: 'client_credentials',
          clientId: 'c',
          clientSecret: 'from-env-var',
        })
      } finally {
        delete process.env.MY_SECRET
      }
    })

    it('defers reading clientSecretLocation until token time', () => {
      const resolved = resolveConfig({
        endpoint,
        auth: { clientId: 'c', clientSecretLocation: '/etc/secrets/client_secret' },
      })
      expect(resolved.auth).toMatchObject({
        mode: 'client_credentials',
        clientSecret: undefined,
        clientSecretLocation: '/etc/secrets/client_secret',
      })
    })

    it('rejects client_credentials without a secret', () => {
      expect(() =>
        resolveConfig({ endpoint, auth: { mode: 'client_credentials', clientId: 'c' } }),
      ).toThrow(/requires apiKey/)
    })

    it('rejects bearer mode without a token', () => {
      expect(() => resolveConfig({ endpoint, auth: { mode: 'bearer' } })).toThrow(
        /requires bearerToken/,
      )
    })

    it('rejects external_command without a command', () => {
      expect(() => resolveConfig({ endpoint, auth: { mode: 'external_command' } })).toThrow(
        /requires command/,
      )
    })

    it('applies interactive-flow defaults for pkce', () => {
      const resolved = resolveConfig({ endpoint, auth: { mode: 'pkce' } })
      expect(resolved.auth).toMatchObject({
        mode: 'pkce',
        browserTimeoutMs: 600_000,
        disableTokenCache: false,
      })
    })

    it('applies interactive-flow defaults for device_flow', () => {
      const resolved = resolveConfig({ endpoint, auth: { mode: 'device_flow' } })
      expect(resolved.auth).toMatchObject({
        mode: 'device_flow',
        timeoutMs: 600_000,
        pollIntervalMs: 5000,
      })
    })

    it('lowercases a custom authorization header', () => {
      const resolved = resolveConfig({
        endpoint,
        auth: { bearerToken: 't', authorizationHeader: 'Flyte-Authorization' },
      })
      expect(resolved.auth.authorizationHeader).toBe('flyte-authorization')
    })

    it('records whether the caller pinned the scopes', () => {
      // Unpinned scopes may be replaced by what the server advertises.
      const inferred = resolveConfig({ endpoint, auth: { apiKey: apiKey() } })
      expect(inferred.auth).toMatchObject({ scopes: ['all'], scopesExplicit: false })

      const pinned = resolveConfig({
        endpoint,
        auth: { apiKey: apiKey(), scopes: ['custom'] },
      })
      expect(pinned.auth).toMatchObject({ scopes: ['custom'], scopesExplicit: true })
    })
  })

  describe('transport settings', () => {
    const endpoint = 'acme.example.com'

    it('defaults the run source to web', () => {
      // The SDK is normally embedded in a service or web app.
      expect(resolveConfig({ endpoint }).runSource).toBe('web')
      expect(resolveConfig({ endpoint, runSource: 'cli' }).runSource).toBe('cli')
    })

    it('carries the retry policy through', () => {
      const resolved = resolveConfig({ endpoint, retry: { maxRetries: 0 } })
      expect(resolved.retry).toEqual({ maxRetries: 0 })
    })

    it('omits TLS settings unless one is requested', () => {
      expect(resolveConfig({ endpoint }).tls).toBeUndefined()
      expect(resolveConfig({ endpoint, insecureSkipVerify: false }).tls).toBeUndefined()
    })

    it('collects TLS trust settings', () => {
      const resolved = resolveConfig({
        endpoint,
        insecureSkipVerify: true,
        caCertFilePath: '/etc/ssl/ca.pem',
      })
      expect(resolved.tls).toEqual({
        insecureSkipVerify: true,
        caCertFilePath: '/etc/ssl/ca.pem',
      })
    })

    it('surfaces a proxy command independently of the auth mode', () => {
      const resolved = resolveConfig({
        endpoint,
        auth: { bearerToken: 't', proxyCommand: ['mint-proxy-token'] },
      })
      expect(resolved.auth.mode).toBe('bearer')
      expect(resolved.proxyCommand).toEqual(['mint-proxy-token'])
    })

    it('omits an empty proxy command', () => {
      expect(resolveConfig({ endpoint, auth: { proxyCommand: [] } }).proxyCommand).toBeUndefined()
    })
  })
})
