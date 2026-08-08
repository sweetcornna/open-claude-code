import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  CONTEXT_1M,
  CONTEXT_200K,
  CONTEXT_272K,
  getProviderFamily,
  getTierDefaults,
} from '../tierDefaults.js'
import { getModelTier, isModelTier, MODEL_TIERS } from '../modelTier.js'

const TIER_ENV_KEYS = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'GROK'].flatMap(
  prefix =>
    MODEL_TIERS.map(tier => `${prefix}_DEFAULT_${tier.toUpperCase()}_MODEL`),
)
const savedTierEnv = Object.fromEntries(
  TIER_ENV_KEYS.map(key => [key, process.env[key]]),
)

beforeEach(() => {
  for (const key of TIER_ENV_KEYS) delete process.env[key]
})

afterAll(() => {
  for (const key of TIER_ENV_KEYS) {
    const value = savedTierEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getProviderFamily', () => {
  test('classifies the four families', () => {
    expect(getProviderFamily('deepseek-v4-pro')).toBe('deepseek')
    expect(getProviderFamily('deepseek-ai/DeepSeek-V4-Pro')).toBe('deepseek')
    expect(getProviderFamily('gpt-5.6-sol')).toBe('gpt')
    expect(getProviderFamily('gpt-5.6-terra-codex')).toBe('gpt')
    expect(getProviderFamily('claude-opus-5')).toBe('claude')
    expect(getProviderFamily('claude-fable-5')).toBe('claude')
    expect(getProviderFamily('glm-5.2')).toBe('other')
    expect(getProviderFamily('qwen3-max')).toBe('other')
  })

  test('DeepSeek wins over a Claude-shaped alias', () => {
    // DeepSeek's Anthropic line accepts claude-* names; the concrete id is
    // what reaches here, but a gateway could hand back either.
    expect(getProviderFamily('deepseek-v4-flash')).toBe('deepseek')
  })

  test("OpenAI's o-series counts as GPT", () => {
    // They carry none of the GPT spelling, so they fell into `other` and were
    // handed the 200k fallback instead of the family's 272k budget.
    for (const model of [
      'o1',
      'o1-preview',
      'o1-mini',
      'o3',
      'o3-mini',
      'o4-mini',
    ]) {
      expect(getProviderFamily(model)).toBe('gpt')
    }
    expect(getTierDefaults('o3-mini').contextTokens).toBe(CONTEXT_272K)
  })

  test('the o-series test does not swallow other ids starting with o', () => {
    expect(getProviderFamily('claude-opus-5')).toBe('claude')
    expect(getProviderFamily('opus')).toBe('claude')
    expect(getProviderFamily('openai/gpt-oss-120b')).toBe('other')
    expect(getProviderFamily('olmo-2')).toBe('other')
  })
})

describe('getTierDefaults', () => {
  test('DeepSeek: max effort, 1M window', () => {
    expect(getTierDefaults('deepseek-v4-pro')).toEqual({
      effort: 'max',
      contextTokens: CONTEXT_1M,
    })
  })

  test('GPT: xhigh effort, 272k window', () => {
    expect(getTierDefaults('gpt-5.6-sol')).toEqual({
      effort: 'xhigh',
      contextTokens: CONTEXT_272K,
    })
  })

  test('Claude opus and fable get the 1M window', () => {
    for (const model of ['claude-opus-5', 'claude-fable-5']) {
      expect(getTierDefaults(model).contextTokens).toBe(CONTEXT_1M)
    }
  })

  test('Claude sonnet and haiku keep 200k but think as hard as opus', () => {
    // The exception is about window capability, not about effort preference.
    for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(getTierDefaults(model)).toEqual({
        effort: 'xhigh',
        contextTokens: CONTEXT_200K,
      })
    }
  })

  test('Gemini and Grok default to the rung their mapping treats as identity', () => {
    // `high` is what services/api/{gemini,grok}/reasoning.ts define as "send
    // what the provider would have done anyway", so turning the mapping on does
    // not silently re-tune every existing session.
    for (const model of ['gemini-3.1-pro', 'grok-3-mini-fast']) {
      expect(getTierDefaults(model)).toEqual({
        effort: 'high',
        contextTokens: CONTEXT_200K,
      })
    }
  })

  test('everything else: xhigh effort, 200k window', () => {
    for (const model of ['glm-5.2', 'qwen3-max', 'mimo-7b']) {
      expect(getTierDefaults(model)).toEqual({
        effort: 'xhigh',
        contextTokens: CONTEXT_200K,
      })
    }
  })

  test('an explicit tier argument beats sniffing the id', () => {
    // A gateway serving Claude under an opaque name: the caller knows the
    // alias the user asked for even when the id says nothing.
    expect(getTierDefaults('claude-internal-x', 'opus').contextTokens).toBe(
      CONTEXT_1M,
    )
    expect(getTierDefaults('claude-internal-x', 'haiku').contextTokens).toBe(
      CONTEXT_200K,
    )
  })
})

describe('getModelTier', () => {
  test('maps concrete ids to their alias', () => {
    expect(getModelTier('claude-haiku-4-5')).toBe('haiku')
    expect(getModelTier('claude-sonnet-5')).toBe('sonnet')
    expect(getModelTier('claude-opus-5')).toBe('opus')
    expect(getModelTier('claude-fable-5')).toBe('fable')
  })

  test('undefined for ids that name no tier', () => {
    expect(getModelTier('deepseek-v4-pro')).toBeUndefined()
    expect(getModelTier('gpt-5.6-sol')).toBeUndefined()
  })

  test('is case-insensitive and tolerates the [1m] suffix', () => {
    expect(getModelTier('CLAUDE-OPUS-5')).toBe('opus')
    expect(getModelTier('claude-opus-5[1m]')).toBe('opus')
  })

  test('isModelTier guards settings.json values', () => {
    for (const tier of MODEL_TIERS) expect(isModelTier(tier)).toBe(true)
    expect(isModelTier('best')).toBe(false)
    expect(isModelTier(undefined)).toBe(false)
    expect(isModelTier(3)).toBe(false)
  })
})
