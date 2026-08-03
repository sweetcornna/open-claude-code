import { expect, test } from 'bun:test'
import {
  CHINA_LLM_PROVIDERS,
  parseContextWindowTokens,
} from '../chinaLlmProviders.js'

test('parseContextWindowTokens: K/M shorthands and plain forms', () => {
  expect(parseContextWindowTokens('203K')).toBe(203_000)
  expect(parseContextWindowTokens('256k')).toBe(256_000)
  expect(parseContextWindowTokens('1M')).toBe(1_000_000)
  expect(parseContextWindowTokens('1.5m')).toBe(1_500_000)
  expect(parseContextWindowTokens(' 262K ')).toBe(262_000)
})

test('parseContextWindowTokens: invalid input → undefined', () => {
  expect(parseContextWindowTokens('')).toBeUndefined()
  expect(parseContextWindowTokens('unknown')).toBeUndefined()
  expect(parseContextWindowTokens('0K')).toBeUndefined()
  expect(parseContextWindowTokens('-5K')).toBeUndefined()
  expect(parseContextWindowTokens('128000')).toBeUndefined() // plain numbers are not display strings
})

test('every preset model contextWindow parses (login flow auto-sets the limit from it)', () => {
  for (const provider of CHINA_LLM_PROVIDERS) {
    for (const model of provider.models) {
      expect(parseContextWindowTokens(model.contextWindow)).toBeGreaterThan(0)
    }
  }
})
