import { afterEach, describe, expect, test } from 'bun:test'
import { getModelTier, getModelTiers, isModelTier } from '../modelTier.js'

/**
 * The tier of a model id is what per-tier settings are keyed on. Getting it
 * back as `undefined` is not a visible failure — it just makes every value the
 * user configured do nothing, which is how this shipped for third-party ids.
 */

const TOUCHED = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'GEMINI_DEFAULT_OPUS_MODEL',
  'GROK_DEFAULT_SONNET_MODEL',
] as const

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key]
})

describe('getModelTier by name', () => {
  test('reads the tier out of a Claude id', () => {
    expect(getModelTier('claude-opus-5')).toBe('opus')
    expect(getModelTier('claude-sonnet-5')).toBe('sonnet')
    expect(getModelTier('claude-haiku-4-5')).toBe('haiku')
    expect(getModelTier('claude-fable-5')).toBe('fable')
  })

  test('a named tier wins over any pin', () => {
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'claude-opus-5'
    expect(getModelTiers('claude-opus-5')).toEqual(['opus'])
  })

  test('undefined when nothing names or pins the id', () => {
    expect(getModelTier('deepseek-v4-pro')).toBeUndefined()
    expect(getModelTiers('glm-5.2')).toEqual([])
    expect(getModelTier('')).toBeUndefined()
  })
})

describe('getModelTiers by pin', () => {
  test('reads the user tier pins backwards', () => {
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'

    expect(getModelTiers('deepseek-v4-pro')).toEqual(['opus'])
    expect(getModelTiers('deepseek-v4-flash')).toEqual(['haiku'])
  })

  test('every prefix a provider-setup spec can write is searched', () => {
    process.env.GEMINI_DEFAULT_OPUS_MODEL = 'gemini-3-pro'
    process.env.GROK_DEFAULT_SONNET_MODEL = 'grok-5'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'my-deployment-id'

    expect(getModelTier('gemini-3-pro')).toBe('opus')
    expect(getModelTier('grok-5')).toBe('sonnet')
    expect(getModelTier('my-deployment-id')).toBe('fable')
  })

  test('matching ignores case and the [1m] suffix on either side', () => {
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'DeepSeek-V4-Pro[1m]'
    expect(getModelTier('deepseek-v4-pro')).toBe('opus')
    expect(getModelTier('deepseek-v4-pro[1m]')).toBe('opus')
  })

  test('several tiers on one id come back most capable first', () => {
    // The shape a DeepSeek login actually writes when one checkpoint backs
    // every alias — nothing in the resolved request can tell them apart.
    for (const key of [
      'OPENAI_DEFAULT_HAIKU_MODEL',
      'OPENAI_DEFAULT_SONNET_MODEL',
      'OPENAI_DEFAULT_OPUS_MODEL',
      'OPENAI_DEFAULT_FABLE_MODEL',
    ]) {
      process.env[key] = 'deepseek-v4-flash'
    }

    expect(getModelTiers('deepseek-v4-flash')).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ])
    expect(getModelTier('deepseek-v4-flash')).toBe('fable')
  })

  test('a tier is listed once even when both prefixes pin it', () => {
    // The DeepSeek Anthropic wire mirrors OPENAI_* onto ANTHROPIC_*, so both
    // are set for the same tier and a naive scan would double-count it.
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    expect(getModelTiers('deepseek-v4-pro')).toEqual(['opus'])
  })
})

describe('isModelTier', () => {
  test('guards values coming out of settings.json', () => {
    expect(isModelTier('opus')).toBe(true)
    expect(isModelTier('Opus')).toBe(false)
    expect(isModelTier(undefined)).toBe(false)
    expect(isModelTier(3)).toBe(false)
  })
})
