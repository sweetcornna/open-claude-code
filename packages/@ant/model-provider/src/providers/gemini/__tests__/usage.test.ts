import { describe, expect, test } from 'bun:test'
import { normalizeGeminiUsage } from '../usage.js'

describe('normalizeGeminiUsage', () => {
  test('subtracts the cached prefix out of promptTokenCount', () => {
    // Gemini counts cachedContentTokenCount inside promptTokenCount, while
    // Anthropic's fields are disjoint. Adding instead of subtracting makes the
    // hit rate cached/(total+cached) — capped at 50%.
    expect(
      normalizeGeminiUsage({
        promptTokenCount: 30_000,
        cachedContentTokenCount: 20_000,
        candidatesTokenCount: 5,
      }),
    ).toEqual({
      input_tokens: 10_000,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
    })
  })

  test('a fully cached prompt reports a 100% hit rate', () => {
    const usage = normalizeGeminiUsage({
      promptTokenCount: 20_000,
      cachedContentTokenCount: 20_000,
      candidatesTokenCount: 10,
    })
    const denominator =
      usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens
    expect(usage.cache_read_input_tokens / denominator).toBe(1)
  })

  test('folds thinking tokens into the output count', () => {
    // thoughtsTokenCount is billed as output and is not part of
    // candidatesTokenCount, so dropping it under-reports the turn.
    expect(
      normalizeGeminiUsage({
        promptTokenCount: 100,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 7,
      }).output_tokens,
    ).toBe(12)
  })

  test('never attributes cache-creation tokens', () => {
    // Gemini bills implicit-cache writes as ordinary input and reports no
    // separate write counter.
    expect(
      normalizeGeminiUsage({ promptTokenCount: 100 })
        .cache_creation_input_tokens,
    ).toBe(0)
  })

  test('clamps a cached count that exceeds the reported total', () => {
    expect(
      normalizeGeminiUsage({
        promptTokenCount: 100,
        cachedContentTokenCount: 500,
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
    })
  })

  test('missing usageMetadata degrades to all zeros', () => {
    expect(normalizeGeminiUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })
})
