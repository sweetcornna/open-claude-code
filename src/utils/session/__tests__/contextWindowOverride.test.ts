import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../settings/types.js'

// Mostly the CLAUDE_CODE_MAX_CONTEXT_TOKENS fast path, which returns before any
// config/settings/provider access. The alias cases below do go deeper, and the
// per-tier arm they now reach reads userSettings — on a machine with
// `modelSettings.sonnet.contextTokens` configured, `getContextWindowForModel
// ('sonnet')` returns that instead of the value under test. The source is
// therefore pinned to empty through the shared complete-surface helper (the
// same one tierContextWindow.test.ts uses); a hand-written partial mock is what
// CLAUDE.md forbids, not this.
const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: () => ({}) as SettingsJson,
    getInitialSettings: () => ({}) as SettingsJson,
  }),
)
afterAll(() => settingsMock.reset())

const { getContextWindowForModel } = await import('../context.js')

const ENV_KEYS = [
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_USE_OPENAI',
  // getAPIProvider() answers Bedrock/Vertex/Foundry *before* it looks at
  // CLAUDE_CODE_USE_OPENAI, and the alias cases below only reach the
  // OPENAI_DEFAULT_<TIER>_MODEL reverse-lookup while the provider is 'openai'.
  // One leaked sibling key silently drops them back to the 200k fallback.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'USER_TYPE',
] as const
const saved: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) saved[k] = process.env[k]

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

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

test('GPT models use the 272k family default unless explicitly overridden', () => {
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  expect(getContextWindowForModel('gpt-5.6-sol')).toBe(272_000)
  expect(getContextWindowForModel('gpt-5.6-terra')).toBe(272_000)
})

test('the env override still wins over the preset lookup', () => {
  // The preset table is detection, not a second override — CLAUDE.md pins
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS as the single correction knob.
  delete process.env.USER_TYPE
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '64000'
  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(64_000)
})

test('DeepSeek models get their 1M window, whatever the id looks like', () => {
  // The 200k third-party fallback would auto-compact a DeepSeek session five
  // times earlier than it needs to.
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_000_000)
  expect(getContextWindowForModel('deepseek-chat')).toBe(1_000_000)
  // Self-hosted HuggingFace-style ids count too.
  expect(getContextWindowForModel('deepseek-ai/DeepSeek-V4-Pro')).toBe(
    1_000_000,
  )
})

test('CLAUDE_CODE_DISABLE_1M_CONTEXT walks DeepSeek back to the default window', () => {
  // The opt-out for a deployment that actually serves something smaller.
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(200_000)
})

test('a non-DeepSeek model on an unrelated endpoint is untouched', () => {
  // The DeepSeek branch must not widen anyone else's window.
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  expect(getContextWindowForModel('kimi-k2')).toBe(200_000)
})

test('a DeepSeek session driven by a family alias still gets 1M', () => {
  // The regression this pins: a default session's main-loop model is the alias
  // `sonnet`, and the DeepSeek id only appears after OPENAI_DEFAULT_SONNET_MODEL
  // is applied inside the adapter. Testing the alias against the DeepSeek
  // predicate said "no" for exactly the sessions that needed it, so the window
  // silently stayed at the 200k third-party fallback.
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
  process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
  expect(getContextWindowForModel('sonnet')).toBe(1_000_000)
  expect(getContextWindowForModel('haiku')).toBe(1_000_000)
})

test('an alias that resolves to a non-DeepSeek model is left alone', () => {
  // The alias resolution must not hand 1M to every OpenAI-compatible session.
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_DEFAULT_SONNET_MODEL = 'glm-4.7'
  expect(getContextWindowForModel('sonnet')).toBe(200_000)
})

// The mirror case — a first-party session must ignore leftover OPENAI_DEFAULT_*
// keys — is NOT asserted here on purpose. getAPIProvider() reads the real
// settings.json through getInitialSettings(), so on a machine configured for an
// OpenAI-compatible provider the assertion measures the developer's config
// rather than the code, and mocking settings/settings.js process-globally is
// what CLAUDE.md forbids. The provider gate lives in resolveModelForDeepSeekGate
// and was verified by hand against an isolated OCC_CONFIG_DIR.
