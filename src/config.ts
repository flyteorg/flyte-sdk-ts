/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Configuration resolution for the Flyte client.
 *
 * Supports machine auth (API key / client credentials), browser session cookies,
 * static or dynamic bearer tokens, interactive OAuth flows for Node (PKCE,
 * device flow, external token command), and anonymous local development.
 */

import { FlyteConfigError } from './errors'
import type { RetryOptions } from './interceptors'
import type { TokenCache } from './oauth'

/** How the client authenticates the client-credentials token request. */
export type ClientAuthMethod = 'basic' | 'post'

/** Supported authentication modes. */
export type AuthMode =
  | 'client_credentials'
  | 'session'
  | 'bearer'
  | 'pkce'
  | 'device_flow'
  | 'external_command'
  | 'anonymous'

/** Details shown to the user during the device-flow login. */
export interface DeviceAuthorizationInfo {
  /** Code the user must confirm on the verification page. */
  userCode: string
  /** URL the user must open to complete the login. */
  verificationUri: string
  /** Verification URL with the user code embedded, when provided. */
  verificationUriComplete?: string
}

export interface AuthOptions {
  /**
   * Authentication mode. When omitted, inferred from the other auth fields:
   * API key / client id+secret → `client_credentials`; `bearerToken` /
   * `getAccessToken` → `bearer`; `command` → `external_command`;
   * `session: true` → `session`; otherwise `anonymous`.
   *
   * The interactive `pkce` and `device_flow` modes are never inferred — they
   * open a browser or print a code, which must not happen by surprise in a
   * server or browser bundle. Ask for them explicitly. `Flyte.initFromConfig`
   * does default to `pkce`, because a flytectl-style config file implies an
   * interactive context; this is the one place the default differs, and it
   * matches the Go and Python SDKs.
   */
  mode?: AuthMode
  /** Shorthand for `{ mode: 'session' }` — use in browser / Next.js client components. */
  session?: boolean

  // --- client_credentials (server, CI, scripts) ---
  /** Base64 API key: `endpoint:clientId:clientSecret:org`. */
  apiKey?: string
  clientId?: string
  clientSecret?: string
  /** Name of an environment variable holding the client secret. */
  clientSecretEnvVar?: string
  /** Path of a file holding the client secret (read lazily; Node only). */
  clientSecretLocation?: string
  tokenEndpoint?: string
  scopes?: string[]
  audience?: string
  clientAuthMethod?: ClientAuthMethod

  // --- bearer (browser with short-lived token from your BFF) ---
  /** Static bearer access token. Never use long-lived secrets here. */
  bearerToken?: string
  /** Returns a fresh access token per request (or on cache miss). */
  getAccessToken?: () => Promise<string>

  // --- pkce / device_flow (interactive login, Node) ---
  /**
   * Give up on the browser login after this long. Default 10 minutes —
   * generous, since users may need to type credentials and pass MFA.
   */
  browserTimeoutMs?: number
  /** Give up on the device-flow login after this long. Default 10 minutes. */
  deviceFlowTimeoutMs?: number
  /** Device-flow polling interval. Default 5 seconds. */
  devicePollIntervalMs?: number
  /**
   * Called with the code and verification URL during device-flow login.
   * Defaults to printing them to the console.
   */
  onDeviceAuthorization?: (info: DeviceAuthorizationInfo) => void
  /**
   * Disable the on-disk token cache used by interactive logins (PKCE,
   * device flow), forcing a fresh login per process.
   */
  disableTokenCache?: boolean
  /**
   * Where interactive logins persist their tokens. Defaults to a file cache
   * under `~/.flyte`; supply your own to share a store with another process
   * or to keep tokens in a secret manager. Ignored when
   * {@link disableTokenCache} is set.
   */
  tokenCache?: TokenCache

  // --- external_command (token minted by another program) ---
  /** Command (argv) that prints a bearer access token to stdout. */
  command?: string[]

  /**
   * Command (argv) that prints a token for an authenticating proxy in front
   * of the control plane. Sent as `proxy-authorization` on every request.
   * Independent of {@link mode}; Node only.
   */
  proxyCommand?: string[]

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
   * Default org for requests. Derived from the API key or, failing that, the
   * endpoint hostname's first DNS label (`acme` for `acme.example.com`) —
   * matching the Go and Python SDKs. Can still be overridden per call.
   */
  org?: string
  /** Default project for runs and task lookups. Can be overridden per call. */
  project?: string
  /** Default domain for runs and task lookups. Can be overridden per call. */
  domain?: string
  /** Use plain HTTP (local development). */
  insecure?: boolean
  /**
   * Skip server certificate verification. Node only, and unsafe — prefer
   * {@link caCertFilePath} for private CAs.
   */
  insecureSkipVerify?: boolean
  /**
   * Path to a PEM CA bundle used to verify the server, for clusters behind a
   * private or enterprise CA. Node only.
   */
  caCertFilePath?: string
  auth?: AuthOptions
  headers?: Record<string, string>
  /**
   * Retry policy for unary RPCs that fail with `Unavailable`. Defaults to 4
   * retries with linear backoff; pass `{ maxRetries: 0 }` to disable.
   */
  retry?: RetryOptions
  /**
   * How runs launched by this client are attributed in the console. Defaults
   * to `'web'` — this SDK is normally embedded in a service or web app. Use
   * `'cli'` when building a command-line tool.
   */
  runSource?: RunSourceName
}

/** How a run was launched, as recorded on the run. */
export type RunSourceName = 'web' | 'cli' | 'unspecified'

interface ClientCredentialsAuth {
  mode: 'client_credentials'
  clientId: string
  clientSecret?: string
  /** Path of a file holding the client secret, read lazily at token time. */
  clientSecretLocation?: string
  tokenEndpoint?: string
  /** Scopes to request; the fallback default when none were configured. */
  scopes: string[]
  /** True when the caller pinned the scopes, so discovery must not override. */
  scopesExplicit: boolean
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

interface PkceAuth {
  mode: 'pkce'
  browserTimeoutMs: number
  scopes?: string[]
  audience?: string
  disableTokenCache: boolean
  tokenCache?: TokenCache
  authorizationHeader: string
}

interface DeviceFlowAuth {
  mode: 'device_flow'
  timeoutMs: number
  pollIntervalMs: number
  scopes?: string[]
  audience?: string
  onDeviceAuthorization?: (info: DeviceAuthorizationInfo) => void
  disableTokenCache: boolean
  tokenCache?: TokenCache
  authorizationHeader: string
}

interface ExternalCommandAuth {
  mode: 'external_command'
  command: string[]
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
  | PkceAuth
  | DeviceFlowAuth
  | ExternalCommandAuth
  | AnonymousAuth

export interface ResolvedConfig {
  endpoint: string
  org?: string
  project?: string
  domain?: string
  headers: Record<string, string>
  auth: ResolvedAuth
  retry?: RetryOptions
  tls?: TlsOptions
  /** Command that mints `proxy-authorization` tokens, when configured. */
  proxyCommand?: string[]
  runSource: RunSourceName
}

/** Server-certificate trust settings. Node only. */
export interface TlsOptions {
  insecureSkipVerify?: boolean
  caCertFilePath?: string
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

export function normalizeEndpoint(endpoint: string, insecure = false): string {
  let e = endpoint.trim()
  e = e.replace(/^dns:\/\/\//, '')
  if (insecure) {
    e = e.replace(/^https?:\/\//, '')
    e = `http://${e}`
  } else if (!/^https?:\/\//.test(e)) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(e)
    e = `${isLocal ? 'http' : 'https'}://${e}`
  }
  return e.replace(/\/+$/, '')
}

/**
 * Derives the org from the endpoint hostname's first DNS label, matching the
 * Go and Python SDKs: `acme.example.com` → `acme`. Hostnames with two or
 * fewer labels — and IP literals, whose octets are not DNS labels — yield
 * `undefined`.
 */
export function orgFromEndpoint(endpoint: string): string | undefined {
  let host = endpoint.trim().replace(/^dns:\/\/\//, '').replace(/^https?:\/\//, '')
  host = host.split('/')[0] ?? ''
  // An IPv6 literal is bracketed; strip the brackets and any port.
  if (host.startsWith('[')) return undefined
  host = host.split(':')[0] ?? ''
  if (host.includes(':')) return undefined
  // 127.0.0.1 has four "labels" but no org in its first octet.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined
  const labels = host.split('.')
  return labels.length > 2 ? labels[0] : undefined
}

function env(name: string): string | undefined {
  const v = typeof process !== 'undefined' ? process.env?.[name] : undefined
  return v && v.length > 0 ? v : undefined
}

function inferAuthMode(auth: AuthOptions): AuthMode {
  if (auth.mode) return auth.mode
  if (auth.session) return 'session'
  if (
    auth.apiKey ||
    (auth.clientId &&
      (auth.clientSecret || auth.clientSecretEnvVar || auth.clientSecretLocation))
  ) {
    return 'client_credentials'
  }
  if (auth.bearerToken || auth.getAccessToken) return 'bearer'
  if (auth.command && auth.command.length > 0) return 'external_command'
  return 'anonymous'
}

const TEN_MINUTES_MS = 10 * 60 * 1000

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
        auth.clientSecret ??
        decoded?.clientSecret ??
        (auth.clientSecretEnvVar ? env(auth.clientSecretEnvVar) : undefined) ??
        env('FLYTE_CLIENT_SECRET')
      if (!clientId || (!clientSecret && !auth.clientSecretLocation)) {
        throw new FlyteConfigError(
          'client_credentials auth requires apiKey, or clientId plus a client secret ' +
            '(clientSecret, clientSecretEnvVar, or clientSecretLocation).',
        )
      }
      return {
        mode: 'client_credentials',
        clientId,
        clientSecret,
        clientSecretLocation: clientSecret ? undefined : auth.clientSecretLocation,
        tokenEndpoint: auth.tokenEndpoint,
        scopes: auth.scopes ?? ['all'],
        scopesExplicit: (auth.scopes?.length ?? 0) > 0,
        audience: auth.audience,
        authorizationHeader,
        clientAuthMethod: auth.clientAuthMethod ?? 'basic',
      }
    }

    case 'pkce':
      return {
        mode: 'pkce',
        browserTimeoutMs: auth.browserTimeoutMs ?? TEN_MINUTES_MS,
        scopes: auth.scopes,
        audience: auth.audience,
        disableTokenCache: auth.disableTokenCache ?? false,
        tokenCache: auth.tokenCache,
        authorizationHeader,
      }

    case 'device_flow':
      return {
        mode: 'device_flow',
        timeoutMs: auth.deviceFlowTimeoutMs ?? TEN_MINUTES_MS,
        pollIntervalMs: auth.devicePollIntervalMs ?? 5000,
        scopes: auth.scopes,
        audience: auth.audience,
        onDeviceAuthorization: auth.onDeviceAuthorization,
        disableTokenCache: auth.disableTokenCache ?? false,
        tokenCache: auth.tokenCache,
        authorizationHeader,
      }

    case 'external_command': {
      if (!auth.command || auth.command.length === 0) {
        throw new FlyteConfigError('auth.mode "external_command" requires command.')
      }
      return { mode: 'external_command', command: auth.command, authorizationHeader }
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
  const normalizedEndpoint = normalizeEndpoint(endpoint, config.insecure ?? false)

  const decodedOrg = decoded?.org && decoded.org !== 'None' ? decoded.org : undefined
  const org =
    config.org ??
    decodedOrg ??
    env('FLYTE_ORG') ??
    orgFromEndpoint(normalizedEndpoint)

  // Merge env API key into auth options for resolution when mode not explicit.
  const auth = resolveAuth({
    ...authInput,
    apiKey: authInput.apiKey ?? apiKey,
    clientId: authInput.clientId ?? decoded?.clientId,
    clientSecret: authInput.clientSecret ?? decoded?.clientSecret,
  })

  return {
    endpoint: normalizedEndpoint,
    org: org || undefined,
    project: config.project ?? env('FLYTE_PROJECT') ?? undefined,
    domain: config.domain ?? env('FLYTE_DOMAIN') ?? undefined,
    headers: { ...(config.headers ?? {}) },
    auth,
    retry: config.retry,
    runSource: config.runSource ?? 'web',
    proxyCommand:
      authInput.proxyCommand && authInput.proxyCommand.length > 0
        ? authInput.proxyCommand
        : undefined,
    tls:
      config.insecureSkipVerify || config.caCertFilePath
        ? {
            insecureSkipVerify: config.insecureSkipVerify,
            caCertFilePath: config.caCertFilePath,
          }
        : undefined,
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
