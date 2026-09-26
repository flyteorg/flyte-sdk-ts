/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * PKCE login drives a real loopback HTTP server and normally opens a browser.
 * These tests point the redirect URI at an ephemeral port and play the
 * browser's part with fetch.
 */

import { createServer } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { pkceLogin, type DiscoveredOAuthConfig } from '../src/oauth'

// Opening a real browser during tests would be disruptive; the test acts as
// the browser by fetching the callback URL itself.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => ({
      unref: () => {},
      on: (event: string, cb: () => void) => {
        // Report a failed spawn so pkceLogin prints the URL instead of
        // waiting on a browser that will never open.
        if (event === 'error') setImmediate(cb)
      },
    }),
  }
})

/** Reserves a free localhost port. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function configOnFreePort(): Promise<DiscoveredOAuthConfig> {
  const port = await freePort()
  return {
    clientId: 'public-client',
    redirectUri: `http://127.0.0.1:${port}/callback`,
    scopes: ['all', 'offline'],
    audience: 'https://acme.example.com',
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
  }
}

/**
 * Stubs the token endpoint and captures the authorize URL that pkceLogin
 * would have opened in a browser.
 */
function stubTokenEndpoint(response: unknown) {
  const realFetch = globalThis.fetch
  const calls: URLSearchParams[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://auth.example.com/token')) {
      calls.push(new URLSearchParams(String(init?.body ?? '')))
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return realFetch(input, init)
  })
  return calls
}

/** Reads the authorize URL that pkceLogin logged after "browser" launch failed. */
function captureAuthorizeUrl(): { url: () => URL } {
  const logged: string[] = []
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    logged.push(String(msg))
  })
  return {
    url: () => {
      const match = logged.join('\n').match(/https:\/\/auth\.example\.com\/authorize\?\S+/)
      if (!match) throw new Error(`no authorize URL logged; saw: ${logged.join(' | ')}`)
      return new URL(match[0])
    },
  }
}

/** Polls the loopback callback until the login server is listening. */
async function hitCallback(redirectUri: string, params: Record<string, string>): Promise<void> {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const realFetch = globalThis.fetch
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await realFetch(url)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  throw new Error(`callback server never came up at ${redirectUri}`)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pkceLogin', () => {
  it('exchanges the callback code for tokens using the PKCE verifier', async () => {
    const config = await configOnFreePort()
    const tokenCalls = stubTokenEndpoint({
      access_token: 'pkce-access',
      refresh_token: 'pkce-refresh',
      expires_in: 3600,
    })
    const captured = captureAuthorizeUrl()

    const login = pkceLogin(config, { timeoutMs: 10_000 })
    // Wait for the authorize URL so the state parameter can be echoed back.
    await new Promise((r) => setTimeout(r, 50))
    const authorizeUrl = captured.url()
    await hitCallback(config.redirectUri, {
      code: 'auth-code',
      state: authorizeUrl.searchParams.get('state')!,
    })

    const token = await login
    expect(token.accessToken).toBe('pkce-access')
    expect(token.refreshToken).toBe('pkce-refresh')

    const body = tokenCalls[0]!
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('redirect_uri')).toBe(config.redirectUri)
    expect(body.get('client_id')).toBe('public-client')
    expect(body.get('code_verifier')).toBeTruthy()
  })

  it('builds an S256 authorize URL carrying the discovered scopes and audience', async () => {
    const config = await configOnFreePort()
    stubTokenEndpoint({ access_token: 'a' })
    const captured = captureAuthorizeUrl()

    const login = pkceLogin(config, { timeoutMs: 10_000 })
    await new Promise((r) => setTimeout(r, 50))
    const url = captured.url()

    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('public-client')
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri)
    expect(url.searchParams.get('scope')).toBe('all offline')
    expect(url.searchParams.get('audience')).toBe('https://acme.example.com')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('nonce')).toBeTruthy()

    await hitCallback(config.redirectUri, {
      code: 'c',
      state: url.searchParams.get('state')!,
    })
    await login
  })

  it('rejects a callback whose state does not match', async () => {
    const config = await configOnFreePort()
    stubTokenEndpoint({ access_token: 'should-not-be-used' })
    captureAuthorizeUrl()

    const login = pkceLogin(config, { timeoutMs: 10_000 })
    // Attach the rejection handler before triggering the callback, so the
    // rejection is never momentarily unhandled.
    const rejects = expect(login).rejects.toThrow(/state mismatch/)
    await new Promise((r) => setTimeout(r, 50))
    await hitCallback(config.redirectUri, { code: 'c', state: 'forged' })

    await rejects
  })

  it('surfaces an error returned on the callback', async () => {
    const config = await configOnFreePort()
    stubTokenEndpoint({})
    captureAuthorizeUrl()

    const login = pkceLogin(config, { timeoutMs: 10_000 })
    const rejects = expect(login).rejects.toThrow(/access_denied user declined/)
    await new Promise((r) => setTimeout(r, 50))
    await hitCallback(config.redirectUri, {
      error: 'access_denied',
      error_description: 'user declined',
    })

    await rejects
  })

  it('rejects a callback with no code', async () => {
    const config = await configOnFreePort()
    stubTokenEndpoint({})
    captureAuthorizeUrl()

    const login = pkceLogin(config, { timeoutMs: 10_000 })
    // No code and a state that cannot match: state is checked first.
    const rejects = expect(login).rejects.toThrow(/Login failed/)
    await new Promise((r) => setTimeout(r, 50))
    await hitCallback(config.redirectUri, { state: 'x' })

    await rejects
  })

  it('surfaces a failed code exchange', async () => {
    const config = await configOnFreePort()
    stubTokenEndpoint({ error: 'invalid_grant', error_description: 'bad code' })
    const captured = captureAuthorizeUrl()

    const login = pkceLogin(config, { timeoutMs: 10_000 })
    const rejects = expect(login).rejects.toThrow(
      /Code exchange failed: invalid_grant bad code/,
    )
    await new Promise((r) => setTimeout(r, 50))
    await hitCallback(config.redirectUri, {
      code: 'c',
      state: captured.url().searchParams.get('state')!,
    })

    await rejects
  })

  it('times out when the user never completes the login', async () => {
    const config = await configOnFreePort()
    stubTokenEndpoint({})
    captureAuthorizeUrl()

    await expect(pkceLogin(config, { timeoutMs: 100 })).rejects.toThrow(
      /Browser login did not complete within/,
    )
  })

  it('reports a redirect port that is already in use', async () => {
    const config = await configOnFreePort()
    const port = Number(new URL(config.redirectUri).port)
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))
    try {
      stubTokenEndpoint({})
      captureAuthorizeUrl()
      await expect(pkceLogin(config, { timeoutMs: 5000 })).rejects.toThrow(
        /is another login in progress/,
      )
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
