/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Run customization options and the RunSpec they assemble — the TypeScript
 * equivalent of the Go SDK's RunOption / buildRunSpec (and the Python SDK's
 * with_runcontext parameters).
 */

import { create } from '@bufbuild/protobuf'

import { RelationSchema, RelationType } from './gen/flyteidl2/common/run_pb'
import { RunIdentifierSchema } from './gen/flyteidl2/common/identifier_pb'
import {
  IdentitySchema,
  SecurityContextSchema,
} from './gen/flyteidl2/core/security_pb'
import { KeyValuePairSchema } from './gen/flyteidl2/core/literals_pb'
import type { RunSpec } from './gen/flyteidl2/task/run_pb'
import {
  AnnotationsSchema,
  CacheConfigSchema,
  EnvsSchema,
  LabelsSchema,
  RawDataStorageSchema,
  RecoverSchema,
  RunSpecSchema,
} from './gen/flyteidl2/task/run_pb'

export { RelationType }

/** How a new run derives from an existing run in the same project/domain. */
export interface RunRelation {
  /** Name of the related run. */
  run: string
  /**
   * `rerun` records provenance only; `recover` additionally reuses the
   * outputs of actions that succeeded in the source run (set
   * {@link RunOptions.recoverFrom} instead for full recovery semantics);
   * `spawn` marks a run programmatically spawned by another run.
   */
  type: 'rerun' | 'recover' | 'spawn'
}

const RELATION_TYPES: Record<RunRelation['type'], RelationType> = {
  rerun: RelationType.RERUN,
  recover: RelationType.RECOVER,
  spawn: RelationType.SPAWN,
}

/** Options that customize a single run. All fields are optional. */
export interface RunOptions {
  /** Labels attached to the run. */
  labels?: Record<string, string>
  /** Annotations attached to the run. */
  annotations?: Record<string, string>
  /** Environment variables for the run's actions. */
  envVars?: Record<string, string>
  /** Marks the run (not) interruptible; platform default when omitted. */
  interruptible?: boolean
  /** Re-execute even when cached results exist. */
  overwriteCache?: boolean
  /** Queue (cluster) this run executes on. */
  queue?: string
  /** Max concurrently executing actions. 0 / omitted means unlimited. */
  maxActionConcurrency?: number
  /** Prefix where offloaded user data is written, e.g. `s3://bucket/prefix`. */
  rawDataPath?: string
  /** Base directory for run metadata (inputs.pb, outputs.pb). */
  runBaseDir?: string
  /** Kubernetes service account the run executes as. */
  serviceAccount?: string
  /** Records that this run derives from an existing run. */
  relation?: RunRelation
  /**
   * Creates this run as a recovery of the named run: actions that succeeded
   * (or were recovered) there are skipped and their outputs reused;
   * everything else re-executes. Implies `relation: { run, type: 'recover' }`.
   */
  recoverFrom?: string
  /**
   * Actions that must re-execute in a recovery run even when they succeeded
   * in the source run. Only meaningful with {@link recoverFrom}.
   */
  forceRerunActions?: string[]
}

/**
 * Assembles the RunSpec for a fresh run the same way the Go SDK's
 * buildRunSpec (and Python's _apply_overrides) does. Org/project/domain scope
 * the related-run reference; relations are always within one project/domain.
 */
export function buildRunSpec(
  options: RunOptions,
  scope: { org: string; project: string; domain: string },
): RunSpec {
  const spec = create(RunSpecSchema, {
    overwriteCache: options.overwriteCache ?? false,
    queue: options.queue ?? '',
    maxActionConcurrency: options.maxActionConcurrency ?? 0,
    runBaseDir: options.runBaseDir ?? '',
    cacheConfig: create(CacheConfigSchema, {
      overwriteCache: options.overwriteCache ?? false,
    }),
  })

  if (options.labels && Object.keys(options.labels).length > 0) {
    spec.labels = create(LabelsSchema, { values: options.labels })
  }
  if (options.annotations && Object.keys(options.annotations).length > 0) {
    spec.annotations = create(AnnotationsSchema, { values: options.annotations })
  }
  if (options.envVars && Object.keys(options.envVars).length > 0) {
    spec.envs = create(EnvsSchema, {
      values: Object.entries(options.envVars).map(([key, value]) =>
        create(KeyValuePairSchema, { key, value }),
      ),
    })
  }
  if (options.interruptible !== undefined) {
    spec.interruptible = options.interruptible
  }
  if (options.rawDataPath) {
    spec.rawDataStorage = create(RawDataStorageSchema, {
      rawDataPrefix: options.rawDataPath,
    })
  }
  if (options.serviceAccount) {
    spec.securityContext = create(SecurityContextSchema, {
      runAs: create(IdentitySchema, { k8sServiceAccount: options.serviceAccount }),
    })
  }

  const relatedRun = options.recoverFrom ?? options.relation?.run
  if (relatedRun) {
    const type = options.recoverFrom
      ? RelationType.RECOVER
      : RELATION_TYPES[options.relation!.type]
    spec.relation = create(RelationSchema, {
      relatedTo: create(RunIdentifierSchema, {
        org: scope.org,
        project: scope.project,
        domain: scope.domain,
        name: relatedRun,
      }),
      relationType: type,
    })
  }
  if (options.recoverFrom || (options.forceRerunActions?.length ?? 0) > 0) {
    spec.recover = create(RecoverSchema, {
      forceRerunActions: options.forceRerunActions ?? [],
    })
  }

  return spec
}
