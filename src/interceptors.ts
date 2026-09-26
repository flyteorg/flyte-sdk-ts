/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Transport-level interceptors that apply to every request: retrying
 * unavailable servers and filling in the default org.
 */

import type { DescField, DescMessage } from '@bufbuild/protobuf'
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect'

/** Retry and deadline policy for unary RPCs. */
export interface RetryOptions {
  /** Maximum retries after the initial attempt. Default 4; 0 disables retries. */
  maxRetries?: number
  /** Cap on the delay between attempts. Default 8000. */
  maxBackoffMs?: number
  /** Base delay; the nth retry waits `n` times this. Default 250. */
  backoffMs?: number
  /**
   * Deadline for each individual attempt. Default 30000; 0 disables it.
   * Applies to unary calls only — streams must stay open for the life of a
   * run.
   */
  perAttemptTimeoutMs?: number
}

/**
 * Retries unary RPCs that fail with `Unavailable`, using linear backoff, and
 * bounds each attempt with a deadline so a hung connection cannot stall the
 * caller forever.
 *
 * Only `Unavailable` and deadline expiry are retried: both mean the request
 * never produced a server answer, so replaying cannot duplicate work.
 * Streaming calls pass straight through — {@link watchActionPhases} handles
 * its own reconnects and must not be cut off by a deadline.
 */
export function createRetryInterceptor(options: RetryOptions = {}): Interceptor {
  const maxRetries = options.maxRetries ?? 4
  const maxBackoffMs = options.maxBackoffMs ?? 8000
  const backoffMs = options.backoffMs ?? 250
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? 30_000

  return (next) => async (req) => {
    if (req.stream) return next(req)
    // Bulk data transfers are sized by the user's payload, not by server
    // latency, so a fixed deadline would abort legitimate large uploads.
    const deadlineMs = carriesBulkData(req.service.typeName) ? 0 : perAttemptTimeoutMs
    for (let attempt = 0; ; attempt++) {
      const timeout = deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined
      try {
        return await next(
          timeout
            ? { ...req, signal: mergeSignals(req.signal, timeout) }
            : req,
        )
      } catch (err) {
        if (req.signal?.aborted) throw err
        const timedOut = timeout?.aborted === true
        const unavailable = err instanceof ConnectError && err.code === Code.Unavailable
        if (!(timedOut || unavailable) || attempt >= maxRetries) {
          throw timedOut
            ? new ConnectError(
                `${req.method.name} did not respond within ${deadlineMs}ms.`,
                Code.DeadlineExceeded,
                undefined,
                undefined,
                err,
              )
            : err
        }
        await sleep(Math.min((attempt + 1) * backoffMs, maxBackoffMs), req.signal)
      }
    }
  }
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b
}

/**
 * Services whose requests or responses carry user payloads (offloaded run
 * inputs, action data), where transfer time scales with the data rather than
 * with server responsiveness.
 */
function carriesBulkData(serviceName: string): boolean {
  return serviceName === 'flyteidl2.dataproxy.DataProxyService'
}

/**
 * Sends a `proxy-authorization` token, minted by an external command, on
 * every request — for deployments behind an authenticating proxy. The token
 * is cached briefly since the command usually shells out. Node only.
 */
export function createProxyAuthInterceptor(
  mintToken: () => Promise<string>,
  cacheMs = 5 * 60 * 1000,
): Interceptor {
  let cached: { token: string; expiresAtMs: number } | undefined
  return (next) => async (req) => {
    if (!cached || Date.now() >= cached.expiresAtMs) {
      cached = { token: await mintToken(), expiresAtMs: Date.now() + cacheMs }
    }
    req.header.set('proxy-authorization', `Bearer ${cached.token}`)
    return next(req)
  }
}

/**
 * Fills empty `org` fields on outgoing request messages with the configured
 * default org, recursing through nested messages, lists, and oneofs.
 *
 * The high-level client always sets `org` explicitly; this is a safety net for
 * nested identifiers and for callers reaching for the raw `flyte.services.*`
 * clients, so they don't have to thread the org through by hand.
 */
export function createOrgInterceptor(org: string): Interceptor {
  return (next) => async (req) => {
    if (!req.stream && req.message && typeof req.message === 'object') {
      fillOrg(req.message as Record<string, unknown>, req.method.input, org, new Set())
    }
    return next(req)
  }
}

function fillOrg(
  message: Record<string, unknown>,
  desc: DescMessage,
  org: string,
  seen: Set<object>,
): void {
  if (seen.has(message)) return
  seen.add(message)

  for (const field of desc.fields) {
    if (isOrgField(field)) {
      if (!message[field.localName]) message[field.localName] = org
      continue
    }
    if (field.oneof) {
      // A oneof is materialized as `{ case, value }` under the oneof's name.
      const slot = message[field.oneof.localName]
      if (!isRecord(slot) || slot.case !== field.localName) continue
      if (field.fieldKind === 'message' && isRecord(slot.value)) {
        fillOrg(slot.value, field.message, org, seen)
      }
      continue
    }
    if (field.fieldKind === 'message') {
      const value = message[field.localName]
      if (isRecord(value)) fillOrg(value, field.message, org, seen)
      continue
    }
    if (field.fieldKind === 'list' && field.listKind === 'message') {
      const items = message[field.localName]
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (isRecord(item)) fillOrg(item, field.message, org, seen)
      }
    }
  }
}

/**
 * True for the string field naming the organization. Identifier messages
 * spell it `org`, except `ProjectIdentifier`, which spells it `organization`.
 */
function isOrgField(field: DescField): boolean {
  return (
    field.fieldKind === 'scalar' &&
    (field.name === 'org' || field.name === 'organization') &&
    !field.oneof
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // An abort that already happened fires no event, so check it up front
  // rather than waiting out the full delay.
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}
