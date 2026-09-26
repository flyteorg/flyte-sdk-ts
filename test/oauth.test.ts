/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FlyteAuthError } from '../src/errors'
import {
  deviceFlowLogin,
  FileTokenCache,
  externalCommandToken,
  MemoryTokenCache,
  OAuthTokenManager,
  pkceCodeChallenge,
  refreshAccessToken,
  type DiscoveredOAuthConfig,
} from '../src/oauth'

const CONFIG: DiscoveredOAuthConfig = {
  clientId: 'public-client',
  redirectUri: 'http://localhost:53593/callback',
  scopes: ['all', 'offline'],
  audience: 'https://acme.example.com',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  deviceAuthorizationEndpoint: 'https://auth.example.com/device',
}

/** Stubs global fetch with a handler keyed by URL. */
function stubFetch(handler: (url: string, body: URLSearchParams) => unknown) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = new URLSearchParams(String(init?.body ?? ''))
    const payload = handler(url, body)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pkceCodeChallenge', () => {
  it('computes the base64url-encoded S256 digest of the verifier', async () => {
    // The RFC 7636 appendix B test vector.
    const challenge = await pkceCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('produces URL-safe output with no padding', async () => {
    const challenge = await pkceCodeChallenge('a'.repeat(64))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('refreshAccessToken', () => {
  it('exchanges a refresh token and carries the old one forward when not rotated', async () => {
    const spy = stubFetch(() => ({ access_token: 'new-access', expires_in: 3600 }))

    const token = await refreshAccessToken(CONFIG, 'old-refresh')

    expect(token.accessToken).toBe('new-access')
    // The server did not rotate the refresh token, so the existing one stays usable.
    expect(token.refreshToken).toBe('old-refresh')
    expect(token.expiresAtMs).toBeGreaterThan(Date.now())
    const body = new URLSearchParams(String(spy.mock.calls[0]![1]?.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('public-client')
  })

  it('prefers a rotated refresh token', async () => {
    stubFetch(() => ({ access_token: 'a', refresh_token: 'rotated' }))
    const token = await refreshAccessToken(CONFIG, 'old-refresh')
    expect(token.refreshToken).toBe('rotated')
  })

  it('surfaces an OAuth error response', async () => {
    stubFetch(() => ({ error: 'invalid_grant', error_description: 'expired' }))
    await expect(refreshAccessToken(CONFIG, 'stale')).rejects.toThrow(
      /invalid_grant expired/,
    )
  })

  it('rejects a response with no access token', async () => {
    stubFetch(() => ({ token_type: 'Bearer' }))
    await expect(refreshAccessToken(CONFIG, 'r')).rejects.toThrow(/did not include an access_token/)
  })
})

describe('deviceFlowLogin', () => {
  const deviceStart = {
    device_code: 'dev-code',
    user_code: 'WDJB-MJHT',
    verification_uri: 'https://auth.example.com/activate',
    verification_uri_complete: 'https://auth.example.com/activate?user_code=WDJB-MJHT',
    interval: 1,
    expires_in: 600,
  }

  it('reports the user code, polls, and returns the token', async () => {
    let polls = 0
    stubFetch((url) => {
      if (url.endsWith('/device')) return deviceStart
      polls++
      return polls < 2
        ? { error: 'authorization_pending' }
        : { access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 }
    })
    const onDeviceAuthorization = vi.fn()

    const token = await deviceFlowLogin(CONFIG, {
      pollIntervalMs: 1,
      onDeviceAuthorization,
    })

    expect(token.accessToken).toBe('device-access')
    expect(onDeviceAuthorization).toHaveBeenCalledWith({
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://auth.example.com/activate',
      verificationUriComplete: 'https://auth.example.com/activate?user_code=WDJB-MJHT',
    })
    expect(polls).toBe(2)
  })

  it('sends the discovered scopes and audience when starting the flow', async () => {
    const spy = stubFetch((url) =>
      url.endsWith('/device') ? deviceStart : { access_token: 'a' },
    )

    await deviceFlowLogin(CONFIG, { pollIntervalMs: 1 , onDeviceAuthorization: () => {} })

    const body = new URLSearchParams(String(spy.mock.calls[0]![1]?.body))
    expect(body.get('client_id')).toBe('public-client')
    expect(body.get('scope')).toBe('all offline')
    expect(body.get('audience')).toBe('https://acme.example.com')
  })

  // RFC 8628 says back off by 5 seconds on slow_down, so this test waits.
  it('backs off when the server says slow_down', { timeout: 15_000 }, async () => {
    let polls = 0
    stubFetch((url) => {
      if (url.endsWith('/device')) return deviceStart
      polls++
      return polls < 2 ? { error: 'slow_down' } : { access_token: 'a' }
    })

    const started = Date.now()
    const token = await deviceFlowLogin(CONFIG, {
      pollIntervalMs: 1,
      onDeviceAuthorization: () => {},
    })

    expect(token.accessToken).toBe('a')
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
  })

  it('fails on a terminal polling error', async () => {
    stubFetch((url) =>
      url.endsWith('/device')
        ? deviceStart
        : { error: 'access_denied', error_description: 'user declined' },
    )

    await expect(
      deviceFlowLogin(CONFIG, { pollIntervalMs: 1, onDeviceAuthorization: () => {} }),
    ).rejects.toThrow(/access_denied user declined/)
  })

  it('times out when the code is never confirmed', async () => {
    stubFetch((url) =>
      url.endsWith('/device') ? deviceStart : { error: 'authorization_pending' },
    )

    await expect(
      deviceFlowLogin(CONFIG, {
        pollIntervalMs: 1,
        timeoutMs: 20,
        onDeviceAuthorization: () => {},
      }),
    ).rejects.toThrow(/timed out/)
  })

  it('rejects an incomplete device authorization response', async () => {
    stubFetch(() => ({ device_code: 'only-this' }))
    await expect(
      deviceFlowLogin(CONFIG, { onDeviceAuthorization: () => {} }),
    ).rejects.toThrow(/missing required fields/)
  })

  it('refuses when the server advertises no device endpoint', async () => {
    const { deviceAuthorizationEndpoint: _omitted, ...noDevice } = CONFIG
    await expect(deviceFlowLogin(noDevice)).rejects.toThrow(
      /does not advertise a device authorization endpoint/,
    )
  })
})

describe('externalCommandToken', () => {
  it('returns the trimmed stdout of the command', async () => {
    const token = await externalCommandToken(['printf', 'my-token\n'])
    expect(token).toBe('my-token')
  })

  it('fails when the command exits non-zero', async () => {
    await expect(externalCommandToken(['false'])).rejects.toBeInstanceOf(FlyteAuthError)
  })

  it('fails when the command prints nothing', async () => {
    await expect(externalCommandToken(['true'])).rejects.toThrow(/printed no token/)
  })

  it('rejects an empty command', async () => {
    await expect(externalCommandToken([])).rejects.toThrow(/non-empty command/)
  })
})

describe('MemoryTokenCache', () => {
  it('round-trips and clears a token', async () => {
    const cache = new MemoryTokenCache()
    expect(await cache.get()).toBeUndefined()
    await cache.save({ accessToken: 'a' })
    expect(await cache.get()).toEqual({ accessToken: 'a' })
    await cache.clear()
    expect(await cache.get()).toBeUndefined()
  })
})

describe('FileTokenCache', () => {
  it('keys tokens by endpoint and persists them with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-cache-'))
    const file = join(dir, 'token-cache.json')

    const a = new FileTokenCache('https://a.example.com', file)
    const b = new FileTokenCache('https://b.example.com', file)
    await a.save({ accessToken: 'token-a' })
    await b.save({ accessToken: 'token-b' })

    expect(await a.get()).toEqual({ accessToken: 'token-a' })
    expect(await b.get()).toEqual({ accessToken: 'token-b' })

    const { stat } = await import('node:fs/promises')
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    await a.clear()
    expect(await a.get()).toBeUndefined()
    // Clearing one endpoint leaves the other intact.
    expect(await b.get()).toEqual({ accessToken: 'token-b' })
  })

  it('creates the parent directory on first save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-cache-'))
    const cache = new FileTokenCache('https://a.example.com', join(dir, 'nested', 'c.json'))
    await cache.save({ accessToken: 'a' })
    expect(await cache.get()).toEqual({ accessToken: 'a' })
  })

  it('treats a corrupt cache as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-cache-'))
    const file = join(dir, 'token-cache.json')
    await writeFile(file, 'not json at all')
    await chmod(file, 0o600)

    const cache = new FileTokenCache('https://a.example.com', file)
    expect(await cache.get()).toBeUndefined()
  })
})

describe('OAuthTokenManager', () => {
  const auth = {
    mode: 'device_flow' as const,
    timeoutMs: 1000,
    pollIntervalMs: 1,
    disableTokenCache: true,
    authorizationHeader: 'authorization',
    onDeviceAuthorization: () => {},
  }

  it('serves a usable cached token without logging in', async () => {
    const cache = new MemoryTokenCache()
    await cache.save({ accessToken: 'cached', expiresAtMs: Date.now() + 60 * 60_000 })
    const spy = stubFetch(() => ({}))

    const manager = new OAuthTokenManager('https://acme.example.com', auth, {
      cache,
      oauthConfig: CONFIG,
    })

    expect(await manager.getToken()).toBe('cached')
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats a token expiring within the refresh skew as stale', async () => {
    const cache = new MemoryTokenCache()
    // Inside the 5-minute skew, so it must be refreshed rather than used.
    await cache.save({
      accessToken: 'about-to-expire',
      refreshToken: 'r',
      expiresAtMs: Date.now() + 60_000,
    })
    stubFetch(() => ({ access_token: 'refreshed', expires_in: 3600 }))

    const manager = new OAuthTokenManager('https://acme.example.com', auth, {
      cache,
      oauthConfig: CONFIG,
    })

    expect(await manager.getToken()).toBe('refreshed')
    expect((await cache.get())?.accessToken).toBe('refreshed')
  })

  it('falls back to a fresh login when the refresh token is rejected', async () => {
    const cache = new MemoryTokenCache()
    await cache.save({ accessToken: 'stale', refreshToken: 'revoked', expiresAtMs: 0 })
    stubFetch((url, body) => {
      if (body.get('grant_type') === 'refresh_token') return { error: 'invalid_grant' }
      if (url.endsWith('/device')) {
        return {
          device_code: 'd',
          user_code: 'U',
          verification_uri: 'https://auth.example.com/activate',
          interval: 1,
        }
      }
      return { access_token: 'fresh-login', expires_in: 3600 }
    })

    const manager = new OAuthTokenManager('https://acme.example.com', auth, {
      cache,
      oauthConfig: CONFIG,
    })

    expect(await manager.getToken()).toBe('fresh-login')
  })

  it('coalesces concurrent token requests into one login', async () => {
    const cache = new MemoryTokenCache()
    let logins = 0
    stubFetch((url) => {
      if (url.endsWith('/device')) {
        logins++
        return {
          device_code: 'd',
          user_code: 'U',
          verification_uri: 'https://auth.example.com/activate',
          interval: 1,
        }
      }
      return { access_token: 'one-login', expires_in: 3600 }
    })

    const manager = new OAuthTokenManager('https://acme.example.com', auth, {
      cache,
      oauthConfig: CONFIG,
    })
    const tokens = await Promise.all([
      manager.getToken(),
      manager.getToken(),
      manager.getToken(),
    ])

    expect(tokens).toEqual(['one-login', 'one-login', 'one-login'])
    expect(logins).toBe(1)
  })
})
