import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  getAutoCompactThreshold,
  getBlockingLimit,
  getEffectiveContextWindowSize,
} from '../autoCompact.js'

const ENV_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
)

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000000'
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('auto-compact window thresholds', () => {
  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW controls the production token window', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000'

    expect(getEffectiveContextWindowSize('claude-sonnet-4-6')).toBe(480_000)
    expect(getAutoCompactThreshold('claude-sonnet-4-6')).toBe(467_000)
  })

  test('a session window overrides settings without changing the model limit', () => {
    const context = {
      autoCompactWindow: 500_000,
      autoCompactWindowOverride: true,
    }

    expect(getAutoCompactThreshold('claude-sonnet-4-6', context)).toBe(467_000)
    expect(getBlockingLimit('claude-sonnet-4-6', context)).toBe(977_000)
  })

  test('explicit session auto ignores a smaller environment-independent setting', () => {
    const context = {
      autoCompactWindow: undefined,
      autoCompactWindowOverride: true,
    }

    expect(getAutoCompactThreshold('claude-sonnet-4-6', context)).toBe(967_000)
  })

  test('the legacy percentage variable remains a test-only threshold override', () => {
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'

    expect(getAutoCompactThreshold('claude-sonnet-4-6')).toBe(490_000)
  })
})
