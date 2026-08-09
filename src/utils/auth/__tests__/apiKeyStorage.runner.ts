import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupAnalyticsMock } from '../../../../tests/mocks/analytics.js'
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { secureStorageMock } from '../../../../tests/mocks/secureStorage.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/secureStorage/index.ts', secureStorageMock.mock)

const events: string[] = []
const analyticsMock = setupAnalyticsMock({
  logEvent: event => {
    events.push(event)
  },
})
const axiosMock = setupAxiosMock()

beforeAll(() => {
  axiosMock.useStubs = true
})

const originalPath = process.env.PATH
const originalPlatform = process.platform
const originalConfigDir = process.env.OCC_CONFIG_DIR
const { occConfigDir } = await import('../../../config/paths.js')
const { getGlobalConfig, saveGlobalConfig } = await import(
  '../../config/config.js'
)
const { installOAuthTokens } = await import('../../../cli/handlers/auth.js')
const { maybeRemoveApiKeyFromMacOSKeychainThrows } = await import(
  '../authPortable.js'
)
const { removeApiKey, saveApiKey } = await import('../auth.js')
let tempDir: string
let securityArgsLog: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-api-key-storage-'))
  securityArgsLog = join(tempDir, 'security-args.log')
  const securityPath = join(tempDir, 'security')
  writeFileSync(
    securityPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SECURITY_ARGS_LOG"\nif [ "$1" = "delete-generic-password" ]; then\n  exit "$SECURITY_DELETE_EXIT"\nfi\nexit "$SECURITY_WRITE_EXIT"\n',
  )
  chmodSync(securityPath, 0o755)
  process.env.PATH = `${tempDir}:${originalPath ?? ''}`
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  process.env.SECURITY_ARGS_LOG = securityArgsLog
  process.env.SECURITY_DELETE_EXIT = '0'
  process.env.SECURITY_WRITE_EXIT = '0'
  Object.defineProperty(process, 'platform', {
    value: 'darwin',
    configurable: true,
  })
  events.length = 0
  secureStorageMock.reset()
  axiosMock.stubs.get = async (url: string) =>
    url.includes('claude_code_first_token_date')
      ? { status: 200, data: { first_token_date: null } }
      : {
          status: 200,
          statusText: 'OK',
          data: {
            organization_role: 'admin',
            workspace_role: 'member',
            organization_name: 'Test Org',
          },
        }
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: undefined,
    oauthAccount: undefined,
    claudeCodeFirstTokenDate: undefined,
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
  }))
})

afterEach(() => {
  secureStorageMock.reset()
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  occConfigDir.cache.clear?.()
  delete process.env.SECURITY_ARGS_LOG
  delete process.env.SECURITY_DELETE_EXIT
  delete process.env.SECURITY_WRITE_EXIT
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  })
  rmSync(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  axiosMock.useStubs = false
  analyticsMock.reset()
})

describe('Console API key storage', () => {
  test('treats a missing pre-login keychain entry as already clean', async () => {
    process.env.SECURITY_DELETE_EXIT = '44'

    await expect(
      maybeRemoveApiKeyFromMacOSKeychainThrows(),
    ).resolves.toBeUndefined()
  })

  test('falls back without losing the key when security rejects the write', async () => {
    const apiKey = 'sk-ant-api03-storage-fallback-test-key'
    process.env.SECURITY_DELETE_EXIT = '44'
    process.env.SECURITY_WRITE_EXIT = '1'

    await saveApiKey(apiKey)

    expect(getGlobalConfig().primaryApiKey).toBe(apiKey)
    expect(getGlobalConfig().customApiKeyResponses?.approved).toContain(
      apiKey.slice(-20),
    )
    expect(events).not.toContain('tengu_api_key_saved_to_keychain')
    expect(events).toContain('tengu_api_key_keychain_error')
    expect(events).toContain('tengu_api_key_saved_to_config')
  })

  test('upserts before retiring the config fallback', async () => {
    saveGlobalConfig(current => ({
      ...current,
      primaryApiKey: 'old-config-key',
    }))

    await saveApiKey('sk-ant-api03-new-keychain-key')

    expect(readFileSync(securityArgsLog, 'utf8')).toBe('-i\n')
    expect(getGlobalConfig().primaryApiKey).toBeUndefined()
  })

  test('does not clear the config fallback when keychain deletion fails', async () => {
    saveGlobalConfig(current => ({
      ...current,
      primaryApiKey: 'keep-config-key',
    }))
    process.env.SECURITY_DELETE_EXIT = '1'

    await expect(removeApiKey()).rejects.toThrow(
      'Failed to delete keychain entry',
    )

    expect(getGlobalConfig().primaryApiKey).toBe('keep-config-key')
  })

  test('replaces Anthropic OAuth without touching independent credentials', async () => {
    const geminiPath = join(tempDir, 'gemini-antigravity-auth.json')
    const chatgptPath = join(tempDir, 'openai-chatgpt-auth.json')
    const geminiSentinel = '{"provider":"gemini","refresh":"keep-me"}\n'
    const chatgptSentinel = '{"provider":"chatgpt","refresh":"keep-me"}\n'
    writeFileSync(geminiPath, geminiSentinel)
    writeFileSync(chatgptPath, chatgptSentinel)
    secureStorageMock.seed({
      claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh' },
      mcpOAuthTokens: { server: { refreshToken: 'mcp-refresh' } },
      pluginSecrets: { plugin: { token: 'plugin-token' } },
    })

    await installOAuthTokens({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      profile: {
        account: {
          uuid: 'account-uuid',
          email: 'user@example.com',
          display_name: null,
          created_at: '2026-08-09T00:00:00.000Z',
        },
        organization: {
          uuid: 'organization-uuid',
          has_extra_usage_enabled: false,
          billing_type: 'stripe_subscription',
          subscription_created_at: null,
        },
      },
    })

    expect(readFileSync(geminiPath, 'utf8')).toBe(geminiSentinel)
    expect(readFileSync(chatgptPath, 'utf8')).toBe(chatgptSentinel)
    expect(secureStorageMock.snapshot()).toMatchObject({
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      },
      mcpOAuthTokens: { server: { refreshToken: 'mcp-refresh' } },
      pluginSecrets: { plugin: { token: 'plugin-token' } },
    })
    expect(getGlobalConfig().oauthAccount?.accountUuid).toBe('account-uuid')
  })

  test('preserves every old credential when OAuth storage replacement fails', async () => {
    const geminiPath = join(tempDir, 'gemini-antigravity-auth.json')
    const chatgptPath = join(tempDir, 'openai-chatgpt-auth.json')
    writeFileSync(geminiPath, 'gemini-sentinel')
    writeFileSync(chatgptPath, 'chatgpt-sentinel')
    const previousStorage = {
      claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh' },
      mcpOAuthTokens: { server: { refreshToken: 'mcp-refresh' } },
    }
    secureStorageMock.seed(previousStorage)
    secureStorageMock.setUpdateResult({ success: false })

    await expect(
      installOAuthTokens({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
        profile: {
          account: {
            uuid: 'account-uuid',
            email: 'user@example.com',
            display_name: null,
            created_at: '2026-08-09T00:00:00.000Z',
          },
          organization: {
            uuid: 'organization-uuid',
            has_extra_usage_enabled: false,
            billing_type: 'stripe_subscription',
            subscription_created_at: null,
          },
        },
      }),
    ).rejects.toThrow('Failed to save OAuth credentials to secure storage.')
    expect(secureStorageMock.writes()).toBe(0)
    expect(secureStorageMock.snapshot()).toEqual(previousStorage)
    expect(readFileSync(geminiPath, 'utf8')).toBe('gemini-sentinel')
    expect(readFileSync(chatgptPath, 'utf8')).toBe('chatgpt-sentinel')
    expect(getGlobalConfig().oauthAccount).toBeUndefined()
  })
})
