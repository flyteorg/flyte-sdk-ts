/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

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
