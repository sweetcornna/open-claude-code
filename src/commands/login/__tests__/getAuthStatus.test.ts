/**
 * Tests for getAuthStatus.ts
 * Covers subscription set/unset, workspace API key prefix variants, and third-party provider env vars.
 * All tests are pure (no network calls) — only process.env + mocked OAuth file reads.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
// auth goes through the shared complete-surface mock (missing exports get
// safe defaults); registered under the canonical '.js' specifier — see
// tests/mocks/auth.ts.
import { authMockWith } from '../../../../tests/mocks/auth.js'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { setupConfigMock } from '../../../../tests/mocks/config.js'

// Mock side-effect modules before importing subject
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
const settingsMock = setupSettingsMock({
  getInitialSettings: () => ({}),
  getSettings_DEPRECATED: () => ({}),
})
afterAll(() => settingsMock.reset())

const configMock = setupConfigMock({
  getGlobalConfig: () => ({
    workspaceApiKey: undefined,
  }),
  saveGlobalConfig: (_updater: unknown) => undefined,
})
afterAll(() => configMock.reset())

// We mock auth.ts getClaudeAIOAuthTokens to return controlled values
// per test — we mock getClaudeAIOAuthTokens from within the test using spies
// on process.env, no network calls happen.

const SUBSCRIPTION_TOKEN_FIXTURE = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'claude.ai'],
  subscriptionType: 'pro',
  rateLimitTier: null,
}

// We'll import getAuthStatus lazily after setting up mocks
describe('getAuthStatus', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    // Reset env to clean state before each test
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CEREBRAS_API_KEY
    delete process.env.GROQ_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
  })

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key]
      }
    }
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) {
        process.env[k] = v
      }
    }
  })

  test('subscription.active=false when no OAuth tokens present', async () => {
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.active).toBe(false)
    expect(status.subscription.plan).toBeNull()
  })

  test('subscription.active=true and plan=pro when OAuth tokens present with subscriptionType=pro', async () => {
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => SUBSCRIPTION_TOKEN_FIXTURE,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => true,
        getSubscriptionType: () => 'pro',
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.active).toBe(true)
    expect(status.subscription.plan).toBe('pro')
  })

  test('workspaceKey.set=false when ANTHROPIC_API_KEY not set', async () => {
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(false)
    expect(status.workspaceKey.prefixValid).toBe(false)
    expect(status.workspaceKey.keyPreview).toBeNull()
    expect(status.workspaceKey.source).toBeNull()
  })

  test('workspaceKey.set=true, prefixValid=true with valid sk-ant-api03- prefix', async () => {
    // 52-char key: prefix (14) + 38 chars
    process.env.ANTHROPIC_API_KEY =
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => true,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(true)
    expect(status.workspaceKey.keyPreview).not.toBeNull()
    // Preview must NOT include full key value
    expect(status.workspaceKey.keyPreview).not.toContain(
      'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    )
    // Preview must contain masked form
    expect(status.workspaceKey.keyPreview).toContain('...')
  })

  test('workspaceKey.prefixValid=false when key has wrong prefix', async () => {
    process.env.ANTHROPIC_API_KEY =
      'sk-wrong-prefix-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => true,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(false)
  })

  test('keyPreview format: shows first4 + ... + last2 + length for valid key', async () => {
    // Build a key: sk-ant-api03- (14 chars) + ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567 (34 chars) = 48 chars total
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567'
    process.env.ANTHROPIC_API_KEY = key
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => true,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    const preview = status.workspaceKey.keyPreview
    expect(preview).not.toBeNull()
    // Must contain length
    expect(preview).toContain(`(${key.length}`)
    // Must contain first 4 chars
    expect(preview).toContain('sk-a')
    // Must contain last 2 chars
    expect(preview).toContain('67')
    // Full suffix must not appear
    expect(preview).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567')
  })

  // ---------------------------------------------------------------------------
  // Dual-source workspace key tests (env vs settings)
  // ---------------------------------------------------------------------------

  test('workspaceKey.source=env when ANTHROPIC_API_KEY env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'X'.repeat(50)
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => true,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    configMock.set({
      getGlobalConfig: () => ({
        workspaceApiKey: 'sk-ant-api03-' + 'Y'.repeat(50),
      }),
    })
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.source).toBe('env')
    expect(status.workspaceKey.set).toBe(true)
  })

  test('workspaceKey.source=settings when only workspaceApiKey in config is set', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    configMock.set({
      getGlobalConfig: () => ({
        workspaceApiKey: 'sk-ant-api03-' + 'Z'.repeat(50),
      }),
    })
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.source).toBe('settings')
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(true)
  })

  test('workspaceKey.source=null when neither env nor settings has a key', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    configMock.set({
      getGlobalConfig: () => ({ workspaceApiKey: undefined }),
    })
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.source).toBeNull()
    expect(status.workspaceKey.set).toBe(false)
  })

  test('env takes precedence over settings when both are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-FROMENV' + 'E'.repeat(40)
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => true,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    configMock.set({
      getGlobalConfig: () => ({
        workspaceApiKey: 'sk-ant-api03-FROMSETTINGS' + 'S'.repeat(40),
      }),
    })
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    // env wins
    expect(status.workspaceKey.source).toBe('env')
    // preview must NOT contain the settings key suffix
    expect(status.workspaceKey.keyPreview).not.toContain('FROMSETTINGS')
  })

  // Third-party provider tests removed 2026-05-06 — that surface was deleted
  // from AuthStatus to defer to fork's existing /login form for OpenAI-compat
  // configuration. See AuthPlaneSummary.tsx for the rationale.

  test('subscription with non-standard subscriptionType → plan="unknown"', async () => {
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => ({
          ...SUBSCRIPTION_TOKEN_FIXTURE,
          subscriptionType: 'lifetime-deluxe',
        }),
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.plan).toBe('unknown')
  })

  test('activeProvider reflects env-driven openai selection with base URL and wire protocol', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
    process.env.OPENAI_WIRE_API = 'responses'
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.activeProvider.provider).toBe('openai')
    expect(status.activeProvider.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(status.activeProvider.wireApi).toBe('responses')
    expect(status.activeProvider.chatgptAuth).toBe(false)
  })

  test('activeProvider defaults to firstParty with no overrides', async () => {
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => null,
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.activeProvider.provider).toBe('firstParty')
    expect(status.activeProvider.wireApi).toBeNull()
  })

  test('subscription with subscriptionType=null → plan=null', async () => {
    mock.module(
      'src/utils/auth/auth.js',
      authMockWith({
        getClaudeAIOAuthTokens: () => ({
          ...SUBSCRIPTION_TOKEN_FIXTURE,
          subscriptionType: null,
        }),
        hasAnthropicApiKeyAuth: () => false,
        isAnthropicAuthEnabled: () => false,
        getSubscriptionType: () => null,
      }),
    )
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.plan).toBeNull()
  })
})
