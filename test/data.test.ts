/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { createHash } from 'node:crypto'

import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { DataClient } from '../src/data'
import { FlyteError } from '../src/errors'
import { CreateUploadLocationResponseSchema } from '../src/gen/flyteidl2/dataproxy/dataproxy_service_pb'
import { callArg, fakeContext } from './helpers/fakeContext'

const BYTES = new TextEncoder().encode('hello world')

function uploadFixture(
  overrides: {
    response?: ReturnType<typeof create<typeof CreateUploadLocationResponseSchema>>
    putStatus?: number
  } = {},
) {
  const createUploadLocation = vi.fn(async () =>
    overrides.response ??
    create(CreateUploadLocationResponseSchema, {
      signedUrl: 'https://store.example.com/signed?sig=abc',
      nativeUrl: 's3://bucket/prefix/hello.txt',
      headers: { 'content-md5': 'ignored' },
    }),
  )
  const put = vi.fn(async () => new Response('', { status: overrides.putStatus ?? 200 }))
  const { ctx } = fakeContext({
    services: { dataproxy: { createUploadLocation } as never },
    fetch: put as never,
  })
  return { data: new DataClient(ctx), createUploadLocation, put }
}

describe('DataClient.uploadFile', () => {
  it('requests a location, PUTs the bytes, and returns the native URL', async () => {
    const { data, createUploadLocation, put } = uploadFixture()

    const result = await data.uploadFile({
      data: BYTES,
      project: 'my-project',
      domain: 'development',
      filename: 'hello.txt',
    })

    expect(result).toEqual({
      nativeUrl: 's3://bucket/prefix/hello.txt',
      signedUrl: 'https://store.example.com/signed?sig=abc',
    })

    const req = callArg<{
      project: string
      domain: string
      org: string
      filename: string
      contentMd5: Uint8Array
      contentLength: bigint
      addContentMd5Metadata: boolean
    }>(createUploadLocation)
    expect(req).toMatchObject({
      project: 'my-project',
      domain: 'development',
      org: 'acme',
      filename: 'hello.txt',
      addContentMd5Metadata: true,
    })
    expect(req.contentLength).toBe(BigInt(BYTES.byteLength))
    // The store verifies the digest, so it must be the real MD5.
    expect(Buffer.from(req.contentMd5)).toEqual(createHash('md5').update(BYTES).digest())

    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://store.example.com/signed?sig=abc')
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({ 'content-md5': 'ignored' })
  })

  it('uses the client fetch so signed-URL uploads share its TLS settings', async () => {
    const { data, put } = uploadFixture()
    await data.uploadFile({ data: BYTES, project: 'p', domain: 'd' })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('falls back to the client org and honors an override', async () => {
    const { data, createUploadLocation } = uploadFixture()
    await data.uploadFile({ data: BYTES, project: 'p', domain: 'd', org: 'other-org' })
    expect(callArg<{ org: string }>(createUploadLocation).org).toBe('other-org')
  })

  it('requires project and domain', async () => {
    const { data } = uploadFixture()
    await expect(
      data.uploadFile({ data: BYTES, project: '', domain: 'd' }),
    ).rejects.toThrow(/requires project and domain/)
  })

  it('reports a location response with no signed URL', async () => {
    const { data } = uploadFixture({
      response: create(CreateUploadLocationResponseSchema, { nativeUrl: 's3://x' }),
    })
    await expect(
      data.uploadFile({ data: BYTES, project: 'p', domain: 'd' }),
    ).rejects.toThrow(/did not return a signed URL/)
  })

  it('reports a failed PUT with its status', async () => {
    const { data } = uploadFixture({ putStatus: 403 })
    const err = await data
      .uploadFile({ data: BYTES, project: 'p', domain: 'd' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FlyteError)
    expect((err as Error).message).toMatch(/Upload PUT failed \(403/)
  })
})
