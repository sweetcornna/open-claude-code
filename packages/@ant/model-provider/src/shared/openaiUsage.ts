export type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/** First finite number among the candidates, or undefined if none qualify. */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Read the cached-prefix token count out of an OpenAI-compatible `usage`
 * object, in order of preference:
 *
 *   1. `prompt_tokens_details.cached_tokens` — the OpenAI spelling
 *   2. `prompt_cache_hit_tokens`             — DeepSeek's own schema
 *   3. `cached_tokens`                       — flattened by some proxies
 *
 * Reading only (1) made every DeepSeek turn — and every turn through a
 * gateway that mirrors DeepSeek's schema — report a 0% hit rate even when the
 * provider had served the prefix from cache.
 *
 * Returns undefined when the response says nothing about caching, so callers
 * can distinguish "no cache info" from an explicit zero.
 */
export function readOpenAICachedTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const detailsValue = record.prompt_tokens_details
  const details =
    detailsValue && typeof detailsValue === 'object'
      ? (detailsValue as Record<string, unknown>)
      : undefined
  return firstNumber(
    details?.cached_tokens,
    record.prompt_cache_hit_tokens,
    record.cached_tokens,
  )
}

/**
 * Read the cache-write token count, which only OpenAI's own newer models
 * report. Callers gate this on actually talking to OpenAI: on other endpoints
 * the field is absent and attributing zero writes is correct.
 */
export function readOpenAICacheWriteTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const detailsValue = record.prompt_tokens_details
  const details =
    detailsValue && typeof detailsValue === 'object'
      ? (detailsValue as Record<string, unknown>)
      : undefined
  return firstNumber(details?.cache_write_tokens)
}

/**
 * Convert OpenAI's total-input usage into Anthropic's disjoint usage fields.
 * Cache reads take priority when malformed provider data makes segments overlap.
 */
export function normalizeOpenAIUsage(params: {
  totalInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): AnthropicUsage {
  const totalInput = Math.max(0, params.totalInputTokens)
  const cacheRead = Math.min(
    Math.max(0, params.cacheReadTokens ?? 0),
    totalInput,
  )
  const remainingAfterRead = Math.max(0, totalInput - cacheRead)
  const cacheCreation = Math.min(
    Math.max(0, params.cacheWriteTokens ?? 0),
    remainingAfterRead,
  )

  return {
    input_tokens: Math.max(0, remainingAfterRead - cacheCreation),
    output_tokens: Math.max(0, params.outputTokens),
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  }
}
