import { describe, expect, test } from 'bun:test'
import {
  CHATGPT_CODEX_MODELS_BY_TIER,
  isCodexFamilyModel,
  resolveChatGPTCodexModelForTier,
} from '../chatgptModels.js'

describe('resolveChatGPTCodexModelForTier', () => {
  test('maps occ capability tiers to the matching GPT-5.6 models', () => {
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'opus',
        isChatGPTAuth: true,
      }),
    ).toBe('gpt-5.6-sol')
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'sonnet',
        isChatGPTAuth: true,
      }),
    ).toBe('gpt-5.6-terra')
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'haiku',
        isChatGPTAuth: true,
      }),
    ).toBe('gpt-5.6-luna')
  })

  test('keeps the tier map as the single source of default assignments', () => {
    expect(CHATGPT_CODEX_MODELS_BY_TIER).toEqual({
      opus: 'gpt-5.6-sol',
      sonnet: 'gpt-5.6-terra',
      haiku: 'gpt-5.6-luna',
    })
  })

  test('prefers family overrides over OAuth defaults', () => {
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'haiku',
        isChatGPTAuth: true,
        tierOverride: 'custom-haiku',
      }),
    ).toBe('custom-haiku')
  })

  test('prefers a task-specific override over the family override', () => {
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'haiku',
        isChatGPTAuth: true,
        tierOverride: 'custom-haiku',
        taskOverride: 'custom-small-fast',
      }),
    ).toBe('custom-small-fast')
  })

  test('does not apply GPT defaults outside ChatGPT OAuth mode', () => {
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'opus',
        isChatGPTAuth: false,
      }),
    ).toBeUndefined()
  })

  test('preserves explicit compatible-provider tier configuration', () => {
    expect(
      resolveChatGPTCodexModelForTier({
        tier: 'sonnet',
        isChatGPTAuth: false,
        tierOverride: 'compatible-provider-model',
      }),
    ).toBe('compatible-provider-model')
  })
})

describe('isCodexFamilyModel', () => {
  test("matches ids containing 'codex'", () => {
    expect(isCodexFamilyModel('gpt-5.3-codex')).toBe(true)
    expect(isCodexFamilyModel('gpt-5.3-codex-spark')).toBe(true)
    expect(isCodexFamilyModel('codex-mini-latest')).toBe(true)
  })

  test('matches the GPT-5 generation including bare and suffixed ids', () => {
    expect(isCodexFamilyModel('gpt-5')).toBe(true)
    expect(isCodexFamilyModel('gpt-5.2')).toBe(true)
    expect(isCodexFamilyModel('gpt-5.4-mini')).toBe(true)
    expect(isCodexFamilyModel('gpt-5.6-sol')).toBe(true)
    expect(isCodexFamilyModel('GPT-5.6-Terra')).toBe(true)
  })

  test('strips the [1m] long-context suffix before matching', () => {
    expect(isCodexFamilyModel('gpt-5.6-sol[1m]')).toBe(true)
  })

  test('rejects Chat Completions era models and lookalikes', () => {
    expect(isCodexFamilyModel('gpt-4o')).toBe(false)
    expect(isCodexFamilyModel('gpt-4.1')).toBe(false)
    expect(isCodexFamilyModel('gpt-55')).toBe(false)
    expect(isCodexFamilyModel('deepseek-chat')).toBe(false)
    expect(isCodexFamilyModel('llama-3.1-70b')).toBe(false)
  })
})
