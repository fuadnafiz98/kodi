/** Caps every guide is held to, whoever wrote it. */
export const MAX_SECTIONS = 8
export const MAX_REFS_PER_SECTION = 40
export const MAX_TITLE_CHARS = 48
export const MAX_GUIDE_TITLE_CHARS = 120
export const MAX_BODY_CHARS = 900
export const MAX_OVERVIEW_CHARS = 400
export const MAX_COMMIT_TITLE_CHARS = 72
/** Bumped with any change to the schema, the hunk-id grammar or the categories. */
export const GUIDE_SCHEMA_VERSION = 1

type JsonSchema = Record<string, unknown>

function guideSchema(refDescription: string): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'kind', 'title', 'sections'],
    properties: {
      version: { const: 1 },
      kind: { const: 'review-guide' },
      title: { type: 'string', maxLength: MAX_GUIDE_TITLE_CHARS },
      overview: { type: 'string', maxLength: MAX_OVERVIEW_CHARS },
      sections: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_SECTIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'kind', 'body', 'refs'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string', maxLength: MAX_TITLE_CHARS },
            kind: { enum: ['core', 'supporting'] },
            body: { type: 'string', maxLength: MAX_BODY_CHARS },
            refs: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_REFS_PER_SECTION,
              items: { type: 'string', description: refDescription }
            }
          }
        }
      },
      commit: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: MAX_COMMIT_TITLE_CHARS },
          body: { type: 'string' }
        }
      }
    }
  }
}

/** What `kodi --guide-format` prints and a `--guide-file` must satisfy. */
export const GUIDE_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...guideSchema('A repository-relative file path (the whole file) or a hunk id <path>:<scope>:h<n>')
}

/** What the model is asked for: refs are the digest's f/h aliases. */
export const GUIDE_GENERATION_SCHEMA: JsonSchema = guideSchema(
  'A digest alias: f<n> for a whole file, h<n> for one hunk'
)

const STRIPPED_KEYWORDS = new Set(['$schema', 'maxLength', 'minLength', 'minItems', 'maxItems'])

function nullable(schema: JsonSchema): JsonSchema {
  if ('const' in schema) return { anyOf: [{ const: schema.const }, { type: 'null' }] }
  const next: JsonSchema = { ...schema }
  if (Array.isArray(schema.enum)) {
    next.enum = [...schema.enum, null]
    return next
  }
  if (typeof schema.type === 'string') next.type = [schema.type, 'null']
  else if (Array.isArray(schema.type) && !schema.type.includes('null')) next.type = [...schema.type, 'null']
  return next
}

/**
 * The schema as OpenAI-style strict structured outputs accept it: every key
 * required, optional keys nullable, no closed-world gaps. Length and count
 * limits are left to normalisation, which enforces them anyway. Harmless for
 * Claude.
 */
export function strictResponseSchema(schema: JsonSchema): JsonSchema {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (typeof node !== 'object' || node == null) return node
    const source = node as JsonSchema
    const result: JsonSchema = {}
    for (const [key, value] of Object.entries(source)) {
      if (STRIPPED_KEYWORDS.has(key)) continue
      if (key === 'properties' || key === 'required') continue
      result[key] = visit(value)
    }
    if (typeof source.properties === 'object' && source.properties != null) {
      const required = new Set(Array.isArray(source.required) ? source.required as string[] : [])
      const properties: JsonSchema = {}
      for (const [key, value] of Object.entries(source.properties as JsonSchema)) {
        const strict = visit(value) as JsonSchema
        properties[key] = required.has(key) ? strict : nullable(strict)
      }
      result.properties = properties
      result.required = Object.keys(properties)
      result.additionalProperties = false
    }
    return result
  }
  return visit(schema) as JsonSchema
}
