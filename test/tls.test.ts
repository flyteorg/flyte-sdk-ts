/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createTlsFetch } from '../src/tls'
import { callArg } from './helpers/fakeContext'

/** A self-signed-looking PEM; only its bytes are checked, not its validity. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n'

describe('createTlsFetch', () => {
  it('returns undefined when no TLS customization is requested', async () => {
    // The caller then keeps the platform's own fetch.
    expect(await createTlsFetch(undefined)).toBeUndefined()
    expect(await createTlsFetch({})).toBeUndefined()
    expect(
      await createTlsFetch({ insecureSkipVerify: false, caCertFilePath: undefined }),
    ).toBeUndefined()
  })

  it('wraps fetch with a dispatcher when skipping verification', async () => {
    const base = vi.fn(async () => new Response('ok'))
    const tlsFetch = await createTlsFetch({ insecureSkipVerify: true }, base as never)

    expect(tlsFetch).toBeTypeOf('function')
    await tlsFetch!('https://acme.example.com/')

    // Node's fetch reads TLS settings from an undici dispatcher, not from
    // per-request options, so the wrapper must attach one.
    expect(callArg<{ dispatcher?: unknown }>(base, 0, 1).dispatcher).toBeDefined()
  })

  it('reads the CA bundle from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flyte-ca-'))
    const caPath = join(dir, 'ca.pem')
    await writeFile(caPath, CA_PEM)
    const base = vi.fn(async () => new Response('ok'))

    const tlsFetch = await createTlsFetch({ caCertFilePath: caPath }, base as never)
    await tlsFetch!('https://acme.example.com/')

    expect(callArg<{ dispatcher?: unknown }>(base, 0, 1).dispatcher).toBeDefined()
  })

  it('preserves the caller-supplied request init', async () => {
    const base = vi.fn(async () => new Response('ok'))
    const tlsFetch = await createTlsFetch({ insecureSkipVerify: true }, base as never)

    await tlsFetch!('https://acme.example.com/', { method: 'POST', body: 'hello' })

    const init = callArg<RequestInit>(base, 0, 1)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('hello')
  })

  it('reports an unreadable CA bundle with its path', async () => {
    await expect(
      createTlsFetch({ caCertFilePath: '/definitely/not/here.pem' }),
    ).rejects.toThrow(/Failed to read CA bundle from \/definitely\/not\/here\.pem/)
  })
})

describe('createTlsFetch without undici', () => {
  it('explains how to install undici and names the env-var alternative', async () => {
    // undici is an optional peer dependency; without it Node's fetch cannot
    // be given TLS settings at all.
    vi.doMock('undici', () => {
      throw new Error('Cannot find module undici')
    })
    vi.resetModules()
    const { createTlsFetch: freshCreateTlsFetch } = await import('../src/tls')

    const err = await freshCreateTlsFetch({ insecureSkipVerify: true }).catch(
      (e: unknown) => e,
    )

    // Compared by name, not instanceof: resetModules re-imports the errors
    // module too, so the fresh class is a different identity.
    expect((err as Error).name).toBe('FlyteConfigError')
    expect((err as Error).message).toMatch(/npm install undici/)
    expect((err as Error).message).toMatch(/NODE_EXTRA_CA_CERTS/)

    vi.doUnmock('undici')
    vi.resetModules()
  })
})
