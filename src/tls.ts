/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Server-certificate trust configuration for Node, so the SDK can talk to
 * clusters behind a private or enterprise CA.
 *
 * Node's `fetch` takes TLS settings from an undici dispatcher rather than
 * per-request options, so this builds a dispatcher and returns a `fetch`
 * wrapper that uses it. In the browser there is nothing to configure and the
 * global `fetch` is returned unchanged.
 */

import type { TlsOptions } from './config'
import { FlyteConfigError } from './errors'

type FetchLike = typeof fetch

/**
 * Returns a `fetch` that honors {@link TlsOptions}, or `undefined` when no TLS
 * customization is needed (so the caller keeps the default `fetch`).
 */
export async function createTlsFetch(
  options: TlsOptions | undefined,
  baseFetch: FetchLike = fetch,
): Promise<FetchLike | undefined> {
  if (!options?.insecureSkipVerify && !options?.caCertFilePath) return undefined

  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new FlyteConfigError(
      'insecureSkipVerify and caCertFilePath are Node-only; the browser uses the ' +
        "host's certificate store.",
    )
  }

  // Node's fetch takes TLS settings only from an undici dispatcher, and undici
  // is not importable from stock Node, so it is an optional peer dependency.
  let undici: typeof import('undici')
  try {
    undici = await import('undici')
  } catch {
    throw new FlyteConfigError(
      'Setting insecureSkipVerify or caCertFilePath requires the "undici" package:\n' +
        '  npm install undici\n' +
        'Alternatively, trust a private CA process-wide without it by setting ' +
        'NODE_EXTRA_CA_CERTS=/path/to/ca.pem before starting Node.',
    )
  }

  const connect: { rejectUnauthorized?: boolean; ca?: string } = {}
  if (options.insecureSkipVerify) {
    connect.rejectUnauthorized = false
  }
  if (options.caCertFilePath) {
    const fs = await import('node:fs/promises')
    try {
      connect.ca = await fs.readFile(options.caCertFilePath, 'utf8')
    } catch (cause) {
      throw new FlyteConfigError(
        `Failed to read CA bundle from ${options.caCertFilePath}: ${String(cause)}`,
      )
    }
  }

  const dispatcher = new undici.Agent({ connect })
  return (input, init) =>
    baseFetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: unknown })
}
