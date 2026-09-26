/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { describe, expect, it } from 'vitest'

import { RelationType } from '../src/gen/flyteidl2/common/run_pb'
import { buildRunSpec, type RunOptions } from '../src/options'

const SCOPE = { org: 'acme', project: 'my-project', domain: 'development' }

const spec = (options: RunOptions = {}) => buildRunSpec(options, SCOPE)

describe('buildRunSpec', () => {
  it('produces a minimal spec with no options', () => {
    const s = spec()
    expect(s.labels).toBeUndefined()
    expect(s.annotations).toBeUndefined()
    expect(s.envs).toBeUndefined()
    expect(s.interruptible).toBeUndefined()
    expect(s.securityContext).toBeUndefined()
    expect(s.relation).toBeUndefined()
    expect(s.recover).toBeUndefined()
    expect(s.overwriteCache).toBe(false)
    expect(s.cacheConfig?.overwriteCache).toBe(false)
  })

  it('sets labels, annotations, and env vars', () => {
    const s = spec({
      labels: { team: 'ml' },
      annotations: { 'run-by': 'ci' },
      envVars: { LOG_LEVEL: 'DEBUG', REGION: 'us-east-1' },
    })
    expect(s.labels?.values).toEqual({ team: 'ml' })
    expect(s.annotations?.values).toEqual({ 'run-by': 'ci' })
    expect(s.envs?.values).toEqual([
      { $typeName: 'flyteidl2.core.KeyValuePair', key: 'LOG_LEVEL', value: 'DEBUG' },
      { $typeName: 'flyteidl2.core.KeyValuePair', key: 'REGION', value: 'us-east-1' },
    ])
  })

  it('omits empty label, annotation, and env maps', () => {
    const s = spec({ labels: {}, annotations: {}, envVars: {} })
    expect(s.labels).toBeUndefined()
    expect(s.annotations).toBeUndefined()
    expect(s.envs).toBeUndefined()
  })

  it('distinguishes an explicit interruptible=false from the platform default', () => {
    expect(spec({ interruptible: false }).interruptible).toBe(false)
    expect(spec({ interruptible: true }).interruptible).toBe(true)
    expect(spec({}).interruptible).toBeUndefined()
  })

  it('mirrors overwriteCache into the cache config', () => {
    const s = spec({ overwriteCache: true })
    expect(s.overwriteCache).toBe(true)
    expect(s.cacheConfig?.overwriteCache).toBe(true)
  })

  it('passes queue, concurrency, and run base dir through', () => {
    const s = spec({ queue: 'gpu-queue', maxActionConcurrency: 4, runBaseDir: 's3://meta' })
    expect(s.queue).toBe('gpu-queue')
    expect(s.maxActionConcurrency).toBe(4)
    expect(s.runBaseDir).toBe('s3://meta')
  })

  it('sets the raw data prefix', () => {
    expect(spec({ rawDataPath: 's3://bucket/prefix' }).rawDataStorage?.rawDataPrefix).toBe(
      's3://bucket/prefix',
    )
  })

  it('sets the run-as service account', () => {
    const s = spec({ serviceAccount: 'my-sa' })
    expect(s.securityContext?.runAs?.k8sServiceAccount).toBe('my-sa')
  })

  it('records a rerun relation scoped to the run project/domain', () => {
    const s = spec({ relation: { run: 'source-run', type: 'rerun' } })
    expect(s.relation?.relationType).toBe(RelationType.RERUN)
    expect(s.relation?.relatedTo).toMatchObject({
      org: 'acme',
      project: 'my-project',
      domain: 'development',
      name: 'source-run',
    })
    // A provenance-only rerun does not enable recovery semantics.
    expect(s.recover).toBeUndefined()
  })

  it('maps each relation type', () => {
    expect(spec({ relation: { run: 'r', type: 'spawn' } }).relation?.relationType).toBe(
      RelationType.SPAWN,
    )
    expect(spec({ relation: { run: 'r', type: 'recover' } }).relation?.relationType).toBe(
      RelationType.RECOVER,
    )
  })

  it('recoverFrom implies a recover relation and recovery semantics', () => {
    const s = spec({ recoverFrom: 'source-run' })
    expect(s.relation?.relationType).toBe(RelationType.RECOVER)
    expect(s.relation?.relatedTo?.name).toBe('source-run')
    expect(s.recover?.forceRerunActions).toEqual([])
  })

  it('carries force-rerun actions into the recover block', () => {
    const s = spec({ recoverFrom: 'source-run', forceRerunActions: ['a3', 'a7'] })
    expect(s.recover?.forceRerunActions).toEqual(['a3', 'a7'])
  })

  it('recoverFrom wins over a conflicting relation', () => {
    const s = spec({
      recoverFrom: 'recover-source',
      relation: { run: 'other-run', type: 'rerun' },
    })
    expect(s.relation?.relatedTo?.name).toBe('recover-source')
    expect(s.relation?.relationType).toBe(RelationType.RECOVER)
  })
})
