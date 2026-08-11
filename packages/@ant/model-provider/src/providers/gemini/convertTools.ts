import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { GeminiFunctionCallingConfig, GeminiTool } from './types.js'

const GEMINI_JSON_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
])

function normalizeGeminiJsonSchemaType(
  value: unknown,
): string | string[] | undefined {
  if (typeof value === 'string') {
    return GEMINI_JSON_SCHEMA_TYPES.has(value) ? value : undefined
  }

  if (Array.isArray(value)) {
    const normalized = value.filter(
      (item): item is string =>
        typeof item === 'string' && GEMINI_JSON_SCHEMA_TYPES.has(item),
    )
    const unique = Array.from(new Set(normalized))
    if (unique.length === 0) return undefined
    return unique.length === 1 ? unique[0] : unique
  }

  return undefined
}

function inferGeminiJsonSchemaTypeFromValue(
  value: unknown,
): string | undefined {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  if (typeof value === 'object') return 'object'
  return undefined
}

function inferGeminiJsonSchemaTypeFromEnum(
  values: unknown[],
): string | string[] | undefined {
  const inferred = values
    .map(inferGeminiJsonSchemaTypeFromValue)
    .filter((value): value is string => value !== undefined)
  const unique = Array.from(new Set(inferred))
  if (unique.length === 0) return undefined
  return unique.length === 1 ? unique[0] : unique
}

function addNullToGeminiJsonSchemaType(
  value: string | string[] | undefined,
): string | string[] | undefined {
  if (value === undefined) return ['null']
  if (Array.isArray(value)) {
    return value.includes('null') ? value : [...value, 'null']
  }
  return value === 'null' ? value : [value, 'null']
}

function sanitizeGeminiJsonSchemaProperties(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const sanitizedEntries = Object.entries(value as Record<string, unknown>)
    .map(([key, schema]) => [key, sanitizeGeminiJsonSchema(schema)] as const)
    .filter(([, schema]) => Object.keys(schema).length > 0)

  if (sanitizedEntries.length === 0) {
    return undefined
  }

  return Object.fromEntries(sanitizedEntries)
}

function sanitizeGeminiJsonSchemaArray(
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined

  const sanitized = value
    .map(item => sanitizeGeminiJsonSchema(item))
    .filter(item => Object.keys(item).length > 0)

  return sanitized.length > 0 ? sanitized : undefined
}

function isGeminiJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality, used to dedupe identical branch variants. */
function sameGeminiSchema(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((item, index) => sameGeminiSchema(item, b[index]))
  }
  if (!isGeminiJsonObject(a) || !isGeminiJsonObject(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => key in b && sameGeminiSchema(a[key], b[key]))
}

/** A branch counts as an object branch if it says so, or carries properties. */
function isGeminiObjectBranch(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isGeminiJsonObject(value) &&
    (value.type === 'object' || isGeminiJsonObject(value.properties))
  )
}

function geminiRequiredNames(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []
}

/** Only fields required by *every* branch may be required by the merged object. */
function intersectGeminiRequired(
  branches: Record<string, unknown>[],
): string[] {
  const [first, ...rest] = branches.map(geminiRequiredNames)
  if (!first) return []
  return first.filter(name => rest.every(names => names.includes(name)))
}

/**
 * Collapse a union of object branches into the one object Gemini accepts.
 *
 * A property several branches declare differently becomes an `anyOf` of the
 * distinct variants, so each variant keeps its own `enum`/description — that is
 * what lets the model tell one operation of a discriminated union from another.
 * A property subschema is also the only place a union still fits under Gemini's
 * rules, because there `anyOf` ends up being the only field set.
 */
function mergeGeminiObjectBranches(
  host: Record<string, unknown>,
  branches: unknown[],
): Record<string, unknown> {
  const objectBranches = branches.filter(isGeminiObjectBranch)
  const variantsByName = new Map<string, unknown[]>()

  for (const source of [host, ...objectBranches]) {
    if (!isGeminiJsonObject(source.properties)) continue
    for (const [name, schema] of Object.entries(source.properties)) {
      const variants = variantsByName.get(name) ?? []
      if (!variants.some(variant => sameGeminiSchema(variant, schema))) {
        variants.push(schema)
      }
      variantsByName.set(name, variants)
    }
  }

  const properties: Record<string, unknown> = {}
  for (const [name, variants] of variantsByName) {
    properties[name] = variants.length === 1 ? variants[0] : { anyOf: variants }
  }

  const required = new Set([
    ...geminiRequiredNames(host),
    ...intersectGeminiRequired(objectBranches),
  ])

  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(host)) {
    if (
      key === 'anyOf' ||
      key === 'properties' ||
      key === 'propertyOrdering' ||
      key === 'required'
    ) {
      continue
    }
    merged[key] = value
  }
  merged.type = 'object'
  if (Object.keys(properties).length > 0) {
    merged.properties = properties
    merged.propertyOrdering = Object.keys(properties)
  }
  if (required.size > 0) {
    merged.required = [...required]
  }
  return merged
}

/**
 * Gemini rejects a function declaration that sets anything alongside `anyOf`:
 *
 *   Unable to submit request because `edit` functionDeclaration
 *   `parameters.edits` schema specified other fields alongside any_of.
 *   When using any_of, it must be the only field set.
 *
 * zod emits exactly that from a described union — `z.union([...]).describe()`,
 * which is what the Workflow tool's `resumePolicy` is — and MCP servers publish
 * it freely, so this keys off shape and never off a tool name.
 *
 * A union whose branches are all objects folds into one object: the host keeps
 * its prose, the branches contribute their properties. An object host whose
 * branches will not fold keeps the object, since that is the half Gemini needs.
 * Anything else keeps the union and carries the host's prose down into each
 * branch, the union being the only field allowed to survive.
 *
 * A bare `anyOf` with no siblings is already what Gemini wants and is returned
 * untouched, so nothing moves on the wire for schemas that work today.
 */
function foldGeminiAnyOfSiblings(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const branches = schema.anyOf
  if (!Array.isArray(branches) || branches.length === 0) return schema
  if (Object.keys(schema).length === 1) return schema

  if (
    branches.every(isGeminiObjectBranch) ||
    schema.type === 'object' ||
    isGeminiJsonObject(schema.properties)
  ) {
    return mergeGeminiObjectBranches(schema, branches)
  }

  return {
    anyOf: branches.map(branch => {
      if (!isGeminiJsonObject(branch)) return branch
      const prose: Record<string, unknown> = {}
      if (branch.title === undefined && typeof schema.title === 'string') {
        prose.title = schema.title
      }
      if (
        branch.description === undefined &&
        typeof schema.description === 'string'
      ) {
        prose.description = schema.description
      }
      return Object.keys(prose).length > 0 ? { ...branch, ...prose } : branch
    }),
  }
}

function sanitizeGeminiJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {}
  }

  const source = schema as Record<string, unknown>
  const result: Record<string, unknown> = {}

  let type = normalizeGeminiJsonSchemaType(source.type)

  if (source.const !== undefined) {
    result.enum = [source.const]
    type = type ?? inferGeminiJsonSchemaTypeFromValue(source.const)
  } else if (Array.isArray(source.enum) && source.enum.length > 0) {
    result.enum = source.enum
    type = type ?? inferGeminiJsonSchemaTypeFromEnum(source.enum)
  }

  if (!type) {
    if (source.properties && typeof source.properties === 'object') {
      type = 'object'
    } else if (source.items !== undefined || source.prefixItems !== undefined) {
      type = 'array'
    }
  }

  if (source.nullable === true) {
    type = addNullToGeminiJsonSchemaType(type)
  }

  if (type) {
    result.type = type
  }

  if (typeof source.title === 'string') {
    result.title = source.title
  }
  if (typeof source.description === 'string') {
    result.description = source.description
  }
  if (typeof source.format === 'string') {
    result.format = source.format
  }
  if (typeof source.pattern === 'string') {
    result.pattern = source.pattern
  }
  if (typeof source.minimum === 'number') {
    result.minimum = source.minimum
  } else if (typeof source.exclusiveMinimum === 'number') {
    result.minimum = source.exclusiveMinimum
  }
  if (typeof source.maximum === 'number') {
    result.maximum = source.maximum
  } else if (typeof source.exclusiveMaximum === 'number') {
    result.maximum = source.exclusiveMaximum
  }
  if (typeof source.minItems === 'number') {
    result.minItems = source.minItems
  }
  if (typeof source.maxItems === 'number') {
    result.maxItems = source.maxItems
  }
  if (typeof source.minLength === 'number') {
    result.minLength = source.minLength
  }
  if (typeof source.maxLength === 'number') {
    result.maxLength = source.maxLength
  }
  if (typeof source.minProperties === 'number') {
    result.minProperties = source.minProperties
  }
  if (typeof source.maxProperties === 'number') {
    result.maxProperties = source.maxProperties
  }

  const properties = sanitizeGeminiJsonSchemaProperties(source.properties)
  if (properties) {
    result.properties = properties
    result.propertyOrdering = Object.keys(properties)
  }

  if (Array.isArray(source.required)) {
    const required = source.required.filter(
      (item): item is string => typeof item === 'string',
    )
    if (required.length > 0) {
      result.required = required
    }
  }

  if (typeof source.additionalProperties === 'boolean') {
    result.additionalProperties = source.additionalProperties
  } else {
    const additionalProperties = sanitizeGeminiJsonSchema(
      source.additionalProperties,
    )
    if (Object.keys(additionalProperties).length > 0) {
      result.additionalProperties = additionalProperties
    }
  }

  const items = sanitizeGeminiJsonSchema(source.items)
  if (Object.keys(items).length > 0) {
    result.items = items
  }

  const prefixItems = sanitizeGeminiJsonSchemaArray(source.prefixItems)
  if (prefixItems) {
    result.prefixItems = prefixItems
  }

  const anyOf = sanitizeGeminiJsonSchemaArray(source.anyOf ?? source.oneOf)
  if (anyOf) {
    result.anyOf = anyOf
  }

  return foldGeminiAnyOfSiblings(result)
}

/**
 * Force a tool's parameters to the object Gemini's contract demands.
 *
 * `FunctionDeclaration.parametersJsonSchema` — the field this converter emits —
 * is specified as: "Describes the parameters to the function in JSON Schema
 * format. The schema must describe an object where the properties are the
 * parameters to the function." (generativelanguage v1beta discovery document.)
 *
 * A tool whose zod schema is a top-level `z.union([...])` — Workflow — converts
 * to `{ $schema, anyOf: [...] }` with no top-level `type`. Anthropic's
 * `input_schema` accepts that shape, so the schema is perfectly legal upstream
 * and the gap only shows here. MCP tools arrive the same way: their schema is
 * authored by the server, never by us. So the fix belongs at the wire boundary
 * and keys off schema *shape*, never a tool name.
 *
 * This is the OpenAI lane's rule (`shared/openaiConvertTools.ts`,
 * `normalizeToObjectSchema`) restated inside Gemini's smaller schema subset,
 * with one forced divergence: OpenAI keeps the original union *inside* the
 * merged object, and Gemini cannot, because `anyOf` may not have siblings (see
 * `foldGeminiAnyOfSiblings`). The cost is the cross-field half of the contract
 * — "the status branch requires runId" is no longer expressible here. Each
 * property still carries every branch variant it had, and the tool's own zod
 * schema still parses the model's arguments before execution
 * (`toolExecution.ts`), so the wire schema was only ever a hint.
 */
function normalizeGeminiParametersToObject(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === 'object') return schema

  const branches = schema.anyOf
  if (
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every(isGeminiObjectBranch)
  ) {
    return mergeGeminiObjectBranches(schema, branches)
  }

  // A hand-written MCP schema that lists `properties` but omits `type` is the
  // realistic case; `type` is all it is missing.
  if (isGeminiJsonObject(schema.properties)) {
    return { ...schema, type: 'object' }
  }

  // Neither an object nor a union of objects. Declaring the tool parameterless
  // keeps the session alive — a rejected declaration takes down every request,
  // not just this tool — and lets the tool's own zod parse reject the call.
  const fallback: Record<string, unknown> = { type: 'object', properties: {} }
  if (typeof schema.title === 'string') fallback.title = schema.title
  if (typeof schema.description === 'string') {
    fallback.description = schema.description
  }
  return fallback
}

function sanitizeGeminiFunctionParameters(
  schema: unknown,
): Record<string, unknown> {
  const sanitized = sanitizeGeminiJsonSchema(schema)
  if (Object.keys(sanitized).length > 0) {
    return normalizeGeminiParametersToObject(sanitized)
  }

  return {
    type: 'object',
    properties: {},
  }
}

export function anthropicToolsToGemini(tools: BetaToolUnion[]): GeminiTool[] {
  const functionDeclarations = tools
    .filter(tool => {
      const toolType = (tool as unknown as { type?: string }).type
      return (
        tool.type === 'custom' || !('type' in tool) || toolType !== 'server'
      )
    })
    .map(tool => {
      const anyTool = tool as unknown as Record<string, unknown>
      const name = (anyTool.name as string) || ''
      const description = (anyTool.description as string) || ''
      const inputSchema = (anyTool.input_schema as
        | Record<string, unknown>
        | undefined) ?? {
        type: 'object',
        properties: {},
      }

      return {
        name,
        description,
        parametersJsonSchema: sanitizeGeminiFunctionParameters(inputSchema),
      }
    })

  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : []
}

export function anthropicToolChoiceToGemini(
  toolChoice: unknown,
): GeminiFunctionCallingConfig | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined

  const tc = toolChoice as Record<string, unknown>
  const type = tc.type as string

  switch (type) {
    case 'auto':
      return { mode: 'AUTO' }
    case 'any':
      return { mode: 'ANY' }
    case 'tool':
      return {
        mode: 'ANY',
        allowedFunctionNames:
          typeof tc.name === 'string' ? [tc.name] : undefined,
      }
    default:
      return undefined
  }
}
