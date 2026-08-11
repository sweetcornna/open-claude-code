import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionTool } from 'openai/resources/chat/completions/completions.mjs'

/**
 * Convert Anthropic tool schemas to OpenAI function calling format.
 *
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type: "function", function: { name, description, parameters } }
 *
 * Anthropic-specific fields (cache_control, defer_loading, etc.) are stripped.
 */
export function anthropicToolsToOpenAI(
  tools: BetaToolUnion[],
): ChatCompletionTool[] {
  return tools
    .filter(tool => {
      // Only convert standard tools (skip server tools like computer_use, etc.)
      const toolType = (tool as unknown as { type?: string }).type
      return (
        tool.type === 'custom' || !('type' in tool) || toolType !== 'server'
      )
    })
    .map(tool => {
      // Handle the various tool shapes from Anthropic SDK
      const anyTool = tool as unknown as Record<string, unknown>
      const name = (anyTool.name as string) || ''
      const description = (anyTool.description as string) || ''
      const inputSchema = anyTool.input_schema as
        | Record<string, unknown>
        | undefined

      return {
        type: 'function' as const,
        function: {
          name,
          description,
          // Normalize before sanitizing: normalization can lift branch schemas
          // up into `properties`, and those still need the `const` rewrite.
          parameters: sanitizeJsonSchema(
            normalizeToObjectSchema(
              inputSchema || { type: 'object', properties: {} },
            ),
          ),
        },
      } satisfies ChatCompletionTool
    })
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality, used to dedupe identical branch variants. */
function sameSchema(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((item, index) => sameSchema(item, b[index]))
  }
  if (!isJsonObject(a) || !isJsonObject(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => key in b && sameSchema(a[key], b[key]))
}

/** A branch counts as an object branch if it says so, or carries properties. */
function isObjectBranch(value: unknown): value is Record<string, unknown> {
  return (
    isJsonObject(value) &&
    (value.type === 'object' || isJsonObject(value.properties))
  )
}

/**
 * Union of every branch's properties. A property that appears in several
 * branches with differing schemas becomes an `anyOf` of the distinct variants,
 * so each variant keeps its own `const`/`enum`/description — that is what lets
 * the model tell one operation of a discriminated union from another.
 */
function mergeBranchProperties(
  branches: Record<string, unknown>[],
): Record<string, unknown> {
  const variantsByName = new Map<string, unknown[]>()
  for (const branch of branches) {
    if (!isJsonObject(branch.properties)) continue
    for (const [name, schema] of Object.entries(branch.properties)) {
      const variants = variantsByName.get(name) ?? []
      if (!variants.some(variant => sameSchema(variant, schema))) {
        variants.push(schema)
      }
      variantsByName.set(name, variants)
    }
  }

  const merged: Record<string, unknown> = {}
  for (const [name, variants] of variantsByName) {
    merged[name] = variants.length === 1 ? variants[0] : { anyOf: variants }
  }
  return merged
}

/** Only fields required by *every* branch may be required by the merged object. */
function intersectRequired(branches: Record<string, unknown>[]): string[] {
  const perBranch = branches.map(branch =>
    Array.isArray(branch.required)
      ? branch.required.filter(
          (name): name is string => typeof name === 'string',
        )
      : [],
  )
  const [first, ...rest] = perBranch
  if (!first) return []
  return first.filter(name => rest.every(names => names.includes(name)))
}

/**
 * Force a tool's parameters schema to the top-level `type: "object"` that
 * OpenAI-style function calling requires.
 *
 * Without this, an OpenAI-compatible endpoint rejects the *whole request* —
 * every turn of the session, not just the offending tool call. Measured against
 * OpenCode Go (`opencode.ai/zen/go/v1`, model kimi-k3):
 *
 *   API Error [OpenAI]: Error from provider (Console Go): Upstream request
 *   failed: [invalid_request_error] Invalid schema for function 'Workflow':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
 *
 * Anthropic's `input_schema` accepts a bare union, so this never surfaces on the
 * first-party lane and the offending schema is perfectly legal upstream: a tool
 * whose zod schema is a top-level `z.union([...])` converts to `{ $schema,
 * anyOf: [...] }` with no top-level `type`. MCP tools reach here the same way —
 * their `inputJSONSchema` is authored by the server, not by us — so the fix
 * belongs at the wire boundary and keys off schema *shape*, never a tool name.
 *
 * The rule, in order:
 *  1. Already `type: "object"` — returned untouched. Nothing on the wire moves
 *     for the tools that were fine, which keeps the prompt cache intact.
 *  2. `anyOf`/`oneOf` of object branches — flattened into one object: branch
 *     properties merged, `required` narrowed to the fields every branch
 *     requires. The original union is left in place, so the exact per-branch
 *     contract still reaches the model and a validator still enforces it.
 *  3. Anything else — the `type` keyword is added. Hand-written MCP schemas
 *     that list `properties` but omit `type` are the realistic case; for a
 *     genuinely non-object schema this is a last resort that keeps the session
 *     alive and lets the tool's own zod parse reject the call instead.
 */
function normalizeToObjectSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === 'object') return schema

  // Flattening replaces `properties` wholesale, so it is only safe when the
  // schema has none of its own to lose. One that carries both is already
  // object-shaped — adding the keyword below is enough.
  if (!isJsonObject(schema.properties)) {
    for (const key of ['anyOf', 'oneOf'] as const) {
      const branches = schema[key]
      if (!Array.isArray(branches) || branches.length === 0) continue
      if (!branches.every(isObjectBranch)) continue

      const required = intersectRequired(branches)
      return {
        ...schema,
        type: 'object',
        properties: mergeBranchProperties(branches),
        ...(required.length > 0 ? { required } : {}),
      }
    }
  }

  return {
    ...schema,
    type: 'object',
    ...(isJsonObject(schema.properties) ? {} : { properties: {} }),
  }
}

/**
 * Recursively sanitize a JSON Schema for OpenAI-compatible providers.
 *
 * Many OpenAI-compatible endpoints (Ollama, DeepSeek, vLLM, etc.) do not
 * support the `const` keyword in JSON Schema. Convert it to `enum` with a
 * single-element array, which is semantically equivalent.
 */
function sanitizeJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema

  const result = { ...schema }

  // Convert `const` → `enum: [value]`
  if ('const' in result) {
    result.enum = [result.const]
    delete result.const
  }

  // Recursively process nested schemas
  const objectKeys = [
    'properties',
    'definitions',
    '$defs',
    'patternProperties',
  ] as const
  for (const key of objectKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object') {
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        sanitized[k] =
          v && typeof v === 'object'
            ? sanitizeJsonSchema(v as Record<string, unknown>)
            : v
      }
      result[key] = sanitized
    }
  }

  // Recursively process single-schema keys
  const singleKeys = [
    'items',
    'additionalProperties',
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
  ] as const
  for (const key of singleKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result[key] = sanitizeJsonSchema(nested as Record<string, unknown>)
    }
  }

  // Recursively process array-of-schemas keys
  const arrayKeys = ['anyOf', 'oneOf', 'allOf'] as const
  for (const key of arrayKeys) {
    const nested = result[key]
    if (Array.isArray(nested)) {
      result[key] = nested.map(item =>
        item && typeof item === 'object'
          ? sanitizeJsonSchema(item as Record<string, unknown>)
          : item,
      )
    }
  }

  return result
}

/**
 * Map Anthropic tool_choice to OpenAI tool_choice format.
 *
 * Anthropic → OpenAI:
 * - { type: "auto" } → "auto"
 * - { type: "any" }  → "required"
 * - { type: "tool", name } → { type: "function", function: { name } }
 * - undefined → undefined (use provider default)
 */
export function anthropicToolChoiceToOpenAI(
  toolChoice: unknown,
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined

  const tc = toolChoice as Record<string, unknown>
  const type = tc.type as string

  switch (type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return {
        type: 'function',
        function: { name: tc.name as string },
      }
    default:
      return undefined
  }
}
