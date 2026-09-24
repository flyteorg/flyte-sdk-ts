/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Authentication for the Flyte client.
 *
 * - **client_credentials** — machine-to-machine (API keys, server/CI)
 * - **session** — browser cookies (Flyte console model)
 * - **bearer** / **bearer_dynamic** — short-lived tokens (BFF → browser)
 * - **anonymous** — local dev without auth
 */

import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'

import type { AuthOptions, ResolvedAuth, ResolvedConfig } from './config'
import { normalizeEndpoint, toBase64 } from './config'
import { FlyteAuthError } from './errors'
import { AuthMetadataService } from './gen/flyteidl2/auth/auth_service_pb'

const REFRESH_SKEW_SECONDS = 60

interface CachedToken {
  accessToken: string
  expiresAtMs: number
}

type ClientCredentialsAuth = Extract<ResolvedAuth, { mode: 'client_credentials' }>

/**
 * Discovers OAuth2 metadata from the server (anonymous RPC). Pass the
 * client's `fetch` so discovery honors its TLS trust settings.
 */
export async function discoverOAuth2Metadata(endpoint: string, fetchFn?: typeof fetch) {
  const client = createClient(AuthMetadataService, authTransport(endpoint, fetchFn))
  return client.getOAuth2Metadata({})
}

/**
 * Discovers browser OAuth client config (anonymous RPC). Pass the client's
 * `fetch` so discovery honors its TLS trust settings.
 */
export async function discoverPublicClientConfig(endpoint: string, fetchFn?: typeof fetch) {
  const client = createClient(AuthMetadataService, authTransport(endpoint, fetchFn))
  return client.getPublicClientConfig({})
}

/** Transport for the anonymous auth-metadata service. */
function authTransport(endpoint: string, fetchFn?: typeof fetch): Transport {
  return createConnectTransport({
    baseUrl: normalizeEndpoint(endpoint),
    ...(fetchFn ? { fetch: fetchFn } : {}),
  })
}

/** Builds the login URL used by the Flyte console and session auth refresh. */
export function buildLoginUrl(
  endpoint: string,
  redirectPath = '/',
): string {
  const base = normalizeEndpoint(endpoint)
  return `${base}/login?redirect_url=${encodeURIComponent(redirectPath)}`
}

/**
 * Attempts to refresh session cookies (Okta refresh token flow on the server).
 * Same approach as the Flyte 2 console — opaque `no-cors` fetch to `/login`.
 */
export async function refreshSession(
  config: Pick<ResolvedConfig, 'endpoint' | 'auth'>,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (config.auth.mode !== 'session') {
    throw new FlyteAuthError('refreshSession requires session auth mode.')
  }
  const loginUrl = buildLoginUrl(config.endpoint, config.auth.loginRedirectPath)
  await fetchFn(loginUrl, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    credentials: config.auth.credentials,
    redirect: 'follow',
    mode: 'no-cors',
  })
}

/** Redirects the browser to the Flyte login page. No-op outside a browser. */
export function redirectToLogin(config: Pick<ResolvedConfig, 'endpoint' | 'auth'>): void {
  if (typeof globalThis.location === 'undefined') {
    throw new FlyteAuthError('redirectToLogin requires a browser environment.')
  }
  const redirectPath =
    config.auth.mode === 'session' ? config.auth.loginRedirectPath : '/'
  globalThis.location.href = buildLoginUrl(config.endpoint, redirectPath)
}

/**
 * Ready-to-use {@link AuthOptions} for browser / Next.js client components.
 * Sends session cookies and redirects to login on Unauthenticated responses.
 */
export function createBrowserAuth(options: {
  endpoint: string
  loginRedirectPath?: string
  credentials?: RequestCredentials
  /**
   * Send cookies even when the endpoint is localhost (e.g. Vite dev on
   * `localhost.<admin-host>`). Required for session auth through a local dev host.
   */
  sendCredentialsOnLocalhost?: boolean
  /** Override the default redirect-to-login handler. */
  onAuthRequired?: () => void
}): AuthOptions {
  const endpoint = normalizeEndpoint(options.endpoint)
  const loginRedirectPath = options.loginRedirectPath ?? '/'
  return {
    session: true,
    credentials: options.credentials ?? 'include',
    sendCredentialsOnLocalhost: options.sendCredentialsOnLocalhost,
    loginRedirectPath,
    onAuthRequired:
      options.onAuthRequired ??
      (() => {
        if (typeof globalThis.location !== 'undefined') {
          globalThis.location.href = buildLoginUrl(endpoint, loginRedirectPath)
        }
      }),
  }
}

/** A source of bearer tokens that can be told its token went stale. */
export interface TokenSource {
  getToken(): Promise<string>
  /** Drops any cached token so the next {@link getToken} mints a fresh one. */
  invalidate(): void | Promise<void>
}

export class TokenManager implements TokenSource {
  private cached: CachedToken | undefined
  private inflight: Promise<string> | undefined
  private discoveredTokenEndpoint: string | undefined
  private discoveredScopes: string[] | undefined
  private discoveredAudience: string | undefined

  constructor(
    private readonly endpoint: string,
    private readonly auth: ClientCredentialsAuth,
    /** Used for discovery and the token request, so TLS settings apply. */
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAtMs) {
      return this.cached.accessToken
    }
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined
      })
    }
    return this.inflight
  }

  invalidate(): void {
    this.cached = undefined
  }

  /** Resolves the client secret, reading `clientSecretLocation` lazily (Node). */
  private async resolveClientSecret(): Promise<string> {
    if (this.auth.clientSecret) return this.auth.clientSecret
    if (this.auth.clientSecretLocation) {
      try {
        const fs = await import('node:fs/promises')
        const secret = (await fs.readFile(this.auth.clientSecretLocation, 'utf8')).trim()
        if (secret) return secret
      } catch (cause) {
        throw new FlyteAuthError(
          `Failed to read client secret from ${this.auth.clientSecretLocation}.`,
          { cause },
        )
      }
    }
    throw new FlyteAuthError('No client secret configured.')
  }

  private async fetchToken(): Promise<string> {
    const tokenEndpoint = await this.resolveTokenEndpoint()
    const clientSecret = await this.resolveClientSecret()

    const body = new URLSearchParams()
    body.set('grant_type', 'client_credentials')
    const scopes = this.discoveredScopes ?? this.auth.scopes
    if (scopes.length > 0) {
      body.set('scope', scopes.join(' '))
    }
    const audience = this.auth.audience ?? this.discoveredAudience
    if (audience) {
      body.set('audience', audience)
    }

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }
    if (this.auth.clientAuthMethod === 'post') {
      body.set('client_id', this.auth.clientId)
      body.set('client_secret', clientSecret)
    } else {
      const basic = toBase64(
        `${encodeURIComponent(this.auth.clientId)}:${encodeURIComponent(clientSecret)}`,
      )
      headers.authorization = `Basic ${basic}`
    }

    let res: Response
    try {
      res = await this.fetchFn(tokenEndpoint, { method: 'POST', headers, body })
    } catch (cause) {
      throw new FlyteAuthError(`Token request to ${tokenEndpoint} failed.`, { cause })
    }

    if (!res.ok) {
      const text = await safeText(res)
      throw new FlyteAuthError(
        `Token request failed (${res.status} ${res.statusText}): ${text}`,
      )
    }

    const json = (await res.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!json.access_token) {
      throw new FlyteAuthError('Token response did not include an access_token.')
    }

    const expiresInSec = json.expires_in ?? 3600
    this.cached = {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + Math.max(0, expiresInSec - REFRESH_SKEW_SECONDS) * 1000,
    }
    return this.cached.accessToken
  }

  /**
   * Resolves the token endpoint and, when the caller did not pin them, the
   * scopes and audience the server advertises — matching how the Go and
   * Python SDKs let the deployment decide.
   */
  private async resolveTokenEndpoint(): Promise<string> {
    if (this.auth.tokenEndpoint) return this.auth.tokenEndpoint
    if (this.discoveredTokenEndpoint) return this.discoveredTokenEndpoint

    const transport = authTransport(this.endpoint, this.fetchFn)
    let tokenEndpoint: string
    try {
      const client = createClient(AuthMetadataService, transport)
      const meta = await client.getOAuth2Metadata({})
      if (!meta.tokenEndpoint) {
        throw new FlyteAuthError(
          `${this.endpoint} did not advertise an OAuth2 token endpoint. ` +
            'Set auth.tokenEndpoint explicitly.',
        )
      }
      tokenEndpoint = meta.tokenEndpoint
    } catch (cause) {
      if (cause instanceof FlyteAuthError) throw cause
      throw new FlyteAuthError(
        `Failed to discover the OAuth2 token endpoint from ${this.endpoint}. ` +
          'Set auth.tokenEndpoint explicitly if the server has no discovery endpoint.',
        { cause },
      )
    }

    if (!this.auth.scopesExplicit || this.auth.audience === undefined) {
      try {
        const client = createClient(AuthMetadataService, transport)
        const pub = await client.getPublicClientConfig({})
        if (!this.auth.scopesExplicit && pub.scopes.length > 0) {
          this.discoveredScopes = pub.scopes
        }
        if (this.auth.audience === undefined && pub.audience) {
          this.discoveredAudience = pub.audience
        }
      } catch {
        // Scope/audience discovery is best effort; the configured defaults apply.
      }
    }

    this.discoveredTokenEndpoint = tokenEndpoint
    return tokenEndpoint
  }
}

function setBearerHeaders(req: { header: Headers }, token: string, headerKey: string): void {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new FlyteAuthError('Access token is empty.')
  }
  const value = `Bearer ${trimmed}`
  const inBrowser = typeof globalThis.window !== 'undefined'
  // Cross-origin browser requests fail CORS preflight for custom auth headers
  // (e.g. flyte-authorization). Envoy accepts standard Authorization.
  if (inBrowser && headerKey !== 'authorization') {
    req.header.set('authorization', value)
    return
  }
  // Envoy accepts either header; send both so proxy + hosted configs work (Node/server).
  req.header.set('authorization', value)
  if (headerKey !== 'authorization') {
    req.header.set(headerKey, value)
  }
}

/**
 * Attaches a bearer token to every request and, when the server answers
 * `Unauthenticated`, drops the cached token and retries the request once with
 * a freshly minted one.
 *
 * The retry covers tokens that are still locally unexpired but no longer
 * accepted — revoked, rotated server-side, or invalidated by clock skew.
 * Streaming calls are not retried; their consumers reconnect themselves.
 */
export function createBearerAuthInterceptor(
  source: TokenSource,
  headerKey: string,
): Interceptor {
  return (next) => async (req) => {
    setBearerHeaders(req, await source.getToken(), headerKey)
    try {
      return await next(req)
    } catch (err) {
      const reauthable =
        !req.stream && err instanceof ConnectError && err.code === Code.Unauthenticated
      if (!reauthable) throw err
      await source.invalidate()
      setBearerHeaders(req, await source.getToken(), headerKey)
      return next(req)
    }
  }
}

export function createTokenManagerInterceptor(
  tokenManager: TokenManager,
  headerKey: string,
): Interceptor {
  return createBearerAuthInterceptor(tokenManager, headerKey)
}

/**
 * Attaches a fixed bearer token. Unlike the other bearer paths this does not
 * retry on `Unauthenticated`: there is no way to mint a different token, so
 * replaying the request would fail identically.
 */
export function createBearerInterceptor(
  token: string,
  headerKey: string,
): Interceptor {
  return (next) => async (req) => {
    setBearerHeaders(req, token, headerKey)
    return next(req)
  }
}

export function createDynamicBearerInterceptor(
  getAccessToken: () => Promise<string>,
  headerKey: string,
  invalidate: () => void | Promise<void> = () => {},
): Interceptor {
  return createBearerAuthInterceptor({ getToken: getAccessToken, invalidate }, headerKey)
}

export function createHeadersInterceptor(headers: Record<string, string>): Interceptor {
  return (next) => async (req) => {
    for (const [k, v] of Object.entries(headers)) {
      req.header.set(k, v)
    }
    return next(req)
  }
}

/** Invokes onAuthRequired when the server returns Unauthenticated. */
export function createAuthErrorInterceptor(onAuthRequired?: () => void): Interceptor {
  return (next) => async (req) => {
    try {
      return await next(req)
    } catch (err) {
      if (
        onAuthRequired &&
        err instanceof ConnectError &&
        err.code === Code.Unauthenticated
      ) {
        onAuthRequired()
      }
      throw err
    }
  }
}

/**
 * Wraps fetch to attach session cookies. Skips credentials on localhost endpoints
 * (matches Flyte 2 console behavior for local dev).
 */
export function createCredentialsFetch(
  baseUrl: string,
  credentials: RequestCredentials,
  sendCredentialsOnLocalhost = false,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const isLocal =
    baseUrl.includes('localhost') ||
    baseUrl.includes('127.0.0.1')
  const sendCredentials = sendCredentialsOnLocalhost || !isLocal
  return (input, init) =>
    baseFetch(input, {
      ...init,
      ...(sendCredentials ? { credentials } : {}),
    })
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<no body>'
  }
}

/** @deprecated Use createTokenManagerInterceptor */
export const createAuthInterceptor = createTokenManagerInterceptor
