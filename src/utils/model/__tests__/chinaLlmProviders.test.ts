import { expect, test } from 'bun:test'
import {
  CHINA_LLM_PROVIDERS,
  chinaProviderTierEnv,
  findChinaProviderByBaseURL,
  getChinaProviderContextWindow,
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

test('every tier alias points at a model the provider actually ships', () => {
  // The login flow writes these into OPENAI_DEFAULT_{TIER}_MODEL verbatim; a
  // typo here is a 404 on the first request, not a load-time error.
  for (const provider of CHINA_LLM_PROVIDERS) {
    const ids = new Set(provider.models.map(m => m.id))
    for (const tier of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
      expect(ids.has(provider.tiers[tier])).toBe(true)
    }
  }
})

test('chinaProviderTierEnv never sets OPENAI_MODEL', () => {
  // OPENAI_MODEL overrides every family alias AND every explicit `/model <id>`
  // (see resolveOpenAIModel). Setting it would pin the session to one model,
  // which is the exact behavior this flow moved away from.
  for (const provider of CHINA_LLM_PROVIDERS) {
    const env = chinaProviderTierEnv(provider)
    expect(Object.keys(env).sort()).toEqual([
      'OPENAI_DEFAULT_FABLE_MODEL',
      'OPENAI_DEFAULT_HAIKU_MODEL',
      'OPENAI_DEFAULT_OPUS_MODEL',
      'OPENAI_DEFAULT_SONNET_MODEL',
    ])
    expect(env).not.toHaveProperty('OPENAI_MODEL')
  }
})

test('findChinaProviderByBaseURL matches pay-as-you-go and coding-plan endpoints', () => {
  expect(findChinaProviderByBaseURL('https://api.deepseek.com')?.id).toBe(
    'deepseek',
  )
  // Trailing slash and case must not defeat the match — the value comes from
  // OPENAI_BASE_URL, which users hand-edit.
  expect(findChinaProviderByBaseURL('https://API.DeepSeek.com/')?.id).toBe(
    'deepseek',
  )
  const zhipu = CHINA_LLM_PROVIDERS.find(p => p.id === 'zhipu')
  expect(findChinaProviderByBaseURL(zhipu?.codingPlan?.baseURL)?.id).toBe(
    'zhipu',
  )
})

test('findChinaProviderByBaseURL ignores unrelated and empty endpoints', () => {
  expect(
    findChinaProviderByBaseURL('https://api.openai.com/v1'),
  ).toBeUndefined()
  expect(findChinaProviderByBaseURL('')).toBeUndefined()
  expect(findChinaProviderByBaseURL(undefined)).toBeUndefined()
})

test('getChinaProviderContextWindow resolves per model, not per provider', () => {
  // GLM ships 203K and 205K models side by side — the reason the login flow no
  // longer pins one global CLAUDE_CODE_MAX_CONTEXT_TOKENS.
  expect(getChinaProviderContextWindow('glm-4.7')).toBe(205_000)
  expect(getChinaProviderContextWindow('glm-4.7-flash')).toBe(203_000)
  expect(getChinaProviderContextWindow('deepseek-v4-pro')).toBe(1_000_000)
  expect(getChinaProviderContextWindow('DeepSeek-V4-Flash')).toBe(1_000_000)
  expect(getChinaProviderContextWindow('gpt-5.5')).toBeUndefined()
  expect(getChinaProviderContextWindow('')).toBeUndefined()
})
