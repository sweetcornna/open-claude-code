import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { get3PModelCapabilityOverride } from '../modelSupportOverrides.js'

const MODEL = 'shared-model'
const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function setThinkingOverride(capabilities = 'thinking'): void {
  process.env.ANTHROPIC_BASE_URL = 'https://third-party.example/anthropic'
  process.env.ANTHROPIC_MODEL = MODEL
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = capabilities
  process.env.OPENAI_DEFAULT_OPUS_MODEL = MODEL
  process.env.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = capabilities
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('get3PModelCapabilityOverride', () => {
  test('falls back immediately when a capability override is deleted', () => {
    setThinkingOverride()
    expect(get3PModelCapabilityOverride(MODEL, 'thinking')).toBe(true)

    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES

    expect(get3PModelCapabilityOverride(MODEL, 'thinking')).toBeUndefined()
  })

  test('reflects a changed capability override for the same model', () => {
    setThinkingOverride()
    expect(get3PModelCapabilityOverride(MODEL, 'thinking')).toBe(true)

    setThinkingOverride('effort')

    expect(get3PModelCapabilityOverride(MODEL, 'thinking')).toBe(false)
  })
})
