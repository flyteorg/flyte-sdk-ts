/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Connect transport construction with auth + static headers wired in. */

import { type Interceptor, type Transport } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'

import {
  createAuthErrorInterceptor,
  createBearerAuthInterceptor,
  createBearerInterceptor,
  createCredentialsFetch,
  createDynamicBearerInterceptor,
  createHeadersInterceptor,
  TokenManager,
} from './auth'
import type { ResolvedConfig } from './config'
import {
  createOrgInterceptor,
  createProxyAuthInterceptor,
  createRetryInterceptor,
} from './interceptors'
import { externalCommandToken, OAuthTokenManager } from './oauth'

export interface TransportBundle {
  transport: Transport
  clusterTransport: (baseUrl: string) => Transport
  tokenManager?: TokenManager
}

function buildInterceptors(
  config: ResolvedConfig,
  baseFetch?: typeof fetch,
): Interceptor[] {
  // Retry outermost, so a retried attempt re-runs the auth and org
  // interceptors and picks up a fresh token.
  const interceptors: Interceptor[] = [createRetryInterceptor(config.retry)]

  if (config.org) {
    interceptors.push(createOrgInterceptor(config.org))
  }

  if (config.proxyCommand) {
    const command = config.proxyCommand
    interceptors.push(createProxyAuthInterceptor(() => externalCommandToken(command)))
  }

  if (Object.keys(config.headers).length > 0) {
    interceptors.push(createHeadersInterceptor(config.headers))
  }

  switch (config.auth.mode) {
    case 'client_credentials':
      break
    case 'bearer':
      interceptors.push(
        createBearerInterceptor(config.auth.bearerToken, config.auth.authorizationHeader),
      )
      break
    case 'bearer_dynamic':
      interceptors.push(
        createDynamicBearerInterceptor(
          config.auth.getAccessToken,
          config.auth.authorizationHeader,
        ),
      )
      break
    case 'pkce':
    case 'device_flow': {
      const manager = new OAuthTokenManager(config.endpoint, config.auth, {
        cache: config.auth.tokenCache,
        fetch: baseFetch,
      })
      interceptors.push(
        createBearerAuthInterceptor(manager, config.auth.authorizationHeader),
      )
      break
    }
    case 'external_command': {
      const { command } = config.auth
      // External commands mint opaque tokens with unknown lifetimes; re-run
      // the command at most every 5 minutes, or immediately after a 401.
      let cached: { token: string; expiresAtMs: number } | undefined
      interceptors.push(
        createBearerAuthInterceptor(
          {
            async getToken() {
              if (cached && Date.now() < cached.expiresAtMs) return cached.token
              const token = await externalCommandToken(command)
              cached = { token, expiresAtMs: Date.now() + 5 * 60 * 1000 }
              return token
            },
            invalidate() {
              cached = undefined
            },
          },
          config.auth.authorizationHeader,
        ),
      )
      break
    }
    case 'session':
      if (config.auth.onAuthRequired) {
        interceptors.push(createAuthErrorInterceptor(config.auth.onAuthRequired))
      }
      break
    case 'anonymous':
      break
  }

  return interceptors
}

function transportOptions(
  config: ResolvedConfig,
  baseUrl: string,
  interceptors: Interceptor[],
  baseFetch?: typeof fetch,
): { baseUrl: string; interceptors: Interceptor[]; fetch?: typeof fetch } {
  const opts: {
    baseUrl: string
    interceptors: Interceptor[]
    fetch?: typeof fetch
  } = {
    baseUrl: baseUrl.replace(/\/+$/, '') || config.endpoint,
    interceptors,
  }

  if (config.auth.mode === 'session') {
    opts.fetch = createCredentialsFetch(
      opts.baseUrl,
      config.auth.credentials,
      config.auth.sendCredentialsOnLocalhost,
      baseFetch,
    )
  } else if (baseFetch) {
    opts.fetch = baseFetch
  }

  return opts
}

export function createTransports(
  config: ResolvedConfig,
  baseFetch?: typeof fetch,
): TransportBundle {
  let interceptors = buildInterceptors(config, baseFetch)

  let tokenManager: TokenManager | undefined
  if (config.auth.mode === 'client_credentials') {
    tokenManager = new TokenManager(config.endpoint, config.auth, baseFetch)
    interceptors = [
      ...interceptors,
      createBearerAuthInterceptor(tokenManager, config.auth.authorizationHeader),
    ]
  }

  const transport = createConnectTransport(
    transportOptions(config, config.endpoint, interceptors, baseFetch),
  )

  const clusterTransport = (clusterBaseUrl: string): Transport =>
    createConnectTransport(
      transportOptions(config, clusterBaseUrl, interceptors, baseFetch),
    )

  return { transport, clusterTransport, tokenManager }
}
