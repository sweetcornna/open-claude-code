import { describe, expect, test } from 'bun:test'
import { buildTierSettings, prefillTierFields } from '../tierPersistence.js'

/**
 * What a wizard save leaves in settings.json.
 *
 * The rule worth pinning is the asymmetry between a first setup and a re-run:
 * the first must persist concrete values (that is the point of the field), the
 * second must not flatten per-tier work someone did in `/model` just because
 * they reopened the form to change an endpoint.
 */

const NO_TIER_MODELS = {
  haiku_model: '',
  sonnet_model: '',
  opus_model: '',
  fable_model: '',
}

const DEEPSEEK_TIERS = {
  haiku_model: 'deepseek-v4-flash',
  sonnet_model: 'deepseek-v4-pro',
  opus_model: 'deepseek-v4-pro',
  fable_model: 'deepseek-v4-pro',
}

describe('buildTierSettings on a first setup', () => {
  test('persists each tier’s own family default when both fields are empty', () => {
    const patch = buildTierSettings({
      tierModels: DEEPSEEK_TIERS,
      defaultModel: '',
      contextTokens: undefined,
      effort: undefined,
      existing: undefined,
    })

    // DeepSeek's family row is max / 1M, and it applies to all four because
    // every tier has a DeepSeek model behind it.
    expect(patch).toEqual({
      haiku: { effort: 'max', contextTokens: 1_000_000 },
      sonnet: { effort: 'max', contextTokens: 1_000_000 },
      opus: { effort: 'max', contextTokens: 1_000_000 },
      fable: { effort: 'max', contextTokens: 1_000_000 },
    })
  })

  test('defaults follow the model, so mixed tiers get different windows', () => {
    const patch = buildTierSettings({
      tierModels: {
        haiku_model: 'claude-haiku-4-5',
        sonnet_model: 'claude-sonnet-5',
        opus_model: 'claude-opus-5',
        fable_model: 'claude-fable-5',
      },
      defaultModel: '',
      contextTokens: undefined,
      effort: undefined,
      existing: undefined,
    })

    expect(patch.haiku?.contextTokens).toBe(200_000)
    expect(patch.opus?.contextTokens).toBe(1_000_000)
    expect(patch.fable?.contextTokens).toBe(1_000_000)
    expect(patch.sonnet?.effort).toBe('high')
  })

  test('an explicit value is applied to every tier', () => {
    const patch = buildTierSettings({
      tierModels: DEEPSEEK_TIERS,
      defaultModel: '',
      contextTokens: 128_000,
      effort: 'low',
      existing: undefined,
    })

    for (const tier of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
      expect(patch[tier]).toEqual({ effort: 'low', contextTokens: 128_000 })
    }
  })

  test('tiers with no model fall back to the default-model field', () => {
    const patch = buildTierSettings({
      tierModels: NO_TIER_MODELS,
      defaultModel: 'deepseek-v4-pro',
      contextTokens: undefined,
      effort: undefined,
      existing: undefined,
    })
    expect(patch.opus).toEqual({ effort: 'max', contextTokens: 1_000_000 })
  })

  test('a tier with nothing behind it is skipped, not guessed at', () => {
    // Guessing would write the "unknown provider" row (xhigh / 200k) over a
    // tier that resolves correctly at runtime once a model exists.
    const patch = buildTierSettings({
      tierModels: NO_TIER_MODELS,
      defaultModel: '',
      contextTokens: undefined,
      effort: undefined,
      existing: undefined,
    })
    expect(patch).toEqual({})
  })
})

describe('buildTierSettings when tiers are already configured', () => {
  const existing = {
    opus: { effort: 'max' as const, contextTokens: 1_000_000 },
  }

  test('empty fields touch nothing', () => {
    const patch = buildTierSettings({
      tierModels: DEEPSEEK_TIERS,
      defaultModel: '',
      contextTokens: undefined,
      effort: undefined,
      existing,
    })
    expect(patch).toEqual({})
  })

  test('only the axis the user filled in is written', () => {
    const patch = buildTierSettings({
      tierModels: DEEPSEEK_TIERS,
      defaultModel: '',
      contextTokens: 272_000,
      effort: undefined,
      existing,
    })

    expect(patch.opus).toEqual({ contextTokens: 272_000 })
    expect(patch.haiku).toEqual({ contextTokens: 272_000 })
    // No effort key at all — the saved per-tier levels survive the merge.
    expect(patch.opus).not.toHaveProperty('effort')
  })

  test('a tier holding only a leftover empty object does not count as configured', () => {
    const patch = buildTierSettings({
      tierModels: DEEPSEEK_TIERS,
      defaultModel: '',
      contextTokens: undefined,
      effort: undefined,
      existing: { opus: {} },
    })
    expect(patch.opus).toEqual({ effort: 'max', contextTokens: 1_000_000 })
  })
})

describe('prefillTierFields', () => {
  test('offers a saved value back when every configured tier agrees', () => {
    expect(
      prefillTierFields(
        {
          haiku: { effort: 'low', contextTokens: 128_000 },
          opus: { effort: 'low', contextTokens: 128_000 },
        },
        {},
      ),
    ).toEqual({ maxContext: '128000', effort: 'low' })
  })

  test('disagreement reads as empty, so pressing Enter cannot flatten it', () => {
    expect(
      prefillTierFields(
        {
          haiku: { effort: 'low', contextTokens: 128_000 },
          opus: { effort: 'max', contextTokens: 1_000_000 },
        },
        {},
      ),
    ).toEqual({ maxContext: '', effort: '' })
  })

  test('falls back to the legacy env key so an older config opens honestly', () => {
    expect(
      prefillTierFields(undefined, {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      }),
    ).toEqual({ maxContext: '1000000', effort: '' })
  })

  test('a per-tier value outranks the legacy env key', () => {
    expect(
      prefillTierFields(
        { opus: { contextTokens: 272_000 } },
        {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
        },
      ),
    ).toEqual({ maxContext: '272000', effort: '' })
  })
})
