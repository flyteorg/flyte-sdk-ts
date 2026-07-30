/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Connect transport construction with auth + static headers wired in. */

import { type Interceptor, type Transport } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'

import {
  createAuthErrorInterceptor,
  createBearerInterceptor,
  createCredentialsFetch,
  createDynamicBearerInterceptor,
  createHeadersInterceptor,
  createTokenManagerInterceptor,
  TokenManager,
} from './auth'
import type { ResolvedConfig } from './config'

export interface TransportBundle {
  transport: Transport
  clusterTransport: (baseUrl: string) => Transport
  tokenManager?: TokenManager
}

function buildInterceptors(config: ResolvedConfig): Interceptor[] {
  const interceptors: Interceptor[] = []

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
    )
  }

  return opts
}

export function createTransports(config: ResolvedConfig): TransportBundle {
  let interceptors = buildInterceptors(config)

  let tokenManager: TokenManager | undefined
  if (config.auth.mode === 'client_credentials') {
    tokenManager = new TokenManager(config.endpoint, config.auth)
    interceptors = [
      ...interceptors,
      createTokenManagerInterceptor(tokenManager, config.auth.authorizationHeader),
    ]
  }

  const transport = createConnectTransport(
    transportOptions(config, config.endpoint, interceptors),
  )

  const clusterTransport = (clusterBaseUrl: string): Transport =>
    createConnectTransport(
      transportOptions(config, clusterBaseUrl, interceptors),
    )

  return { transport, clusterTransport, tokenManager }
}
