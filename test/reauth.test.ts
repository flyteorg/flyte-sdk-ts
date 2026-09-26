/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'

import { createBearerAuthInterceptor, type TokenSource } from '../src/auth'
import { RunService } from '../src/gen/flyteidl2/workflow/run_service_pb'

function unaryRequest() {
  return {
    stream: false as const,
    message: {},
    method: RunService.method.createRun,
    header: new Headers(),
  }
}

function streamRequest() {
  return {
    stream: true as const,
    message: {},
    method: RunService.method.watchActionDetails,
    header: new Headers(),
  }
}

/** A token source handing out `token-1`, `token-2`, … across invalidations. */
function rotatingSource(): TokenSource & { minted: () => number } {
  let generation = 1
  let minted = 0
  return {
    async getToken() {
      minted++
      return `token-${generation}`
    },
    invalidate() {
      generation++
    },
    minted: () => minted,
  }
}

describe('createBearerAuthInterceptor', () => {
  it('attaches the token as a bearer header', async () => {
    const next = vi.fn(async (req: { header: Headers }) => req.header.get('authorization'))
    const interceptor = createBearerAuthInterceptor(rotatingSource(), 'authorization')

    expect(await interceptor(next as never)(unaryRequest() as never)).toBe('Bearer token-1')
  })

  it('invalidates and retries once on Unauthenticated', async () => {
    // A token can be unexpired locally but already revoked server-side.
    const source = rotatingSource()
    const next = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new ConnectError('stale', Code.Unauthenticated)
      })
      .mockImplementationOnce(async (req: { header: Headers }) =>
        req.header.get('authorization'),
      )
    const interceptor = createBearerAuthInterceptor(source, 'authorization')

    const sent = await interceptor(next as never)(unaryRequest() as never)

    expect(sent).toBe('Bearer token-2')
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('does not retry more than once', async () => {
    const source = rotatingSource()
    const next = vi.fn(() => {
      throw new ConnectError('always stale', Code.Unauthenticated)
    })
    const interceptor = createBearerAuthInterceptor(source, 'authorization')

    await expect(interceptor(next as never)(unaryRequest() as never)).rejects.toThrow(
      /always stale/,
    )
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('does not invalidate on other errors', async () => {
    const source = rotatingSource()
    const invalidate = vi.spyOn(source, 'invalidate')
    const next = vi.fn(() => {
      throw new ConnectError('nope', Code.PermissionDenied)
    })
    const interceptor = createBearerAuthInterceptor(source, 'authorization')

    await expect(interceptor(next as never)(unaryRequest() as never)).rejects.toThrow()
    expect(invalidate).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not retry streaming calls', async () => {
    const source = rotatingSource()
    const next = vi.fn(() => {
      throw new ConnectError('stale', Code.Unauthenticated)
    })
    const interceptor = createBearerAuthInterceptor(source, 'authorization')

    await expect(interceptor(next as never)(streamRequest() as never)).rejects.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('sends both the custom and standard header outside a browser', async () => {
    const next = vi.fn(async (req: { header: Headers }) => ({
      standard: req.header.get('authorization'),
      custom: req.header.get('flyte-authorization'),
    }))
    const interceptor = createBearerAuthInterceptor(
      rotatingSource(),
      'flyte-authorization',
    )

    // Envoy accepts either, so Node sends both to work behind proxies.
    expect(await interceptor(next as never)(unaryRequest() as never)).toEqual({
      standard: 'Bearer token-1',
      custom: 'Bearer token-1',
    })
  })

  it('rejects an empty token', async () => {
    const next = vi.fn(async () => 'ok')
    const interceptor = createBearerAuthInterceptor(
      { getToken: async () => '   ', invalidate: () => {} },
      'authorization',
    )

    await expect(interceptor(next as never)(unaryRequest() as never)).rejects.toThrow(
      /Access token is empty/,
    )
    expect(next).not.toHaveBeenCalled()
  })
})
