/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Input/output conversion between plain JavaScript values and Flyte literals.
 *
 * Conversion is driven by the task's typed interface and delegated to the
 * control plane's TranslatorService (the same converter the console uses), so
 * every type the platform supports works here. Client-side we validate names,
 * apply registered defaults, and reject missing required inputs — matching
 * the Go SDK's convertInputs/convertOutputs.
 */

import { create } from '@bufbuild/protobuf'
import type { JsonObject, JsonValue } from '@bufbuild/protobuf'

import type { ClientContext } from './context'
import { FlyteError } from './errors'
import type { LiteralType } from './gen/flyteidl2/core/types_pb'
import { SimpleType } from './gen/flyteidl2/core/types_pb'
import type { Variable, VariableEntry } from './gen/flyteidl2/core/interface_pb'
import type { Literal } from './gen/flyteidl2/core/literals_pb'
import type { NamedLiteral, NamedParameter } from './gen/flyteidl2/task/common_pb'
import { NamedLiteralSchema } from './gen/flyteidl2/task/common_pb'
import type { VariableMap } from './gen/flyteidl2/core/interface_pb'
import { VariableMapSchema } from './gen/flyteidl2/core/interface_pb'
import {
  JsonValuesToLiteralsRequestSchema,
  LiteralsToLaunchFormJsonRequestSchema,
} from './gen/flyteidl2/workflow/translator_service_pb'

/** Plain-JavaScript inputs for a run, keyed by input name. */
export type RunInputs = Record<string, unknown>

/** True when a literal type is a union that admits None (i.e. optional). */
export function isOptionalType(t: LiteralType | undefined): boolean {
  if (t?.type.case !== 'unionType') return false
  return t.type.value.variants.some(
    (v) => v.type.case === 'simple' && v.type.value === SimpleType.NONE,
  )
}

/**
 * Converts a native value to the JSON representation expected by the
 * platform's JSON-to-literal converter: Date → RFC3339 string, bigint →
 * number/string, everything else through JSON semantics (so objects, arrays,
 * and toJSON implementations all work).
 */
export function toJsonValue(value: unknown, name: string): JsonValue {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value as JsonValue
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch (cause) {
    throw new FlyteError(`Input "${name}" is not JSON-serializable.`, { cause })
  }
}

interface TaskInputsShape {
  /** Input variables from the task's typed interface, in interface order. */
  variables: VariableEntry[]
  /** Registered default input literals keyed by input name. */
  defaults: Map<string, Literal>
  /** Task name, for error messages. */
  taskName: string
}

/** Extracts the inputs shape from a task's interface + default parameters. */
export function taskInputsShape(
  taskName: string,
  inputs: VariableMap | undefined,
  defaultInputs: NamedParameter[] | undefined,
): TaskInputsShape {
  const defaults = new Map<string, Literal>()
  for (const p of defaultInputs ?? []) {
    const behavior = p.parameter?.behavior
    if (p.name && behavior?.case === 'default') {
      defaults.set(p.name, behavior.value)
    }
  }
  return { variables: inputs?.variables ?? [], defaults, taskName }
}

/**
 * Turns plain-JavaScript inputs into wire-format literals ordered per the
 * task interface: unknown input names and missing required inputs are errors,
 * omitted inputs fall back to the task's registered defaults, and absent
 * optional inputs get an explicit NONE literal.
 */
export async function prepareInputs(
  ctx: ClientContext,
  shape: TaskInputsShape,
  inputs: RunInputs,
): Promise<NamedLiteral[]> {
  const { variables, defaults, taskName } = shape

  const known = new Set<string>()
  const payload: JsonObject = {}
  // The narrowed variable map passed to the converter: caller-supplied inputs
  // (so registered defaults don't need a lossy literal→JSON→literal round
  // trip) plus absent optional inputs without a default, for which the
  // converter emits an explicit NONE literal.
  const provided: VariableEntry[] = []
  for (const entry of variables) {
    const name = entry.key
    known.add(name)
    if (!(name in inputs)) {
      if (!defaults.has(name) && isOptionalType(entry.value?.type)) {
        provided.push(entry)
      }
      continue
    }
    payload[name] = toJsonValue(inputs[name], name)
    provided.push(entry)
  }

  for (const name of Object.keys(inputs)) {
    if (!known.has(name)) {
      const names = variables.map((v) => v.key).join(', ')
      throw new FlyteError(
        `Unknown input "${name}": task ${taskName} accepts [${names}].`,
      )
    }
  }

  let converted: NamedLiteral[] = []
  if (provided.length > 0) {
    const res = await ctx.services.translator.jsonValuesToLiterals(
      create(JsonValuesToLiteralsRequestSchema, {
        variables: create(VariableMapSchema, { variables: provided }),
        values: payload,
      }),
    )
    converted = res.literals
  }

  const byName = new Map(converted.map((l) => [l.name, l]))

  // Emit literals in interface order; apply defaults and reject missing
  // required inputs.
  const ordered: NamedLiteral[] = []
  for (const entry of variables) {
    const name = entry.key
    const literal = byName.get(name)
    if (literal) {
      ordered.push(literal)
      continue
    }
    const def = defaults.get(name)
    if (def) {
      // The converter emitted nothing — either the input was omitted, or a
      // null-like value was dropped. Either way the registered default
      // applies.
      ordered.push(create(NamedLiteralSchema, { name, value: def }))
      continue
    }
    if (isOptionalType(entry.value?.type)) {
      continue
    }
    // A required input with no default and no literal is missing, even when
    // the caller passed something for it: a null-like value the converter
    // dropped leaves the task with nothing to run on.
    throw new FlyteError(
      name in inputs
        ? `Input "${name}" of task ${taskName} is required and cannot be null.`
        : `Missing required input "${name}" for task ${taskName}.`,
    )
  }

  return ordered
}

/**
 * Converts wire-format output literals back into plain JavaScript values
 * keyed by output name (e.g. `o0`), using the server-side converter.
 */
export async function literalsToValues(
  ctx: ClientContext,
  literals: NamedLiteral[],
  outputs: VariableMap | undefined,
): Promise<Record<string, unknown>> {
  if (literals.length === 0) return {}
  const res = await ctx.services.translator.literalsToLaunchFormJson(
    create(LiteralsToLaunchFormJsonRequestSchema, { literals, variables: outputs }),
  )
  return launchFormValues(res.json)
}

/**
 * Extracts the values from the JSON-schema-shaped form produced by
 * LiteralsToLaunchFormJson: `{properties: {name: {default: v}}}`.
 */
export function launchFormValues(form: JsonObject | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const properties = form?.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return result
  }
  for (const [name, schema] of Object.entries(properties)) {
    if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
      result[name] = (schema as JsonObject).default
    }
  }
  return result
}

/** Names a variable for error messages: `x: int`. */
export function describeVariable(entry: VariableEntry): string {
  const v: Variable | undefined = entry.value
  const t = v?.type?.type.case ?? 'unknown'
  return `${entry.key}: ${t}`
}
