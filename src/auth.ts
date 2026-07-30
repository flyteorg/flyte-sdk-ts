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

/** Discovers OAuth2 metadata from the server (anonymous RPC). */
export async function discoverOAuth2Metadata(endpoint: string) {
  const transport = createConnectTransport({
    baseUrl: normalizeEndpoint(endpoint),
  })
  const client = createClient(AuthMetadataService, transport)
  return client.getOAuth2Metadata({})
}

/** Discovers browser OAuth client config (anonymous RPC). */
export async function discoverPublicClientConfig(endpoint: string) {
  const transport = createConnectTransport({
    baseUrl: normalizeEndpoint(endpoint),
  })
  const client = createClient(AuthMetadataService, transport)
  return client.getPublicClientConfig({})
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
export async function refreshSession(config: Pick<ResolvedConfig, 'endpoint' | 'auth'>): Promise<void> {
  if (config.auth.mode !== 'session') {
    throw new FlyteAuthError('refreshSession requires session auth mode.')
  }
  const loginUrl = buildLoginUrl(config.endpoint, config.auth.loginRedirectPath)
  await fetch(loginUrl, {
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

export class TokenManager {
  private cached: CachedToken | undefined
  private inflight: Promise<string> | undefined
  private discoveredTokenEndpoint: string | undefined

  constructor(
    private readonly endpoint: string,
    private readonly auth: ClientCredentialsAuth,
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

  private async fetchToken(): Promise<string> {
    const tokenEndpoint = await this.resolveTokenEndpoint()

    const body = new URLSearchParams()
    body.set('grant_type', 'client_credentials')
    if (this.auth.scopes.length > 0) {
      body.set('scope', this.auth.scopes.join(' '))
    }
    if (this.auth.audience) {
      body.set('audience', this.auth.audience)
    }

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }
    if (this.auth.clientAuthMethod === 'post') {
      body.set('client_id', this.auth.clientId)
      body.set('client_secret', this.auth.clientSecret)
    } else {
      const basic = toBase64(
        `${encodeURIComponent(this.auth.clientId)}:${encodeURIComponent(this.auth.clientSecret)}`,
      )
      headers.authorization = `Basic ${basic}`
    }

    let res: Response
    try {
      res = await fetch(tokenEndpoint, { method: 'POST', headers, body })
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

  private async resolveTokenEndpoint(): Promise<string> {
    if (this.auth.tokenEndpoint) return this.auth.tokenEndpoint
    if (this.discoveredTokenEndpoint) return this.discoveredTokenEndpoint

    try {
      const transport: Transport = createConnectTransport({ baseUrl: this.endpoint })
      const client = createClient(AuthMetadataService, transport)
      const meta = await client.getOAuth2Metadata({})
      if (meta.tokenEndpoint) {
        this.discoveredTokenEndpoint = meta.tokenEndpoint
        return meta.tokenEndpoint
      }
    } catch {
      // fall through
    }
    this.discoveredTokenEndpoint = `${this.endpoint}/oauth2/token`
    return this.discoveredTokenEndpoint
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

export function createTokenManagerInterceptor(
  tokenManager: TokenManager,
  headerKey: string,
): Interceptor {
  return (next) => async (req) => {
    const token = await tokenManager.getToken()
    setBearerHeaders(req, token, headerKey)
    return next(req)
  }
}

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
): Interceptor {
  return (next) => async (req) => {
    const token = await getAccessToken()
    setBearerHeaders(req, token, headerKey)
    return next(req)
  }
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
): typeof fetch {
  const isLocal =
    baseUrl.includes('localhost') ||
    baseUrl.includes('127.0.0.1')
  const sendCredentials = sendCredentialsOnLocalhost || !isLocal
  return (input, init) =>
    fetch(input, {
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
