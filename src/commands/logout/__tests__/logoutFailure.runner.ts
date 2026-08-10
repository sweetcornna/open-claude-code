import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { secureStorageMock } from '../../../../tests/mocks/secureStorage.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/secureStorage/index.ts', secureStorageMock.mock)

const originalConfigDir = process.env.OCC_CONFIG_DIR
const originalPlatform = process.platform
const { occConfigDir } = await import('../../../config/paths.js')
const { authLogout } = await import('../../../cli/handlers/auth.js')
const { call, performLogout } = await import('../logout.js')
const { getSettingsForSource, updateSettingsForSource } = await import(
  '../../../utils/settings/settings.js'
)
const { getGlobalConfig, saveGlobalConfig } = await import(
  '../../../utils/config/config.js'
)
const { isAnthropicAuthEnabled } = await import('../../../utils/auth/auth.js')
const {
  applyDeepSeekAnthropicWire,
  isDeepSeekAnthropicWireActive,
  isDeepSeekMirroredApiKey,
} = await import('../../../utils/model/deepseekWire.js')
let tempDir: string

class ExitError extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`process.exit(${code})`)
  }
}

/**
 * Env that steers auth resolution. Cleared before each test and restored after,
 * so a developer's own exported provider keys cannot decide the outcome — half
 * of these are read by isAnthropicAuthEnabled() and the DeepSeek mirror.
 */
const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'GEMINI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_MODE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
] as const
let savedEnv: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-logout-failure-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  })
  savedEnv = {}
  for (const key of AUTH_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  secureStorageMock.reset()
  secureStorageMock.seed({
    claudeAiOauth: { accessToken: 'token' },
    mcpOAuthTokens: { server: { refreshToken: 'keep-me' } },
  })
  secureStorageMock.setUpdateResult({ success: false })
})

afterEach(() => {
  secureStorageMock.reset()
  for (const key of AUTH_ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  occConfigDir.cache.clear?.()
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  })
  rmSync(tempDir, { recursive: true, force: true })
})

describe('logout credential scope', () => {
  test('resets the account plane and keeps everything account-independent', async () => {
    secureStorageMock.setUpdateResult({ success: true })
    secureStorageMock.seed({
      claudeAiOauth: { accessToken: 'remove-me' },
      mcpOAuthTokens: { server: { refreshToken: 'mcp-refresh' } },
      pluginSecrets: { plugin: { token: 'plugin-token' } },
    })
    const chatgptPath = join(tempDir, 'openai-chatgpt-auth.json')
    const geminiPath = join(tempDir, 'gemini-antigravity-auth.json')
    const profilesPath = join(tempDir, 'provider-profiles.json')
    writeFileSync(chatgptPath, 'chatgpt-sentinel')
    writeFileSync(geminiPath, 'gemini-sentinel')
    writeFileSync(
      profilesPath,
      JSON.stringify({
        version: 1,
        active: 'ds',
        profiles: {
          ds: {
            name: 'ds',
            modelType: 'openai',
            env: { OPENAI_API_KEY: 'sk-saved' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        },
      }),
    )
    const searchOverrides = {
      anthropic: false,
      deepseek: true,
      gemini: false,
      codex: true,
      brave: false,
      exa: true,
      free: false,
    }
    const { error } = updateSettingsForSource('userSettings', {
      modelType: 'gemini',
      webSearchSources: searchOverrides,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'remove-me',
        ANTHROPIC_BASE_URL: 'https://anthropic-gateway.example',
        GEMINI_API_KEY: 'remove-gemini',
        OPENAI_API_KEY: 'remove-openai',
      },
    } as any)
    expect(error).toBeNull()

    await performLogout({ clearOnboarding: false })

    // Only the Anthropic OAuth record goes. MCP tokens and plugin secrets are
    // separate credential families sharing the same blob, and wiping the blob
    // wholesale would take them with it.
    expect(secureStorageMock.snapshot()).toEqual({
      mcpOAuthTokens: { server: { refreshToken: 'mcp-refresh' } },
      pluginSecrets: { plugin: { token: 'plugin-token' } },
    })
    expect(secureStorageMock.deletes()).toBe(0)

    // ChatGPT / Antigravity OAuth credentials ARE account state — they go.
    expect(existsSync(chatgptPath)).toBe(false)
    expect(existsSync(geminiPath)).toBe(false)

    // Saved provider profiles are an explicit user snapshot a layer above
    // settings: the file survives, only the active pointer is dropped.
    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8')) as {
      active?: string
      profiles: Record<string, { env: Record<string, string> }>
    }
    expect(profiles.active).toBeUndefined()
    expect(profiles.profiles.ds?.env.OPENAI_API_KEY).toBe('sk-saved')

    const settings = getSettingsForSource('userSettings')
    expect(settings?.modelType).toBeUndefined()
    expect(settings?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(settings?.env?.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(settings?.env?.GEMINI_API_KEY).toBeUndefined()
    expect(settings?.env?.OPENAI_API_KEY).toBeUndefined()

    // Web search source overrides are a preference, not a credential.
    expect(settings?.webSearchSources).toEqual(searchOverrides)
  })
})

describe('logout leaves the account reconfigurable', () => {
  test('the onboarding wizard gets its login step back', async () => {
    secureStorageMock.setUpdateResult({ success: true })
    // Harness accommodation, not part of the scenario: under NODE_ENV=test (or
    // CI) getAnthropicApiKeyWithSource() throws outright when it can find no
    // credential env var at all, and isAnthropicAuthEnabled() calls it
    // unconditionally. This is the one credential-ish key that (a) survives
    // logout — it is not in LOGOUT_ENV_KEYS — and (b) feeds neither the
    // third-party check nor the external-key check below, so it cannot decide
    // the assertion either way. Its own FD is never read: that is
    // CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR, a different variable.
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = '3'
    process.env.OPENAI_BASE_URL = 'https://api.example.com/v1'
    process.env.OPENAI_API_KEY = 'sk-third-party'
    const { error } = updateSettingsForSource('userSettings', {
      modelType: 'openai',
      env: {
        OPENAI_BASE_URL: 'https://api.example.com/v1',
        OPENAI_API_KEY: 'sk-third-party',
      },
    } as any)
    expect(error).toBeNull()
    // A third-party session: Onboarding's `if (oauthEnabled)` is false, so the
    // wizard has no login step at all.
    expect(isAnthropicAuthEnabled()).toBe(false)

    await performLogout({ clearOnboarding: true })

    // …and after logout it must be back, or "logged out" means "locked out".
    expect(isAnthropicAuthEnabled()).toBe(true)
  })

  test('the DeepSeek Anthropic-wire mirror is released', async () => {
    secureStorageMock.setUpdateResult({ success: true })
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-deepseek'
    applyDeepSeekAnthropicWire()
    expect(isDeepSeekAnthropicWireActive()).toBe(true)
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-deepseek')
    expect(isDeepSeekMirroredApiKey('sk-deepseek')).toBe(true)

    await performLogout({ clearOnboarding: true })

    expect(isDeepSeekAnthropicWireActive()).toBe(false)
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    // The in-memory bookkeeping is released too — otherwise the mirror keeps
    // vouching for a key belonging to the session that just logged out.
    expect(isDeepSeekMirroredApiKey('sk-deepseek')).toBe(false)
  })

  test('a rejected custom API key stops being rejected forever', async () => {
    secureStorageMock.setUpdateResult({ success: true })
    saveGlobalConfig(current => ({
      ...current,
      customApiKeyResponses: { approved: ['aaaa'], rejected: ['bbbb'] },
    }))

    await performLogout({ clearOnboarding: true })

    const config = getGlobalConfig()
    expect(config.customApiKeyResponses?.approved).toEqual([])
    // Nothing else in the CLI can clear this list, and getCustomApiKeyStatus()
    // returning 'rejected' means the approval dialog never shows again.
    expect(config.customApiKeyResponses?.rejected).toEqual([])
  })

  test('both entry points reset onboarding', async () => {
    secureStorageMock.setUpdateResult({ success: true })

    // `/logout`. call() schedules a graceful shutdown 200ms out; stub the timer
    // so the suite is not torn down mid-run.
    saveGlobalConfig(current => ({ ...current, hasCompletedOnboarding: true }))
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout
    try {
      await call()
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(getGlobalConfig().hasCompletedOnboarding).toBe(false)

    // `occ auth logout` used to pass clearOnboarding: false, so the next launch
    // skipped the wizard — the only path back to a login.
    saveGlobalConfig(current => ({ ...current, hasCompletedOnboarding: true }))
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    )
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ): never => {
      throw new ExitError(code)
    }) as typeof process.exit)
    try {
      await expect(authLogout()).rejects.toMatchObject({ code: 0 })
    } finally {
      stdoutSpy.mockRestore()
      exitSpy.mockRestore()
    }
    expect(getGlobalConfig().hasCompletedOnboarding).toBe(false)
  })
})

describe('logout storage failure', () => {
  test('performLogout propagates a failed Anthropic OAuth update', async () => {
    await expect(performLogout({ clearOnboarding: false })).rejects.toThrow(
      'Failed to remove Anthropic OAuth credentials',
    )
    expect(secureStorageMock.deletes()).toBe(0)
    expect(secureStorageMock.snapshot()).toMatchObject({
      claudeAiOauth: { accessToken: 'token' },
      mcpOAuthTokens: { server: { refreshToken: 'keep-me' } },
    })
  })

  test('the UI command never returns its success message', async () => {
    await expect(call()).rejects.toThrow(
      'Failed to remove Anthropic OAuth credentials',
    )
  })

  test('the CLI exits with failure without writing success', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout.push(String(chunk))
        return true
      },
    )
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr.push(String(chunk))
        return true
      },
    )
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ): never => {
      throw new ExitError(code)
    }) as typeof process.exit)

    try {
      await expect(authLogout()).rejects.toMatchObject({ code: 1 })
      expect(stderr.join('')).toContain('Failed to log out.')
      expect(stdout.join('')).not.toContain('Successfully logged out')
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })
})
