/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Test doubles for the generated Connect service clients, so the SDK's
 * behavior (input validation, ordering, fallbacks, retries) can be tested
 * without a control plane.
 */

import { create } from '@bufbuild/protobuf'
import type { JsonObject } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'

import type { ClientContext, Services } from '../../src/context'
import type { ResolvedConfig } from '../../src/config'
import type { VariableEntry, VariableMap } from '../../src/gen/flyteidl2/core/interface_pb'
import {
  TypedInterfaceSchema,
  VariableEntrySchema,
  VariableMapSchema,
  VariableSchema,
} from '../../src/gen/flyteidl2/core/interface_pb'
import type { Literal } from '../../src/gen/flyteidl2/core/literals_pb'
import { LiteralSchema, ScalarSchema } from '../../src/gen/flyteidl2/core/literals_pb'
import type { LiteralType } from '../../src/gen/flyteidl2/core/types_pb'
import {
  LiteralTypeSchema,
  SimpleType,
  UnionTypeSchema,
} from '../../src/gen/flyteidl2/core/types_pb'
import type { NamedLiteral, NamedParameter } from '../../src/gen/flyteidl2/task/common_pb'
import {
  NamedLiteralSchema,
  NamedParameterSchema,
} from '../../src/gen/flyteidl2/task/common_pb'
import { ParameterSchema } from '../../src/gen/flyteidl2/core/interface_pb'

/** A simple scalar literal type, e.g. `simpleType(SimpleType.INTEGER)`. */
export function simpleType(simple: SimpleType): LiteralType {
  return create(LiteralTypeSchema, { type: { case: 'simple', value: simple } })
}

/** An `Optional[T]` literal type: a union whose variants include NONE. */
export function optionalType(inner: LiteralType): LiteralType {
  return create(LiteralTypeSchema, {
    type: {
      case: 'unionType',
      value: create(UnionTypeSchema, {
        variants: [inner, simpleType(SimpleType.NONE)],
      }),
    },
  })
}

/** A variable map entry, in interface order. */
export function variable(key: string, type: LiteralType): VariableEntry {
  return create(VariableEntrySchema, {
    key,
    value: create(VariableSchema, { type }),
  })
}

export function variableMap(...entries: VariableEntry[]): VariableMap {
  return create(VariableMapSchema, { variables: entries })
}

export function typedInterface(inputs?: VariableMap, outputs?: VariableMap) {
  return create(TypedInterfaceSchema, { inputs, outputs })
}

/** An integer literal, used as a stand-in for registered default inputs. */
export function intLiteral(value: number | bigint): Literal {
  return create(LiteralSchema, {
    value: {
      case: 'scalar',
      value: create(ScalarSchema, {
        value: {
          case: 'primitive',
          value: { value: { case: 'integer', value: BigInt(value) } },
        },
      }),
    },
  })
}

/** A registered default input parameter for a task spec. */
export function defaultParameter(
  name: string,
  type: LiteralType,
  value: Literal,
): NamedParameter {
  return create(NamedParameterSchema, {
    name,
    parameter: create(ParameterSchema, {
      var: create(VariableSchema, { type }),
      behavior: { case: 'default', value },
    }),
  })
}

export function namedLiteral(name: string, value: Literal): NamedLiteral {
  return create(NamedLiteralSchema, { name, value })
}

/**
 * Reads the nth argument of a mock's nth call, typed as the caller expects.
 * The generated RPC signatures are wide enough that asserting on request
 * shape needs a cast; doing it here keeps the tests readable.
 */
export function callArg<T>(
  mockFn: { mock: { calls: unknown[][] } },
  call = 0,
  arg = 0,
): T {
  const calls = mockFn.mock.calls
  if (calls.length <= call) {
    throw new Error(`expected at least ${call + 1} call(s), saw ${calls.length}`)
  }
  return calls[call]![arg] as T
}

/** Records every request a fake service received, for assertions. */
export interface CallLog {
  jsonValuesToLiterals: { variables?: VariableMap; values?: JsonObject }[]
  literalsToLaunchFormJson: { literals: NamedLiteral[]; variables?: VariableMap }[]
}

export interface FakeContextOptions {
  /**
   * Converts the JSON payload to literals. The default echoes each provided
   * value back as an opaque literal so ordering and membership can be
   * asserted without reimplementing the platform's converter.
   */
  jsonValuesToLiterals?: (req: {
    variables?: VariableMap
    values?: JsonObject
  }) => Promise<{ literals: NamedLiteral[] }> | { literals: NamedLiteral[] }
  /** Produces the JSON-schema-shaped launch form returned for outputs. */
  literalsToLaunchFormJson?: (req: {
    literals: NamedLiteral[]
    variables?: VariableMap
  }) => Promise<{ json?: JsonObject }> | { json?: JsonObject }
  /** Partial overrides for any other service method used by a test. */
  services?: Partial<Services>
  config?: Partial<ResolvedConfig>
  /** Replaces the plain-HTTP fetch used for signed-URL transfers. */
  fetch?: typeof fetch
}

/**
 * Builds a {@link ClientContext} backed by fakes. Only the methods a test
 * exercises need to be provided; anything else throws Unimplemented so an
 * unexpected call fails loudly rather than silently returning undefined.
 */
export function fakeContext(options: FakeContextOptions = {}): {
  ctx: ClientContext
  calls: CallLog
} {
  const calls: CallLog = { jsonValuesToLiterals: [], literalsToLaunchFormJson: [] }

  const translator = {
    async jsonValuesToLiterals(req: { variables?: VariableMap; values?: JsonObject }) {
      calls.jsonValuesToLiterals.push(req)
      if (options.jsonValuesToLiterals) return options.jsonValuesToLiterals(req)
      // Echo each provided value back as an opaque literal, preserving the
      // caller's order.
      const literals = Object.keys(req.values ?? {}).map((name) =>
        namedLiteral(name, intLiteral(0)),
      )
      return { literals }
    },
    async literalsToLaunchFormJson(req: {
      literals: NamedLiteral[]
      variables?: VariableMap
    }) {
      calls.literalsToLaunchFormJson.push(req)
      if (options.literalsToLaunchFormJson) return options.literalsToLaunchFormJson(req)
      return { json: { properties: {} } }
    },
  }

  const unimplemented = (service: string, method: string) => () => {
    throw new ConnectError(`${service}.${method} is not faked in this test`, Code.Unimplemented)
  }

  const services = {
    translator,
    run: proxyService('RunService'),
    task: proxyService('TaskService'),
    dataproxy: proxyService('DataProxyService'),
    cluster: proxyService('ClusterService'),
    auth: proxyService('AuthMetadataService'),
    ...options.services,
  } as unknown as Services

  function proxyService(name: string): unknown {
    return new Proxy(
      {},
      {
        get: (_target, method) => unimplemented(name, String(method)),
      },
    )
  }

  const config: ResolvedConfig = {
    endpoint: 'https://acme.example.com',
    org: 'acme',
    project: 'my-project',
    domain: 'development',
    headers: {},
    auth: { mode: 'anonymous', authorizationHeader: 'authorization' },
    runSource: 'web',
    ...options.config,
  }

  const ctx: ClientContext = {
    config,
    services,
    dataproxyForCluster: () => services.dataproxy,
    fetch: options.fetch ?? globalThis.fetch,
  }

  return { ctx, calls }
}
