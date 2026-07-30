/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * flyte-sdk-ts — official JavaScript/TypeScript client for Flyte 2.
 *
 * One client, all the options: trigger runs, track status, fetch outputs,
 * upload data. Works in the browser (session or bearer auth), Next.js client
 * components, server routes, Node scripts, and CI.
 */

export { Flyte } from './client'
export type { TaskRef, TaskInput, RunArgs, RunScope } from './client'

export { RunHandle } from './run'
export type { WaitOptions } from './run'

export { DataClient } from './data'
export type { UploadFileParams, UploadFileResult } from './data'

export { ActionPhase, phaseName, isTerminal, isSuccess } from './phase'

export { resolveConfig, decodeApiKey, normalizeEndpoint } from './config'
export type {
  FlyteConfig,
  AuthOptions,
  AuthMode,
  ClientAuthMethod,
  ResolvedConfig,
  ResolvedAuth,
} from './config'

export {
  TokenManager,
  buildLoginUrl,
  discoverOAuth2Metadata,
  discoverPublicClientConfig,
  refreshSession,
  redirectToLogin,
  createAuthInterceptor,
  createBrowserAuth,
} from './auth'

export {
  FlyteError,
  FlyteConfigError,
  FlyteAuthError,
  FlyteTimeoutError,
} from './errors'
