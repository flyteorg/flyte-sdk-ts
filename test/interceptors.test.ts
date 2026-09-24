/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'

import { RunIdentifierSchema } from '../src/gen/flyteidl2/common/identifier_pb'
import {
  CreateRunRequestSchema,
  ListRunsRequestSchema,
} from '../src/gen/flyteidl2/workflow/run_service_pb'
import { RunService } from '../src/gen/flyteidl2/workflow/run_service_pb'
import { TaskIdentifierSchema } from '../src/gen/flyteidl2/task/task_definition_pb'
import { ProjectIdentifierSchema } from '../src/gen/flyteidl2/common/identifier_pb'
import {
  createOrgInterceptor,
  createProxyAuthInterceptor,
  createRetryInterceptor,
} from '../src/interceptors'

/** A minimal unary request as an interceptor sees it. */
function unaryRequest(
  message: unknown,
  method = RunService.method.createRun,
  service = RunService,
) {
  return {
    stream: false as const,
    message,
    method,
    service,
    header: new Headers(),
    signal: undefined as AbortSignal | undefined,
  }
}

function streamRequest() {
  return {
    stream: true as const,
    message: {},
    method: RunService.method.watchActionDetails,
    service: RunService,
    header: new Headers(),
  }
}

describe('createRetryInterceptor', () => {
  it('passes a successful call through untouched', async () => {
    const next = vi.fn(async () => 'ok')
    const interceptor = createRetryInterceptor()
    expect(await interceptor(next as never)(unaryRequest({}) as never)).toBe('ok')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('retries Unavailable and succeeds', async () => {
    const next = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('down', Code.Unavailable))
      .mockRejectedValueOnce(new ConnectError('down', Code.Unavailable))
      .mockResolvedValueOnce('ok')
    const interceptor = createRetryInterceptor({ backoffMs: 1 })

    expect(await interceptor(next as never)(unaryRequest({}) as never)).toBe('ok')
    expect(next).toHaveBeenCalledTimes(3)
  })

  it('gives up after maxRetries and rethrows the last error', async () => {
    const next = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable))
    const interceptor = createRetryInterceptor({ maxRetries: 2, backoffMs: 1 })

    await expect(interceptor(next as never)(unaryRequest({}) as never)).rejects.toThrow(
      /down/,
    )
    // Initial attempt plus two retries.
    expect(next).toHaveBeenCalledTimes(3)
  })

  it('does not retry when maxRetries is 0', async () => {
    const next = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable))
    const interceptor = createRetryInterceptor({ maxRetries: 0 })

    await expect(interceptor(next as never)(unaryRequest({}) as never)).rejects.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['InvalidArgument', Code.InvalidArgument],
    ['NotFound', Code.NotFound],
    ['AlreadyExists', Code.AlreadyExists],
    ['PermissionDenied', Code.PermissionDenied],
    ['Unauthenticated', Code.Unauthenticated],
  ])('does not retry %s', async (_name, code) => {
    // Only Unavailable is safe to replay: anything the server actually
    // answered may have taken effect.
    const next = vi.fn().mockRejectedValue(new ConnectError('nope', code))
    const interceptor = createRetryInterceptor({ backoffMs: 1 })

    await expect(interceptor(next as never)(unaryRequest({}) as never)).rejects.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('leaves streaming calls alone', async () => {
    const next = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable))
    const interceptor = createRetryInterceptor({ backoffMs: 1 })

    await expect(interceptor(next as never)(streamRequest() as never)).rejects.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('caps the backoff delay', async () => {
    const next = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('down', Code.Unavailable))
      .mockResolvedValueOnce('ok')
    const interceptor = createRetryInterceptor({ backoffMs: 10_000, maxBackoffMs: 5 })

    const started = Date.now()
    await interceptor(next as never)(unaryRequest({}) as never)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('times out a hung attempt and reports DeadlineExceeded', async () => {
    // A call that never settles must not stall the caller forever.
    const next = vi.fn(
      (req: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener('abort', () =>
            reject(new ConnectError('aborted', Code.Canceled)),
          )
        }),
    )
    const interceptor = createRetryInterceptor({
      maxRetries: 0,
      perAttemptTimeoutMs: 20,
    })

    const err = await interceptor(next as never)(unaryRequest({}) as never).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConnectError)
    expect((err as ConnectError).code).toBe(Code.DeadlineExceeded)
    expect((err as ConnectError).message).toMatch(/did not respond within 20ms/)
  })

  it('retries a timed-out attempt', async () => {
    let call = 0
    const next = vi.fn((req: { signal?: AbortSignal }) => {
      if (call++ === 0) {
        return new Promise((_r, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return Promise.resolve('ok')
    })
    const interceptor = createRetryInterceptor({
      backoffMs: 1,
      perAttemptTimeoutMs: 20,
    })

    expect(await interceptor(next as never)(unaryRequest({}) as never)).toBe('ok')
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController()
    const next = vi.fn(async () => {
      controller.abort()
      throw new ConnectError('down', Code.Unavailable)
    })
    const interceptor = createRetryInterceptor({ backoffMs: 1 })
    const req = { ...unaryRequest({}), signal: controller.signal }

    await expect(interceptor(next as never)(req as never)).rejects.toThrow(/down/)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('disables the deadline when perAttemptTimeoutMs is 0', async () => {
    const next = vi.fn(async (req: { signal?: AbortSignal }) => {
      expect(req.signal).toBeUndefined()
      return 'ok'
    })
    const interceptor = createRetryInterceptor({ perAttemptTimeoutMs: 0 })
    expect(await interceptor(next as never)(unaryRequest({}) as never)).toBe('ok')
  })
})

describe('createOrgInterceptor', () => {
  /**
   * Runs the interceptor and returns the message it forwarded. The method
   * must match the message: the interceptor walks `method.input`, so a
   * mismatched descriptor would silently find no fields.
   */
  async function intercept<T>(
    message: T,
    method: typeof RunService.method.createRun | typeof RunService.method.listRuns =
      RunService.method.createRun,
    org = 'acme',
  ): Promise<T> {
    const next = vi.fn(async (req: { message: T }) => req.message)
    return (await createOrgInterceptor(org)(next as never)(
      unaryRequest(message, method as never) as never,
    )) as T
  }

  it('fills an empty nested org field', async () => {
    const req = create(CreateRunRequestSchema, {
      id: {
        case: 'runId',
        value: create(RunIdentifierSchema, {
          project: 'p',
          domain: 'd',
          name: 'run-1',
        }),
      },
    })

    const sent = await intercept(req)

    expect(sent.id.case).toBe('runId')
    expect((sent.id.value as { org: string }).org).toBe('acme')
  })

  it('leaves an explicitly set org alone', async () => {
    const req = create(CreateRunRequestSchema, {
      id: {
        case: 'runId',
        value: create(RunIdentifierSchema, { org: 'explicit', name: 'run-1' }),
      },
    })

    const sent = await intercept(req)

    expect((sent.id.value as { org: string }).org).toBe('explicit')
  })

  it('recurses into both branches of a oneof', async () => {
    const req = create(CreateRunRequestSchema, {
      task: {
        case: 'taskId',
        value: create(TaskIdentifierSchema, { project: 'p', name: 'my_task' }),
      },
    })

    const sent = await intercept(req)

    expect((sent.task.value as { org: string }).org).toBe('acme')
  })

  it('fills the organization field, which ProjectIdentifier uses instead of org', async () => {
    // Without this, a raw `services.run.listRuns({ projectId })` call would
    // go out unscoped on a multi-tenant deployment.
    const req = create(ListRunsRequestSchema, {
      scopeBy: {
        case: 'projectId',
        value: create(ProjectIdentifierSchema, { name: 'p', domain: 'd' }),
      },
    })

    const sent = await intercept(req, RunService.method.listRuns)

    expect((sent.scopeBy.value as { organization: string }).organization).toBe('acme')
  })

  it('leaves an explicitly set organization alone', async () => {
    const req = create(ListRunsRequestSchema, {
      scopeBy: {
        case: 'projectId',
        value: create(ProjectIdentifierSchema, { organization: 'explicit', name: 'p' }),
      },
    })

    const sent = await intercept(req, RunService.method.listRuns)

    expect((sent.scopeBy.value as { organization: string }).organization).toBe('explicit')
  })

  it('skips a scalar org that is a oneof member, not an identifier field', async () => {
    // ListRunsRequest.scopeBy has an `org` *branch*; filling it would change
    // which branch is selected.
    const req = create(ListRunsRequestSchema, {
      scopeBy: {
        case: 'projectId',
        value: create(ProjectIdentifierSchema, { name: 'p' }),
      },
    })

    const sent = await intercept(req, RunService.method.listRuns)

    expect(sent.scopeBy.case).toBe('projectId')
  })

  it('tolerates a message with no org fields at all', async () => {
    const req = create(CreateRunRequestSchema, {})
    await expect(intercept(req)).resolves.toBeDefined()
  })

  it('leaves streaming requests untouched', async () => {
    const next = vi.fn(async () => 'ok')
    await createOrgInterceptor('acme')(next as never)(streamRequest() as never)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('createProxyAuthInterceptor', () => {
  it('sets a proxy-authorization header from the minted token', async () => {
    const next = vi.fn(async (req: { header: Headers }) => req.header.get('proxy-authorization'))
    const interceptor = createProxyAuthInterceptor(async () => 'proxy-token')

    const sent = await interceptor(next as never)(unaryRequest({}) as never)

    expect(sent).toBe('Bearer proxy-token')
  })

  it('caches the token across requests', async () => {
    const mint = vi.fn(async () => 'proxy-token')
    const next = vi.fn(async () => 'ok')
    const interceptor = createProxyAuthInterceptor(mint)

    await interceptor(next as never)(unaryRequest({}) as never)
    await interceptor(next as never)(unaryRequest({}) as never)

    // Minting usually shells out, so it must not run per request.
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('re-mints once the cache window elapses', async () => {
    const mint = vi.fn(async () => 'proxy-token')
    const next = vi.fn(async () => 'ok')
    const interceptor = createProxyAuthInterceptor(mint, 0)

    await interceptor(next as never)(unaryRequest({}) as never)
    await interceptor(next as never)(unaryRequest({}) as never)

    expect(mint).toHaveBeenCalledTimes(2)
  })
})
