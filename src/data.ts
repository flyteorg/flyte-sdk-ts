/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/** Data upload/download helpers built on `DataProxyService`. */

import { create } from '@bufbuild/protobuf'

import type { ClientContext } from './context'
import { FlyteError } from './errors'
import { CreateUploadLocationRequestSchema } from './gen/flyteidl2/dataproxy/dataproxy_service_pb'

export interface UploadFileParams {
  /** Raw bytes to upload. */
  data: Uint8Array
  /** Project the upload location belongs to. Required. */
  project: string
  /** Domain the upload location belongs to. Required. */
  domain: string
  /** Org override. Defaults to the client's org. */
  org?: string
  /** Desired filename suffix, e.g. `input.csv` or `pre/fix/file.zip`. */
  filename?: string
  /** Deterministic path root instead of the content-hash-based one. */
  filenameRoot?: string
}

export interface UploadFileResult {
  /** Storage-native URI (e.g. `s3://bucket/...`) to reference in run inputs. */
  nativeUrl: string
  /** The signed URL that was used for the PUT (already consumed). */
  signedUrl: string
}

export class DataClient {
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Uploads a blob to the configured object store and returns its native URI.
   * Computes the required content MD5, requests a signed URL, and PUTs the bytes.
   */
  async uploadFile(params: UploadFileParams): Promise<UploadFileResult> {
    const { project, domain } = params
    const org = params.org ?? this.ctx.config.org
    if (!project || !domain) {
      throw new FlyteError('uploadFile requires project and domain on the call.')
    }

    const contentMd5 = await md5(params.data)

    const res = await this.ctx.services.dataproxy.createUploadLocation(
      create(CreateUploadLocationRequestSchema, {
        project,
        domain,
        org: org ?? '',
        filename: params.filename,
        filenameRoot: params.filenameRoot,
        contentMd5,
        contentLength: BigInt(params.data.byteLength),
        addContentMd5Metadata: true,
      }),
    )

    if (!res.signedUrl) {
      throw new FlyteError('CreateUploadLocation did not return a signed URL.')
    }

    const putRes = await this.ctx.fetch(res.signedUrl, {
      method: 'PUT',
      headers: res.headers ?? {},
      body: params.data as unknown as BodyInit,
    })
    if (!putRes.ok) {
      throw new FlyteError(
        `Upload PUT failed (${putRes.status} ${putRes.statusText}).`,
      )
    }

    return { nativeUrl: res.nativeUrl, signedUrl: res.signedUrl }
  }
}

/** Computes a 16-byte MD5 digest. Node-only (SubtleCrypto has no MD5). */
async function md5(data: Uint8Array): Promise<Uint8Array> {
  try {
    const { createHash } = await import('node:crypto')
    return new Uint8Array(createHash('md5').update(data).digest())
  } catch (cause) {
    throw new FlyteError(
      'Computing content MD5 requires the Node.js crypto module (uploads are not supported in the browser).',
      { cause },
    )
  }
}
