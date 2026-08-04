import {
  normalizeOpenAIUsage,
  type AnthropicUsage,
} from '../../shared/openaiUsage.js'
import type { GeminiUsageMetadata } from './types.js'

/**
 * Convert Gemini's `usageMetadata` into Anthropic's disjoint usage fields.
 *
 * The correction that matters: `promptTokenCount` is the TOTAL prompt size
 * with the cached prefix counted inside it
 * (`cachedContentTokenCount ⊆ promptTokenCount`), while Anthropic's
 * input/cache_creation/cache_read are disjoint and sum to that total. Adding
 * the cached slice on top of the total instead of subtracting it makes the
 * reported hit rate `cached/(total+cached)` — mathematically capped at 50%,
 * so a perfectly cached Gemini turn reads as a partial miss.
 *
 * Thinking tokens are billed as output and are absent from
 * `candidatesTokenCount`, so they are added in rather than dropped.
 *
 * Single source of truth for both the streaming adapter and the non-streaming
 * side-query path — they were previously two independent (and differently
 * wrong) implementations.
 */
export function normalizeGeminiUsage(
  usage: GeminiUsageMetadata | undefined,
): AnthropicUsage {
  return normalizeOpenAIUsage({
    totalInputTokens: usage?.promptTokenCount ?? 0,
    outputTokens:
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    // Gemini bills implicit-cache writes as ordinary input and reports no
    // separate write counter, so there is nothing to attribute here.
    cacheWriteTokens: 0,
  })
}
