import { describe, expect, test } from 'bun:test'
import {
  normalizeOpenAIUsage,
  readOpenAICacheWriteTokens,
  readOpenAICachedTokens,
} from '../openaiUsage.js'

describe('normalizeOpenAIUsage', () => {
  test('partitions total input into ordinary, cache-read, and cache-write tokens', () => {
    expect(
      normalizeOpenAIUsage({
        totalInputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 600,
        cacheWriteTokens: 250,
      }),
    ).toEqual({
      input_tokens: 150,
      output_tokens: 50,
      cache_creation_input_tokens: 250,
      cache_read_input_tokens: 600,
    })
  })

  test('clamps overlapping cache segments to the total input', () => {
    expect(
      normalizeOpenAIUsage({
        totalInputTokens: 5000,
        outputTokens: 10,
        cacheReadTokens: 4000,
        cacheWriteTokens: 4000,
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 10,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 4000,
    })
  })

  test('clamps negative provider values to zero', () => {
    expect(
      normalizeOpenAIUsage({
        totalInputTokens: -1,
        outputTokens: -2,
        cacheReadTokens: -3,
        cacheWriteTokens: -4,
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })
})

describe('readOpenAICachedTokens', () => {
  test('prefers the OpenAI spelling', () => {
    expect(
      readOpenAICachedTokens({
        prompt_tokens_details: { cached_tokens: 800 },
        prompt_cache_hit_tokens: 123,
      }),
    ).toBe(800)
  })

  test('falls back to DeepSeek prompt_cache_hit_tokens', () => {
    // Reading only the OpenAI spelling reported a 0% hit rate on DeepSeek
    // turns the provider had actually served from cache.
    expect(readOpenAICachedTokens({ prompt_cache_hit_tokens: 24_000 })).toBe(
      24_000,
    )
  })

  test('falls back to a flattened cached_tokens from proxies', () => {
    expect(readOpenAICachedTokens({ cached_tokens: 42 })).toBe(42)
  })

  test('distinguishes "no cache info" from an explicit zero', () => {
    // Callers carry the previous value forward on undefined; collapsing the
    // two would let a totals-only trailing chunk erase a real cache read.
    expect(readOpenAICachedTokens({ prompt_tokens: 10 })).toBeUndefined()
    expect(
      readOpenAICachedTokens({ prompt_tokens_details: { cached_tokens: 0 } }),
    ).toBe(0)
  })

  test('ignores non-numeric and non-object payloads', () => {
    expect(readOpenAICachedTokens(undefined)).toBeUndefined()
    expect(readOpenAICachedTokens('nope')).toBeUndefined()
    expect(
      readOpenAICachedTokens({ prompt_cache_hit_tokens: 'lots' }),
    ).toBeUndefined()
    expect(
      readOpenAICachedTokens({ prompt_cache_hit_tokens: Number.NaN }),
    ).toBeUndefined()
  })
})

describe('readOpenAICacheWriteTokens', () => {
  test('reads the OpenAI-only cache_write_tokens field', () => {
    expect(
      readOpenAICacheWriteTokens({
        prompt_tokens_details: { cache_write_tokens: 250 },
      }),
    ).toBe(250)
  })

  test('is undefined when the endpoint does not report writes', () => {
    expect(
      readOpenAICacheWriteTokens({
        prompt_tokens_details: { cached_tokens: 10 },
      }),
    ).toBeUndefined()
  })
})
