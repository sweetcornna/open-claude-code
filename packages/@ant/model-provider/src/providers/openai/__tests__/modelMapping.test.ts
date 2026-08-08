import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { resolveOpenAIModel } from '../modelMapping.js'

describe('resolveOpenAIModel', () => {
  const originalEnv = {
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_DEFAULT_HAIKU_MODEL: process.env.OPENAI_DEFAULT_HAIKU_MODEL,
    OPENAI_DEFAULT_SONNET_MODEL: process.env.OPENAI_DEFAULT_SONNET_MODEL,
    OPENAI_DEFAULT_OPUS_MODEL: process.env.OPENAI_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  }

  beforeEach(() => {
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_DEFAULT_HAIKU_MODEL
    delete process.env.OPENAI_DEFAULT_SONNET_MODEL
    delete process.env.OPENAI_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  })

  afterEach(() => {
    Object.assign(process.env, originalEnv)
  })

  test('OPENAI_MODEL is the fallback for an unconfigured tier', () => {
    process.env.OPENAI_MODEL = 'my-custom-model'
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('my-custom-model')
  })

  test('an explicit provider model is never replaced by OPENAI_MODEL', () => {
    process.env.OPENAI_MODEL = 'default-model'
    expect(resolveOpenAIModel('selected-model')).toBe('selected-model')
  })

  test('a tier override takes priority over OPENAI_MODEL', () => {
    process.env.OPENAI_MODEL = 'default-model'
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'tier-model'
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('tier-model')
  })

  test('ANTHROPIC_DEFAULT_SONNET_MODEL overrides default map', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'my-sonnet'
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('my-sonnet')
  })

  test('ANTHROPIC_DEFAULT_HAIKU_MODEL overrides default map', () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-haiku'
    expect(resolveOpenAIModel('claude-haiku-4-5-20251001')).toBe('my-haiku')
  })

  test('ANTHROPIC_DEFAULT_OPUS_MODEL overrides default map', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'my-opus'
    expect(resolveOpenAIModel('claude-opus-4-6')).toBe('my-opus')
  })

  test('maps sonnet-family models to the balanced default', () => {
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('gpt-5.6-terra')
  })

  test('maps haiku-family models to the fast default', () => {
    expect(resolveOpenAIModel('claude-haiku-4-5-20251001')).toBe('gpt-5.6-luna')
  })

  test('maps opus-family models to the frontier default', () => {
    expect(resolveOpenAIModel('claude-opus-4-6')).toBe('gpt-5.6-sol')
  })

  test('family match does not require a known model ID', () => {
    expect(resolveOpenAIModel('claude-opus-9-99')).toBe('gpt-5.6-sol')
  })

  test('passes through unknown model name', () => {
    expect(resolveOpenAIModel('some-random-model')).toBe('some-random-model')
  })

  test('strips [1m] suffix', () => {
    expect(resolveOpenAIModel('claude-sonnet-4-6[1m]')).toBe('gpt-5.6-terra')
  })
})
