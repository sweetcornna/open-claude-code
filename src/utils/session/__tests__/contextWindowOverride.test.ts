import { afterEach, expect, test } from 'bun:test'
import { getContextWindowForModel } from '../context.js'

// Only the CLAUDE_CODE_MAX_CONTEXT_TOKENS fast path is exercised here: it
// returns before any config/settings/provider access, so no mocks are needed.
// Assertions that would fall through to capability lookup use a '[1m]' model,
// which also short-circuits before the heavy path.

const ENV_KEYS = ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'USER_TYPE'] as const
const saved: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) saved[k] = process.env[k]

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('CLAUDE_CODE_MAX_CONTEXT_TOKENS applies without USER_TYPE=ant (third-party model knob)', () => {
  delete process.env.USER_TYPE
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '128000'
  expect(getContextWindowForModel('glm-4.6')).toBe(128000)
})

test('override can also raise the window beyond the 200k fallback', () => {
  delete process.env.USER_TYPE
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000000'
  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_000_000)
})

test('override wins over [1m] suffix detection', () => {
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '128000'
  expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(128000)
})

test('invalid or non-positive override is ignored (falls through to detection)', () => {
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = 'abc'
  expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000)
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '0'
  expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000)
})

test('China-preset models resolve their real window per model, not the 200k fallback', () => {
  // One API key exposes the provider's whole catalog and those catalogs mix
  // windows, so the login flow stopped pinning a single global override. Without
  // this lookup a 1M DeepSeek would compact five times too early, and a 203K GLM
  // would be told it has 200k.
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_000_000)
  expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_000_000)
  expect(getContextWindowForModel('glm-4.7')).toBe(205_000)
  expect(getContextWindowForModel('glm-4.7-flash')).toBe(203_000)
})

test('the env override still wins over the preset lookup', () => {
  // The preset table is detection, not a second override — CLAUDE.md pins
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS as the single correction knob.
  delete process.env.USER_TYPE
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '64000'
  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(64_000)
})
