/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Configuration resolution for the Flyte client.
 *
 * Supports machine auth (API key / client credentials), browser session cookies,
 * static or dynamic bearer tokens, and anonymous local development.
 */

import { FlyteConfigError } from './errors'

/** How the client authenticates the client-credentials token request. */
export type ClientAuthMethod = 'basic' | 'post'

/** Supported authentication modes. */
export type AuthMode =
  | 'client_credentials'
  | 'session'
  | 'bearer'
  | 'anonymous'

export interface AuthOptions {
  /**
   * Authentication mode. When omitted, inferred from the other auth fields:
   * API key / client id+secret → `client_credentials`; `bearerToken` /
   * `getAccessToken` → `bearer`; `session: true` or explicit `mode: 'session'`
   * → `session`; otherwise `anonymous`.
   */
  mode?: AuthMode
  /** Shorthand for `{ mode: 'session' }` — use in browser / Next.js client components. */
  session?: boolean

  // --- client_credentials (server, CI, scripts) ---
  /** Base64 API key: `endpoint:clientId:clientSecret:org`. */
  apiKey?: string
  clientId?: string
  clientSecret?: string
  tokenEndpoint?: string
  scopes?: string[]
  audience?: string
  clientAuthMethod?: ClientAuthMethod

  // --- bearer (browser with short-lived token from your BFF) ---
  /** Static bearer access token. Never use long-lived secrets here. */
  bearerToken?: string
  /** Returns a fresh access token per request (or on cache miss). */
  getAccessToken?: () => Promise<string>

  // --- session (browser / logged-in user, Flyte console model) ---
  /**
   * Cookie credentials mode. Default `'include'` so session cookies are sent
   * cross-origin to the Flyte admin API (same as the Flyte 2 console).
   */
  credentials?: RequestCredentials
  /**
   * Path appended to `/login?redirect_url=` when the user must sign in again.
   * Defaults to `/`.
   */
  loginRedirectPath?: string
  /** Called when a request returns Unauthenticated — redirect or show login UI. */
  onAuthRequired?: () => void
  /**
   * Send session cookies to localhost endpoints (Vite/Next dev proxy).
   * Ignored unless `session: true`.
   */
  sendCredentialsOnLocalhost?: boolean

  // --- shared ---
  /**
   * Header used for bearer tokens. Defaults to `authorization`. Session mode
   * ignores this (cookies carry auth). Discovered from public client config when
   * using OAuth helpers.
   */
  authorizationHeader?: string
}

export interface FlyteConfig {
  /**
   * Control-plane base URL, e.g. `https://my-flyte.example.com`.
   * Optional when it can be derived from an API key or `FLYTE_ENDPOINT`.
   */
  endpoint?: string
  /**
   * Default org for requests. Usually derived from the API key; can still be
   * overridden per call. Project and domain are always passed per call.
   */
  org?: string
  auth?: AuthOptions
  headers?: Record<string, string>
}

interface ClientCredentialsAuth {
  mode: 'client_credentials'
  clientId: string
  clientSecret: string
  tokenEndpoint?: string
  scopes: string[]
  audience?: string
  authorizationHeader: string
  clientAuthMethod: ClientAuthMethod
}

interface SessionAuth {
  mode: 'session'
  credentials: RequestCredentials
  loginRedirectPath: string
  sendCredentialsOnLocalhost: boolean
  onAuthRequired?: () => void
  authorizationHeader: string
}

interface BearerAuth {
  mode: 'bearer'
  bearerToken: string
  authorizationHeader: string
}

interface DynamicBearerAuth {
  mode: 'bearer_dynamic'
  getAccessToken: () => Promise<string>
  authorizationHeader: string
}

interface AnonymousAuth {
  mode: 'anonymous'
  authorizationHeader: string
}

export type ResolvedAuth =
  | ClientCredentialsAuth
  | SessionAuth
  | BearerAuth
  | DynamicBearerAuth
  | AnonymousAuth

export interface ResolvedConfig {
  endpoint: string
  org?: string
  headers: Record<string, string>
  auth: ResolvedAuth
}

interface DecodedApiKey {
  endpoint: string
  clientId: string
  clientSecret: string
  org: string
}

export function decodeApiKey(apiKey: string): DecodedApiKey {
  let plain: string
  try {
    plain = fromBase64(apiKey.trim())
  } catch {
    throw new FlyteConfigError('Invalid API key: not valid base64.')
  }

  const parts = plain.split(':')
  if (parts.length < 4) {
    throw new FlyteConfigError(
      'Invalid API key: expected base64 of "endpoint:clientId:clientSecret:org".',
    )
  }

  const org = parts.pop() as string
  const clientSecret = parts.pop() as string
  const clientId = parts.pop() as string
  const endpoint = parts.join(':')

  if (!endpoint || !clientId || !clientSecret) {
    throw new FlyteConfigError(
      'Invalid API key: endpoint, clientId, and clientSecret are all required.',
    )
  }

  return { endpoint, clientId, clientSecret, org }
}

export function normalizeEndpoint(endpoint: string): string {
  let e = endpoint.trim()
  e = e.replace(/^dns:\/\/\//, '')
  if (!/^https?:\/\//.test(e)) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(e)
    e = `${isLocal ? 'http' : 'https'}://${e}`
  }
  return e.replace(/\/+$/, '')
}

function env(name: string): string | undefined {
  const v = typeof process !== 'undefined' ? process.env?.[name] : undefined
  return v && v.length > 0 ? v : undefined
}

function inferAuthMode(auth: AuthOptions): AuthMode {
  if (auth.mode) return auth.mode
  if (auth.session) return 'session'
  if (auth.apiKey || (auth.clientId && auth.clientSecret)) return 'client_credentials'
  if (auth.bearerToken || auth.getAccessToken) return 'bearer'
  return 'anonymous'
}

function resolveAuth(auth: AuthOptions): ResolvedAuth {
  const authorizationHeader = (auth.authorizationHeader ?? 'authorization').toLowerCase()
  const mode = inferAuthMode(auth)

  switch (mode) {
    case 'session':
      return {
        mode: 'session',
        credentials: auth.credentials ?? 'include',
        loginRedirectPath: auth.loginRedirectPath ?? '/',
        sendCredentialsOnLocalhost: auth.sendCredentialsOnLocalhost ?? false,
        onAuthRequired: auth.onAuthRequired,
        authorizationHeader,
      }

    case 'bearer': {
      if (auth.getAccessToken) {
        return {
          mode: 'bearer_dynamic',
          getAccessToken: auth.getAccessToken,
          authorizationHeader,
        }
      }
      if (!auth.bearerToken) {
        throw new FlyteConfigError(
          'auth.mode "bearer" requires bearerToken or getAccessToken.',
        )
      }
      return {
        mode: 'bearer',
        bearerToken: auth.bearerToken,
        authorizationHeader,
      }
    }

    case 'client_credentials': {
      const apiKey = auth.apiKey
      const decoded = apiKey ? decodeApiKey(apiKey) : undefined
      const clientId = auth.clientId ?? decoded?.clientId ?? env('FLYTE_CLIENT_ID')
      const clientSecret =
        auth.clientSecret ?? decoded?.clientSecret ?? env('FLYTE_CLIENT_SECRET')
      if (!clientId || !clientSecret) {
        throw new FlyteConfigError(
          'client_credentials auth requires apiKey or clientId + clientSecret.',
        )
      }
      return {
        mode: 'client_credentials',
        clientId,
        clientSecret,
        tokenEndpoint: auth.tokenEndpoint,
        scopes: auth.scopes ?? ['all'],
        audience: auth.audience,
        authorizationHeader,
        clientAuthMethod: auth.clientAuthMethod ?? 'basic',
      }
    }

    case 'anonymous':
    default:
      return { mode: 'anonymous', authorizationHeader }
  }
}

export function resolveConfig(config: FlyteConfig = {}): ResolvedConfig {
  const authInput = config.auth ?? {}

  const apiKey = authInput.apiKey ?? env('FLYTE_API_KEY')
  const decoded = apiKey ? decodeApiKey(apiKey) : undefined

  const endpoint =
    config.endpoint ?? decoded?.endpoint ?? env('FLYTE_ENDPOINT')
  if (!endpoint) {
    throw new FlyteConfigError(
      'Missing endpoint. Set config.endpoint, provide an API key, or set FLYTE_ENDPOINT.',
    )
  }

  const org = config.org ?? decoded?.org ?? env('FLYTE_ORG') ?? undefined

  // Merge env API key into auth options for resolution when mode not explicit.
  const auth = resolveAuth({
    ...authInput,
    apiKey: authInput.apiKey ?? apiKey,
    clientId: authInput.clientId ?? decoded?.clientId,
    clientSecret: authInput.clientSecret ?? decoded?.clientSecret,
  })

  return {
    endpoint: normalizeEndpoint(endpoint),
    org: org || undefined,
    headers: { ...(config.headers ?? {}) },
    auth,
  }
}

export function toBase64(input: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(unescape(encodeURIComponent(input)))
  }
  return Buffer.from(input, 'utf8').toString('base64')
}

export function fromBase64(input: string): string {
  if (typeof globalThis.atob === 'function') {
    return decodeURIComponent(escape(globalThis.atob(input)))
  }
  return Buffer.from(input, 'base64').toString('utf8')
}
