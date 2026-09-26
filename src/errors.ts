/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { Code, ConnectError } from '@connectrpc/connect'

/** Base error for all Flyte client failures. */
export class FlyteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'FlyteError'
    if (options?.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/** Thrown when the client is misconfigured (missing endpoint, bad API key, ...). */
export class FlyteConfigError extends FlyteError {
  constructor(message: string) {
    super(message)
    this.name = 'FlyteConfigError'
  }
}

/** Thrown when authentication / token acquisition fails. */
export class FlyteAuthError extends FlyteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FlyteAuthError'
  }
}

/** Thrown when a run does not reach a terminal phase within the wait timeout. */
export class FlyteTimeoutError extends FlyteError {
  constructor(message: string) {
    super(message)
    this.name = 'FlyteTimeoutError'
  }
}

/** Thrown when a referenced task, run, or action does not exist. */
export class FlyteNotFoundError extends FlyteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FlyteNotFoundError'
  }
}

/** Thrown when creating a resource that already exists (e.g. a named run). */
export class FlyteAlreadyExistsError extends FlyteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FlyteAlreadyExistsError'
  }
}

/**
 * Thrown when a run or action ends in a non-success terminal phase
 * (FAILED, ABORTED, or TIMED_OUT).
 */
export class FlyteRunFailedError extends FlyteError {
  constructor(
    message: string,
    /** Terminal phase name, e.g. `FAILED`. */
    readonly phase: string,
    /** Failure message reported by the platform, when available. */
    readonly errorMessage?: string,
  ) {
    super(message)
    this.name = 'FlyteRunFailedError'
  }
}

/** True when a Connect error carries the given status code. */
export function isConnectCode(err: unknown, code: Code): boolean {
  return err instanceof ConnectError && err.code === code
}
