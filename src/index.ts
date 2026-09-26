/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * flyte-sdk-ts — official JavaScript/TypeScript client for Flyte 2.
 *
 * One client, all the options: trigger runs, stream status, fetch typed
 * outputs, signal conditions, upload data. Works in the browser (session or
 * bearer auth), Next.js client components, server routes, Node scripts, and
 * CI (API key, PKCE, device flow).
 */

export { Flyte } from './client'
export type { TaskInput, RunArgs, RunScope } from './client'

export { RunHandle } from './run'
export type { WaitOptions, RawRunData } from './run'

export { ActionHandle, ActionType } from './action'
export type { ActionWaitOptions } from './action'

export { ConditionHandle } from './condition'
export type { SignalValue } from './condition'

export { TaskDetails } from './task'
export type { TaskRef } from './task'

export { RelationType } from './options'
export type { RunOptions, RunRelation } from './options'
export { buildRunSpec } from './options'

export type { WatchOptions, WatchUpdate } from './watch'

export { DataClient } from './data'
export type { UploadFileParams, UploadFileResult } from './data'

export { ActionPhase, phaseName, isTerminal, isSuccess } from './phase'

/**
 * Protobuf types surfaced by the handles above, re-exported so consumers
 * don't have to import from `flyte-sdk-ts/gen/*`.
 */
export { ErrorInfo_Kind } from './gen/flyteidl2/workflow/run_definition_pb'
export type {
  AbortInfo,
  ActionAttempt,
  ActionDetails,
  ActionMetadata,
  ActionStatus,
  ConditionAction,
  ErrorInfo,
  Run,
  RunDetails,
  SignalInfo,
} from './gen/flyteidl2/workflow/run_definition_pb'
export type { RunSpec } from './gen/flyteidl2/task/run_pb'
export type { Inputs, Outputs, NamedLiteral } from './gen/flyteidl2/task/common_pb'
export type { TypedInterface, VariableMap } from './gen/flyteidl2/core/interface_pb'
export type {
  ActionIdentifier,
  RunIdentifier,
} from './gen/flyteidl2/common/identifier_pb'

export {
  resolveConfig,
  decodeApiKey,
  normalizeEndpoint,
  orgFromEndpoint,
} from './config'
export type {
  FlyteConfig,
  AuthOptions,
  AuthMode,
  ClientAuthMethod,
  DeviceAuthorizationInfo,
  ResolvedConfig,
  ResolvedAuth,
  RunSourceName,
  TlsOptions,
} from './config'

export {
  createOrgInterceptor,
  createProxyAuthInterceptor,
  createRetryInterceptor,
} from './interceptors'
export type { RetryOptions } from './interceptors'

export { loadConfigFile, parseConfigFile, findConfigPath } from './configFile'

export {
  TokenManager,
  buildLoginUrl,
  discoverOAuth2Metadata,
  discoverPublicClientConfig,
  refreshSession,
  redirectToLogin,
  createAuthInterceptor,
  createBearerAuthInterceptor,
  createBrowserAuth,
} from './auth'
export type { TokenSource } from './auth'

export { createTlsFetch } from './tls'

export {
  discoverOAuthConfig,
  pkceLogin,
  deviceFlowLogin,
  externalCommandToken,
  refreshAccessToken,
  OAuthTokenManager,
  FileTokenCache,
  MemoryTokenCache,
} from './oauth'
export type {
  OAuthToken,
  TokenCache,
  DiscoveredOAuthConfig,
  OAuthTokenManagerOptions,
  PkceLoginOptions,
  DeviceFlowLoginOptions,
} from './oauth'

export type { RunInputs } from './io'

export {
  FlyteError,
  FlyteConfigError,
  FlyteAuthError,
  FlyteTimeoutError,
  FlyteNotFoundError,
  FlyteAlreadyExistsError,
  FlyteRunFailedError,
} from './errors'
