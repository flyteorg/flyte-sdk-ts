/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Interactive OAuth2 flows for Node: browser-based PKCE, device flow, and
 * external token commands — the same login options as the Go and Python SDKs.
 *
 * The OAuth client (client id, redirect URI, scopes, audience) and endpoints
 * (authorize, token, device) are discovered from the control plane's anonymous
 * auth metadata service, so no client registration is needed.
 */

import type { DeviceAuthorizationInfo, ResolvedAuth } from './config'
import { FlyteAuthError } from './errors'
import { discoverOAuth2Metadata, discoverPublicClientConfig } from './auth'

/** An OAuth2 token as cached between runs. */
export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  /** Epoch millis after which the access token should not be used. */
  expiresAtMs?: number
}

/** Persists tokens between logins so interactive flows don't re-prompt. */
export interface TokenCache {
  get(): Promise<OAuthToken | undefined>
  save(token: OAuthToken): Promise<void>
  clear(): Promise<void>
}

export class MemoryTokenCache implements TokenCache {
  private token: OAuthToken | undefined
  async get(): Promise<OAuthToken | undefined> {
    return this.token
  }
  async save(token: OAuthToken): Promise<void> {
    this.token = token
  }
  async clear(): Promise<void> {
    this.token = undefined
  }
}

/**
 * File-backed token cache at `~/.flyte/ts-sdk-token-cache.json` (0600), keyed
 * by endpoint. Node only.
 */
export class FileTokenCache implements TokenCache {
  constructor(
    private readonly endpoint: string,
    /** Overrides the default cache file location. */
    private readonly filePath?: string,
  ) {}

  private async cachePath(): Promise<string> {
    if (this.filePath) return this.filePath
    const [os, path] = await Promise.all([import('node:os'), import('node:path')])
    return path.join(os.homedir(), '.flyte', 'ts-sdk-token-cache.json')
  }

  private async readAll(): Promise<Record<string, OAuthToken>> {
    const fs = await import('node:fs/promises')
    try {
      const raw = await fs.readFile(await this.cachePath(), 'utf8')
      return JSON.parse(raw) as Record<string, OAuthToken>
    } catch {
      return {}
    }
  }

  private async writeAll(all: Record<string, OAuthToken>): Promise<void> {
    const [fs, path] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ])
    const file = await this.cachePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(all, null, 2), { mode: 0o600 })
    await fs.chmod(file, 0o600).catch(() => {})
  }

  async get(): Promise<OAuthToken | undefined> {
    return (await this.readAll())[this.endpoint]
  }

  async save(token: OAuthToken): Promise<void> {
    const all = await this.readAll()
    all[this.endpoint] = token
    await this.writeAll(all)
  }

  async clear(): Promise<void> {
    const all = await this.readAll()
    delete all[this.endpoint]
    await this.writeAll(all)
  }
}

/** OAuth client + endpoints discovered from the control plane. */
export interface DiscoveredOAuthConfig {
  clientId: string
  redirectUri: string
  scopes: string[]
  audience?: string
  authorizationEndpoint: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
}

/**
 * Discovers the OAuth client config and endpoints (anonymous RPCs). Pass the
 * client's `fetch` so discovery honors its TLS trust settings.
 */
export async function discoverOAuthConfig(
  endpoint: string,
  fetchFn?: typeof fetch,
): Promise<DiscoveredOAuthConfig> {
  const [pub, meta] = await Promise.all([
    discoverPublicClientConfig(endpoint, fetchFn),
    discoverOAuth2Metadata(endpoint, fetchFn),
  ])
  if (!pub.clientId) {
    throw new FlyteAuthError('Public client config did not include a client id.')
  }
  if (!meta.tokenEndpoint || !meta.authorizationEndpoint) {
    throw new FlyteAuthError('OAuth2 metadata did not include token/authorization endpoints.')
  }
  return {
    clientId: pub.clientId,
    redirectUri: pub.redirectUri || 'http://localhost:53593/callback',
    scopes: pub.scopes ?? [],
    audience: pub.audience || undefined,
    authorizationEndpoint: meta.authorizationEndpoint,
    tokenEndpoint: meta.tokenEndpoint,
    deviceAuthorizationEndpoint: meta.deviceAuthorizationEndpoint || undefined,
  }
}

interface TokenEndpointResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const REFRESH_SKEW_MS = 5 * 60 * 1000

function toOAuthToken(json: TokenEndpointResponse, previousRefreshToken?: string): OAuthToken {
  if (!json.access_token) {
    throw new FlyteAuthError('Token response did not include an access_token.')
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefreshToken,
    expiresAtMs:
      json.expires_in !== undefined ? Date.now() + json.expires_in * 1000 : undefined,
  }
}

function isUsable(token: OAuthToken | undefined): token is OAuthToken {
  if (!token?.accessToken) return false
  if (token.expiresAtMs === undefined) return true
  return Date.now() < token.expiresAtMs - REFRESH_SKEW_MS
}

async function postForm(
  url: string,
  form: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<TokenEndpointResponse> {
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form),
    })
  } catch (cause) {
    throw new FlyteAuthError(`Token request to ${url} failed.`, { cause })
  }
  let json: TokenEndpointResponse
  try {
    json = (await res.json()) as TokenEndpointResponse
  } catch {
    throw new FlyteAuthError(
      `Token endpoint ${url} returned a non-JSON response (${res.status} ${res.statusText}).`,
    )
  }
  if (!res.ok && !json.error) {
    throw new FlyteAuthError(
      `Token request failed (${res.status} ${res.statusText}): ${JSON.stringify(json)}`,
    )
  }
  return json
}

/** Exchanges a refresh token for a fresh access token. */
export async function refreshAccessToken(
  config: DiscoveredOAuthConfig,
  refreshToken: string,
  fetchFn?: typeof fetch,
): Promise<OAuthToken> {
  const json = await postForm(
    config.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    },
    fetchFn,
  )
  if (json.error) {
    throw new FlyteAuthError(
      `Refresh token grant failed: ${json.error} ${json.error_description ?? ''}`.trim(),
    )
  }
  return toOAuthToken(json, refreshToken)
}

function randomUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return base64Url(buf)
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  const base64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(binary)
      : Buffer.from(bytes).toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The redirect URI PKCE falls back to when the server advertises a non-loopback one. */
const DEFAULT_LOOPBACK_REDIRECT = 'http://localhost:53593/callback'

/**
 * Returns the redirect URI to listen on. PKCE needs a loopback address,
 * because the SDK has to serve the callback itself; a console-oriented
 * deployment may advertise its own hostname, which cannot be bound here.
 */
export function loopbackRedirect(redirectUri: string): URL {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return new URL(DEFAULT_LOOPBACK_REDIRECT)
  }
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  return isLoopback ? url : new URL(DEFAULT_LOOPBACK_REDIRECT)
}

/** Computes the S256 PKCE code challenge for a verifier. Exposed for tests. */
export async function pkceCodeChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return base64Url(new Uint8Array(digest))
}

/** Opens a URL in the default browser (best effort; Node only). */
async function openBrowser(url: string): Promise<boolean> {
  try {
    const { spawn } = await import('node:child_process')
    const platform = process.platform
    const [cmd, args] =
      platform === 'darwin'
        ? ['open', [url]]
        : platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.unref()
    return await new Promise((resolve) => {
      child.on('error', () => resolve(false))
      child.on('spawn', () => resolve(true))
    })
  } catch {
    return false
  }
}

const CALLBACK_HTML = `<!doctype html><html><body style="font-family: system-ui; padding: 3rem">
<h2>Login successful</h2><p>You can close this tab and return to your terminal.</p>
</body></html>`

export interface PkceLoginOptions {
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number
  /** `fetch` for the code exchange, so TLS trust settings apply. */
  fetch?: typeof fetch
  /** Scope override; defaults to the discovered public client scopes. */
  scopes?: string[]
  /** Audience override; defaults to the discovered public client audience. */
  audience?: string
}

/**
 * Runs the browser-based PKCE authorization-code flow: starts a loopback
 * server on the discovered redirect URI, opens the browser at the authorize
 * URL, and exchanges the returned code for tokens. Node only.
 */
export async function pkceLogin(
  config: DiscoveredOAuthConfig,
  options: PkceLoginOptions = {},
): Promise<OAuthToken> {
  const http = await import('node:http')
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000

  // The authorize request, the code exchange, and the callback server must
  // all agree on one redirect URI, and it has to be one we can bind.
  const redirect = loopbackRedirect(config.redirectUri)
  const redirectUri = redirect.toString()
  const verifier = randomUrlSafe(48)
  const challenge = await pkceCodeChallenge(verifier)
  const state = randomUrlSafe(24)
  const nonce = randomUrlSafe(24)

  const authUrl = new URL(config.authorizationEndpoint)
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  const scopes = options.scopes ?? config.scopes
  if (scopes.length > 0) authUrl.searchParams.set('scope', scopes.join(' '))
  const audience = options.audience ?? config.audience
  if (audience) authUrl.searchParams.set('audience', audience)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('nonce', nonce)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  return await new Promise<OAuthToken>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Give the browser a beat to render the response page before closing.
      setTimeout(() => server.close(), 2000).unref?.()
      fn()
    }

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(CALLBACK_HTML)

      const err = url.searchParams.get('error')
      if (err) {
        finish(() =>
          reject(
            new FlyteAuthError(
              `Login failed: ${err} ${url.searchParams.get('error_description') ?? ''}`.trim(),
            ),
          ),
        )
        return
      }
      if (url.searchParams.get('state') !== state) {
        finish(() => reject(new FlyteAuthError('Login failed: state mismatch in callback.')))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        finish(() => reject(new FlyteAuthError('Login failed: callback had no code.')))
        return
      }
      postForm(
        config.tokenEndpoint,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          code_verifier: verifier,
        },
        options.fetch,
      )
        .then((json) => {
          if (json.error) {
            throw new FlyteAuthError(
              `Code exchange failed: ${json.error} ${json.error_description ?? ''}`.trim(),
            )
          }
          finish(() => resolve(toOAuthToken(json)))
        })
        .catch((e: unknown) =>
          finish(() =>
            reject(e instanceof FlyteAuthError ? e : new FlyteAuthError(String(e), { cause: e })),
          ),
        )
    })

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new FlyteAuthError(
            `Browser login did not complete within ${Math.round(timeoutMs / 1000)}s ` +
              '(increase auth.browserTimeoutMs if you need more time).',
          ),
        ),
      )
    }, timeoutMs)
    timer.unref?.()

    server.on('error', (e) =>
      finish(() =>
        reject(
          new FlyteAuthError(
            `Couldn't start the login callback server on ${redirect.host} ` +
              '(is another login in progress?).',
            { cause: e },
          ),
        ),
      ),
    )

    server.listen(Number(redirect.port) || 53593, redirect.hostname, () => {
      void openBrowser(authUrl.toString()).then((opened) => {
        if (!opened) {
          console.error(`Open this URL in your browser to log in:\n${authUrl.toString()}`)
        }
      })
    })
  })
}

export interface DeviceFlowLoginOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  /** `fetch` for the device and token requests, so TLS settings apply. */
  fetch?: typeof fetch
  scopes?: string[]
  audience?: string
  onDeviceAuthorization?: (info: DeviceAuthorizationInfo) => void
}

/** Runs the OAuth2 device-authorization flow (RFC 8628). Headless-friendly. */
export async function deviceFlowLogin(
  config: DiscoveredOAuthConfig,
  options: DeviceFlowLoginOptions = {},
): Promise<OAuthToken> {
  if (!config.deviceAuthorizationEndpoint) {
    throw new FlyteAuthError('The server does not advertise a device authorization endpoint.')
  }
  const scopes = options.scopes ?? config.scopes
  const audience = options.audience ?? config.audience

  const start = (await postForm(
    config.deviceAuthorizationEndpoint,
    {
      client_id: config.clientId,
      ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
      ...(audience ? { audience } : {}),
    },
    options.fetch,
  )) as TokenEndpointResponse & {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    interval?: number
    expires_in?: number
  }
  if (!start.device_code || !start.user_code || !start.verification_uri) {
    throw new FlyteAuthError('Device authorization response was missing required fields.')
  }

  const info: DeviceAuthorizationInfo = {
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    verificationUriComplete: start.verification_uri_complete,
  }
  if (options.onDeviceAuthorization) {
    options.onDeviceAuthorization(info)
  } else {
    console.error(
      `To log in, open ${info.verificationUriComplete ?? info.verificationUri} ` +
        `and confirm the code: ${info.userCode}`,
    )
  }

  let pollIntervalMs = options.pollIntervalMs ?? (start.interval ? start.interval * 1000 : 5000)
  const deadline =
    Date.now() + Math.min(options.timeoutMs ?? 10 * 60 * 1000, (start.expires_in ?? 600) * 1000)

  for (;;) {
    if (Date.now() >= deadline) {
      throw new FlyteAuthError('Device-flow login timed out before the code was confirmed.')
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    const json = await postForm(
      config.tokenEndpoint,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
        client_id: config.clientId,
      },
      options.fetch,
    )
    if (json.access_token) return toOAuthToken(json)
    switch (json.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        pollIntervalMs += 5000
        continue
      default:
        throw new FlyteAuthError(
          `Device-flow login failed: ${json.error} ${json.error_description ?? ''}`.trim(),
        )
    }
  }
}

/** Runs a user-provided command that prints an access token to stdout. */
export async function externalCommandToken(command: string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  const [cmd, ...args] = command
  if (!cmd) throw new FlyteAuthError('external_command auth requires a non-empty command.')
  return await new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        reject(new FlyteAuthError(`Token command "${command.join(' ')}" failed.`, { cause: err }))
        return
      }
      const token = stdout.trim()
      if (!token) {
        reject(new FlyteAuthError(`Token command "${command.join(' ')}" printed no token.`))
        return
      }
      resolve(token)
    })
  })
}

type InteractiveAuth = Extract<ResolvedAuth, { mode: 'pkce' | 'device_flow' }>

export interface OAuthTokenManagerOptions {
  /**
   * Where tokens are persisted between logins. Defaults to a file cache
   * unless `auth.disableTokenCache` is set.
   */
  cache?: TokenCache
  /**
   * A pre-discovered OAuth client config, to skip the anonymous discovery
   * round trip when the caller already has one.
   */
  oauthConfig?: DiscoveredOAuthConfig
  /** `fetch` for discovery and token requests, so TLS trust settings apply. */
  fetch?: typeof fetch
}

/**
 * Token acquisition for interactive flows: serves from cache, refreshes with
 * the refresh token, and falls back to a fresh login. Single-flight.
 */
export class OAuthTokenManager {
  private discovered: DiscoveredOAuthConfig | undefined
  private token: OAuthToken | undefined
  private inflight: Promise<string> | undefined
  private readonly cache: TokenCache
  private readonly fetchFn: typeof fetch

  constructor(
    private readonly endpoint: string,
    private readonly auth: InteractiveAuth,
    options: OAuthTokenManagerOptions = {},
  ) {
    this.cache =
      options.cache ??
      (auth.disableTokenCache ? new MemoryTokenCache() : new FileTokenCache(endpoint))
    this.discovered = options.oauthConfig
    this.fetchFn = options.fetch ?? fetch
  }

  async getToken(): Promise<string> {
    if (isUsable(this.token)) return this.token.accessToken
    if (!this.inflight) {
      this.inflight = this.acquire().finally(() => {
        this.inflight = undefined
      })
    }
    return this.inflight
  }

  /**
   * Drops the in-memory and persisted access token so the next
   * {@link getToken} refreshes or logs in again. The refresh token is kept,
   * so a revoked access token does not force a fresh browser login.
   */
  async invalidate(): Promise<void> {
    const refreshToken = this.token?.refreshToken ?? (await this.cache.get())?.refreshToken
    this.token = undefined
    if (refreshToken) {
      await this.cache.save({ accessToken: '', refreshToken, expiresAtMs: 0 })
    } else {
      await this.cache.clear()
    }
  }

  private async config(): Promise<DiscoveredOAuthConfig> {
    this.discovered ??= await discoverOAuthConfig(this.endpoint, this.fetchFn)
    return this.discovered
  }

  private async acquire(): Promise<string> {
    const cached = await this.cache.get()
    // Read the refresh token before the usability check narrows `cached` away.
    const staleRefreshToken = cached?.refreshToken
    if (isUsable(cached)) {
      this.token = cached
      return cached.accessToken
    }

    if (staleRefreshToken) {
      try {
        const refreshed = await refreshAccessToken(
          await this.config(),
          staleRefreshToken,
          this.fetchFn,
        )
        await this.cache.save(refreshed)
        this.token = refreshed
        return refreshed.accessToken
      } catch {
        // Refresh token expired or revoked — fall through to a fresh login.
      }
    }

    const token = await this.login()
    await this.cache.save(token)
    this.token = token
    return token.accessToken
  }

  private async login(): Promise<OAuthToken> {
    const config = await this.config()
    if (this.auth.mode === 'pkce') {
      return pkceLogin(config, {
        timeoutMs: this.auth.browserTimeoutMs,
        scopes: this.auth.scopes,
        audience: this.auth.audience,
        fetch: this.fetchFn,
      })
    }
    return deviceFlowLogin(config, {
      timeoutMs: this.auth.timeoutMs,
      pollIntervalMs: this.auth.pollIntervalMs,
      scopes: this.auth.scopes,
      audience: this.auth.audience,
      onDeviceAuthorization: this.auth.onDeviceAuthorization,
      fetch: this.fetchFn,
    })
  }
}
