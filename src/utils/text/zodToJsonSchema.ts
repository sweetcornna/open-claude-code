/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same ZodTypeAny reference per session, so we can cache by identity.
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * Converts a Zod v4 schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  // unrepresentable: 'any'：zod v4 默认对 z.undefined()/z.bigint() 等直接 throw，
  // 这里在每个 API 请求的工具序列化热路径上，宁可降级为空 schema 也不能崩。
  const result = toJSONSchema(schema, {
    unrepresentable: 'any',
  }) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
