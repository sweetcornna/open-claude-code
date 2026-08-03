import { afterEach, describe, expect, test } from 'bun:test'
import {
  ANTIGRAVITY_AUTH_MODE,
  ANTIGRAVITY_MODELS_BY_TIER,
  buildAntigravityAutoConfigEnv,
  findAntigravityModelOption,
  isAntigravityAuthMode,
} from '../antigravityModels.js'

const ORIGINAL_AUTH_MODE = process.env.GEMINI_AUTH_MODE

afterEach(() => {
  if (ORIGINAL_AUTH_MODE === undefined) delete process.env.GEMINI_AUTH_MODE
  else process.env.GEMINI_AUTH_MODE = ORIGINAL_AUTH_MODE
})

describe('isAntigravityAuthMode', () => {
  test('true only for the exact mode value', () => {
    process.env.GEMINI_AUTH_MODE = ANTIGRAVITY_AUTH_MODE
    expect(isAntigravityAuthMode()).toBe(true)
  })

  test('false when unset', () => {
    delete process.env.GEMINI_AUTH_MODE
    expect(isAntigravityAuthMode()).toBe(false)
  })

  test('false for a near-miss value — no fuzzy matching', () => {
    process.env.GEMINI_AUTH_MODE = 'Antigravity'
    expect(isAntigravityAuthMode()).toBe(false)
    process.env.GEMINI_AUTH_MODE = 'antigravity-oauth'
    expect(isAntigravityAuthMode()).toBe(false)
  })
})

describe('buildAntigravityAutoConfigEnv', () => {
  test('writes exactly the keys a zero-touch session needs', () => {
    const env = buildAntigravityAutoConfigEnv()
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'GEMINI_AUTH_MODE',
      'GEMINI_DEFAULT_HAIKU_MODEL',
      'GEMINI_DEFAULT_OPUS_MODEL',
      'GEMINI_DEFAULT_SONNET_MODEL',
    ])
  })

  test('turns on the Antigravity backend and maps every tier', () => {
    const env = buildAntigravityAutoConfigEnv()
    expect(env.GEMINI_AUTH_MODE).toBe(ANTIGRAVITY_AUTH_MODE)
    expect(env.GEMINI_DEFAULT_OPUS_MODEL).toBe(ANTIGRAVITY_MODELS_BY_TIER.opus)
    expect(env.GEMINI_DEFAULT_SONNET_MODEL).toBe(
      ANTIGRAVITY_MODELS_BY_TIER.sonnet,
    )
    expect(env.GEMINI_DEFAULT_HAIKU_MODEL).toBe(
      ANTIGRAVITY_MODELS_BY_TIER.haiku,
    )
  })

  test('sets the context window so auto-compact does not use the 200k fallback', () => {
    const env = buildAntigravityAutoConfigEnv()
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
  })

  test('never sets GEMINI_MODEL — it would collapse all three tiers into one', () => {
    // resolveGeminiModel() short-circuits on GEMINI_MODEL, so writing it here
    // would send haiku-tier subagent traffic to the Pro model.
    expect(buildAntigravityAutoConfigEnv()).not.toHaveProperty('GEMINI_MODEL')
  })

  test('honours a model override for the sonnet (main-loop) tier only', () => {
    const env = buildAntigravityAutoConfigEnv({ model: 'gemini-pro-agent' })
    expect(env.GEMINI_DEFAULT_SONNET_MODEL).toBe('gemini-pro-agent')
    expect(env.GEMINI_DEFAULT_HAIKU_MODEL).toBe(
      ANTIGRAVITY_MODELS_BY_TIER.haiku,
    )
  })

  test('an unknown override model still gets the default context window', () => {
    const env = buildAntigravityAutoConfigEnv({ model: 'some-future-model' })
    expect(env.GEMINI_DEFAULT_SONNET_MODEL).toBe('some-future-model')
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
  })
})

describe('findAntigravityModelOption', () => {
  test('matches case-insensitively and ignores a [1m] suffix', () => {
    expect(findAntigravityModelOption('GEMINI-PRO-AGENT')?.value).toBe(
      'gemini-pro-agent',
    )
    expect(findAntigravityModelOption('gemini-pro-agent[1m]')?.value).toBe(
      'gemini-pro-agent',
    )
  })

  test('returns undefined for a model Antigravity does not serve', () => {
    expect(findAntigravityModelOption('gpt-5.6-sol')).toBeUndefined()
  })
})
