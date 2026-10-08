import { describe, expect, test } from 'bun:test'

import { GUIDE_GENERATION_SCHEMA, GUIDE_SCHEMA, strictResponseSchema } from './schema.js'

function everyObject(schema: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(schema)) {
    for (const entry of schema) everyObject(entry, visit)
    return
  }
  if (typeof schema !== 'object' || schema == null) return
  const node = schema as Record<string, unknown>
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) visit(node)
  for (const value of Object.values(node)) everyObject(value, visit)
}

describe('guide schemas', () => {
  test('every object closes its properties', () => {
    for (const schema of [GUIDE_SCHEMA, GUIDE_GENERATION_SCHEMA]) {
      let objects = 0
      everyObject(schema, (node) => {
        objects += 1
        expect(node.additionalProperties).toBe(false)
      })
      expect(objects).toBe(3)
    }
    expect(JSON.parse(JSON.stringify(GUIDE_SCHEMA))).toEqual(GUIDE_SCHEMA)
  })

  test('the public schema names paths and hunk ids, the generation schema aliases', () => {
    const refs = (schema: Record<string, unknown>): string =>
      JSON.stringify((schema.properties as Record<string, unknown>).sections)
    expect(refs(GUIDE_SCHEMA)).toContain('<path>:<scope>:h<n>')
    expect(refs(GUIDE_GENERATION_SCHEMA)).toContain('f<n>')
  })
})

describe('strictResponseSchema', () => {
  const strict = strictResponseSchema(GUIDE_GENERATION_SCHEMA)
  const properties = strict.properties as Record<string, Record<string, unknown>>

  test('every property is required', () => {
    expect(strict.required).toEqual(['version', 'kind', 'title', 'overview', 'sections', 'commit'])
    const commit = properties.commit!
    expect(commit.required).toEqual(['title', 'body'])
  })

  test('optional properties become nullable, required ones stay as they were', () => {
    expect(properties.overview!.type).toEqual(['string', 'null'])
    expect(properties.commit!.type).toEqual(['object', 'null'])
    expect(properties.title!.type).toBe('string')
    expect(properties.version).toEqual({ const: 1 })
    const commitProperties = properties.commit!.properties as Record<string, Record<string, unknown>>
    expect(commitProperties.title!.type).toEqual(['string', 'null'])
  })

  test('an optional const becomes anyOf with null and an optional enum gains null', () => {
    const converted = strictResponseSchema({
      type: 'object',
      required: [],
      properties: { flag: { const: 'x' }, mode: { enum: ['a', 'b'] } }
    })
    const convertedProperties = converted.properties as Record<string, unknown>
    expect(convertedProperties.flag).toEqual({ anyOf: [{ const: 'x' }, { type: 'null' }] })
    expect(convertedProperties.mode).toEqual({ enum: ['a', 'b', null] })
    expect(converted.additionalProperties).toBe(false)
  })

  test('length and count limits are left to normalisation', () => {
    const text = JSON.stringify(strict)
    expect(text).not.toContain('maxLength')
    expect(text).not.toContain('maxItems')
    expect(text).not.toContain('$schema')
  })
})
