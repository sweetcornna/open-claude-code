import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
let tempDir: string

class ExitError extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`process.exit(${code})`)
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-logout-failure-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  })
  secureStorageMock.reset()
  secureStorageMock.seed({
    claudeAiOauth: { accessToken: 'token' },
    mcpOAuthTokens: { server: { refreshToken: 'keep-me' } },
  })
  secureStorageMock.setUpdateResult({ success: false })
})

afterEach(() => {
  secureStorageMock.reset()
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
  test('preserves unrelated credentials, provider settings, and search overrides', async () => {
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
    writeFileSync(profilesPath, 'profiles-sentinel')
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
        GEMINI_API_KEY: 'keep-gemini',
        OPENAI_API_KEY: 'keep-openai',
      },
    } as any)
    expect(error).toBeNull()

    await performLogout({ clearOnboarding: false })

    expect(secureStorageMock.snapshot()).toEqual({
      mcpOAuthTokens: { server: { refreshToken: 'mcp-refresh' } },
      pluginSecrets: { plugin: { token: 'plugin-token' } },
    })
    expect(secureStorageMock.deletes()).toBe(0)
    expect(readFileSync(chatgptPath, 'utf8')).toBe('chatgpt-sentinel')
    expect(readFileSync(geminiPath, 'utf8')).toBe('gemini-sentinel')
    expect(readFileSync(profilesPath, 'utf8')).toBe('profiles-sentinel')
    const settings = getSettingsForSource('userSettings')
    expect(settings?.modelType).toBe('gemini')
    expect(settings?.webSearchSources).toEqual(searchOverrides)
    expect(settings?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(settings?.env?.ANTHROPIC_BASE_URL).toBe(
      'https://anthropic-gateway.example',
    )
    expect(settings?.env?.GEMINI_API_KEY).toBe('keep-gemini')
    expect(settings?.env?.OPENAI_API_KEY).toBe('keep-openai')
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
