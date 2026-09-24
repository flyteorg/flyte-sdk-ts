/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

import { describe, expect, it } from 'vitest'

import { SimpleType } from '../src/gen/flyteidl2/core/types_pb'
import {
  isOptionalType,
  launchFormValues,
  literalsToValues,
  prepareInputs,
  taskInputsShape,
  toJsonValue,
} from '../src/io'
import {
  defaultParameter,
  fakeContext,
  intLiteral,
  namedLiteral,
  optionalType,
  simpleType,
  variable,
  variableMap,
} from './helpers/fakeContext'

const INT = simpleType(SimpleType.INTEGER)
const STR = simpleType(SimpleType.STRING)

describe('isOptionalType', () => {
  it('recognizes a union admitting NONE', () => {
    expect(isOptionalType(optionalType(INT))).toBe(true)
  })

  it('rejects plain scalars and unions without NONE', () => {
    expect(isOptionalType(INT)).toBe(false)
    expect(isOptionalType(undefined)).toBe(false)
  })
})

describe('toJsonValue', () => {
  it('passes primitives through', () => {
    expect(toJsonValue(1, 'x')).toBe(1)
    expect(toJsonValue('hi', 'x')).toBe('hi')
    expect(toJsonValue(true, 'x')).toBe(true)
  })

  it('maps null and undefined to null', () => {
    expect(toJsonValue(null, 'x')).toBeNull()
    expect(toJsonValue(undefined, 'x')).toBeNull()
  })

  it('formats Date as an RFC3339 string', () => {
    expect(toJsonValue(new Date('2026-01-02T03:04:05.000Z'), 'x')).toBe(
      '2026-01-02T03:04:05.000Z',
    )
  })

  it('converts safe bigints to numbers and large ones to strings', () => {
    expect(toJsonValue(42n, 'x')).toBe(42)
    // Beyond Number.MAX_SAFE_INTEGER, a number would lose precision.
    expect(toJsonValue(9007199254740993n, 'x')).toBe('9007199254740993')
  })

  it('round-trips plain objects and arrays through JSON', () => {
    expect(toJsonValue({ a: [1, 2], b: { c: 'd' } }, 'x')).toEqual({
      a: [1, 2],
      b: { c: 'd' },
    })
  })

  it('honors toJSON implementations', () => {
    const value = { toJSON: () => ({ kind: 'custom' }) }
    expect(toJsonValue(value, 'x')).toEqual({ kind: 'custom' })
  })

  it('reports non-serializable values with the input name', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => toJsonValue(circular, 'payload')).toThrow(/Input "payload"/)
  })
})

describe('taskInputsShape', () => {
  it('collects interface variables and default literals', () => {
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('x', INT), variable('name', STR)),
      [defaultParameter('name', STR, intLiteral(0))],
    )
    expect(shape.variables.map((v) => v.key)).toEqual(['x', 'name'])
    expect([...shape.defaults.keys()]).toEqual(['name'])
  })

  it('ignores parameters whose behavior is "required" rather than a default', () => {
    const shape = taskInputsShape('my_task', variableMap(variable('x', INT)), [])
    expect(shape.defaults.size).toBe(0)
  })

  it('tolerates a task with no interface', () => {
    const shape = taskInputsShape('my_task', undefined, undefined)
    expect(shape.variables).toEqual([])
    expect(shape.defaults.size).toBe(0)
  })
})

describe('prepareInputs', () => {
  it('emits literals in interface order, not caller order', async () => {
    const { ctx } = fakeContext()
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('a', INT), variable('b', INT), variable('c', INT)),
      [],
    )
    const literals = await prepareInputs(ctx, shape, { c: 3, a: 1, b: 2 })
    expect(literals.map((l) => l.name)).toEqual(['a', 'b', 'c'])
  })

  it('rejects an unknown input name and lists what the task accepts', async () => {
    const { ctx } = fakeContext()
    const shape = taskInputsShape('my_task', variableMap(variable('x', INT)), [])
    await expect(prepareInputs(ctx, shape, { x: 1, typo: 2 })).rejects.toThrow(
      /Unknown input "typo": task my_task accepts \[x\]/,
    )
  })

  it('rejects a missing required input', async () => {
    const { ctx } = fakeContext()
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('x', INT), variable('y', INT)),
      [],
    )
    await expect(prepareInputs(ctx, shape, { x: 1 })).rejects.toThrow(
      /Missing required input "y" for task my_task/,
    )
  })

  it('applies a registered default for an omitted input', async () => {
    const { ctx, calls } = fakeContext()
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('x', INT), variable('retries', INT)),
      [defaultParameter('retries', INT, intLiteral(3))],
    )
    const literals = await prepareInputs(ctx, shape, { x: 1 })
    expect(literals.map((l) => l.name)).toEqual(['x', 'retries'])
    // The default literal is used verbatim — no lossy literal→JSON→literal
    // round trip through the converter.
    expect(Object.keys(calls.jsonValuesToLiterals[0]?.values ?? {})).toEqual(['x'])
    expect(literals[1]?.value).toEqual(intLiteral(3))
  })

  it('lets a caller-supplied value override a registered default', async () => {
    const { ctx, calls } = fakeContext()
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('retries', INT)),
      [defaultParameter('retries', INT, intLiteral(3))],
    )
    await prepareInputs(ctx, shape, { retries: 9 })
    expect(calls.jsonValuesToLiterals[0]?.values).toEqual({ retries: 9 })
  })

  it('sends absent optional inputs to the converter so it emits NONE', async () => {
    const { ctx, calls } = fakeContext()
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('x', INT), variable('maybe', optionalType(STR))),
      [],
    )
    await prepareInputs(ctx, shape, { x: 1 })
    // Both variables are declared to the converter, but only `x` has a value.
    expect(calls.jsonValuesToLiterals[0]?.variables?.variables.map((v) => v.key)).toEqual([
      'x',
      'maybe',
    ])
    expect(Object.keys(calls.jsonValuesToLiterals[0]?.values ?? {})).toEqual(['x'])
  })

  it('omits an absent optional input that the converter dropped', async () => {
    // A converter that emits nothing for the value-less optional variable.
    const { ctx } = fakeContext({
      jsonValuesToLiterals: () => ({ literals: [namedLiteral('x', intLiteral(1))] }),
    })
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('x', INT), variable('maybe', optionalType(STR))),
      [],
    )
    const literals = await prepareInputs(ctx, shape, { x: 1 })
    expect(literals.map((l) => l.name)).toEqual(['x'])
  })

  it('prefers a registered default over a NONE literal for an optional input', async () => {
    const { ctx, calls } = fakeContext()
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('maybe', optionalType(INT))),
      [defaultParameter('maybe', optionalType(INT), intLiteral(7))],
    )
    const literals = await prepareInputs(ctx, shape, {})
    // With a default registered, the converter is not consulted at all.
    expect(calls.jsonValuesToLiterals).toHaveLength(0)
    expect(literals.map((l) => l.name)).toEqual(['maybe'])
    expect(literals[0]?.value).toEqual(intLiteral(7))
  })

  it('keeps the server default when the converter drops a null-like value', async () => {
    const { ctx } = fakeContext({ jsonValuesToLiterals: () => ({ literals: [] }) })
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('maybe', optionalType(INT))),
      [],
    )
    const literals = await prepareInputs(ctx, shape, { maybe: null })
    expect(literals).toEqual([])
  })

  it('rejects a required input the caller explicitly nulled', async () => {
    // The converter drops null-like values; without this check the run would
    // be created with no literal for a required input at all.
    const { ctx } = fakeContext({ jsonValuesToLiterals: () => ({ literals: [] }) })
    const shape = taskInputsShape('my_task', variableMap(variable('x', INT)), [])
    await expect(prepareInputs(ctx, shape, { x: null })).rejects.toThrow(
      /Input "x" of task my_task is required and cannot be null/,
    )
  })

  it('applies a registered default when a nulled input has one', async () => {
    const { ctx } = fakeContext({ jsonValuesToLiterals: () => ({ literals: [] }) })
    const shape = taskInputsShape(
      'my_task',
      variableMap(variable('retries', INT)),
      [defaultParameter('retries', INT, intLiteral(3))],
    )
    const literals = await prepareInputs(ctx, shape, { retries: null })
    expect(literals.map((l) => l.name)).toEqual(['retries'])
    expect(literals[0]?.value).toEqual(intLiteral(3))
  })

  it('skips the converter entirely for a task with no inputs', async () => {
    const { ctx, calls } = fakeContext()
    const shape = taskInputsShape('noop', variableMap(), [])
    expect(await prepareInputs(ctx, shape, {})).toEqual([])
    expect(calls.jsonValuesToLiterals).toHaveLength(0)
  })
})

describe('launchFormValues', () => {
  it('extracts each property default', () => {
    expect(
      launchFormValues({
        properties: { o0: { default: 42 }, o1: { default: 'hi' } },
      }),
    ).toEqual({ o0: 42, o1: 'hi' })
  })

  it('tolerates a missing or malformed form', () => {
    expect(launchFormValues(undefined)).toEqual({})
    expect(launchFormValues({})).toEqual({})
    expect(launchFormValues({ properties: 'nope' })).toEqual({})
    expect(launchFormValues({ properties: { o0: 'nope' } })).toEqual({})
  })
})

describe('literalsToValues', () => {
  it('returns an empty object without calling the converter for no literals', async () => {
    const { ctx, calls } = fakeContext()
    expect(await literalsToValues(ctx, [], undefined)).toEqual({})
    expect(calls.literalsToLaunchFormJson).toHaveLength(0)
  })

  it('converts literals to native values via the launch form', async () => {
    const { ctx, calls } = fakeContext({
      literalsToLaunchFormJson: () => ({
        json: { properties: { o0: { default: 8 } } },
      }),
    })
    const outputs = variableMap(variable('o0', INT))
    expect(await literalsToValues(ctx, [namedLiteral('o0', intLiteral(8))], outputs)).toEqual({
      o0: 8,
    })
    expect(calls.literalsToLaunchFormJson[0]?.variables).toBe(outputs)
  })
})
