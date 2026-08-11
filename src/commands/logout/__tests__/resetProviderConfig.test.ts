import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

mock.module('src/utils/telemetry/log.ts', logMock)

type SettingsUpdate = {
  modelType?: string
  modelSettings?: unknown
  effortLevel?: string
  env?: Record<string, string | undefined>
}

const updates: SettingsUpdate[] = []
const settingsMock = setupSettingsMock({
  updateSettingsForSource: (_source, settings) => {
    updates.push(settings as SettingsUpdate)
    return { error: null }
  },
})

afterAll(() => settingsMock.reset())

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_AUTH_MODE',
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'GROK_API_KEY',
  // OpenCode: OPENCODE_AUTH_MODE is the one key getAPIProvider() reads before
  // everything else, so a logout that leaves it behind puts the next launch
  // back on Zen — with no credential, because the OAuth file is gone.
  'OPENCODE_AUTH_MODE',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'OPENCODE_WIRE_API',
  'OPENCODE_API_KEY',
  'OPENCODE_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
] as const

const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string | undefined

beforeEach(() => {
  updates.length = 0
  tempDir = mkdtempSync(join(tmpdir(), 'occ-logout-'))
  process.env.OCC_CONFIG_DIR = tempDir
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('LOGOUT_ENV_KEYS', () => {
  test('covers every provider family plus the OAuth token', async () => {
    const { LOGOUT_ENV_KEYS } = await import('../resetProviderConfig.js')
    for (const key of ENV_KEYS) {
      expect(LOGOUT_ENV_KEYS).toContain(key)
    }
  })

  test('is deduped', async () => {
    const { LOGOUT_ENV_KEYS } = await import('../resetProviderConfig.js')
    expect(new Set(LOGOUT_ENV_KEYS).size).toBe(LOGOUT_ENV_KEYS.length)
  })
})

describe('resetProviderConfiguration', () => {
  test('clears every provider key from settings and unsets modelType', async () => {
    const { resetProviderConfiguration, LOGOUT_ENV_KEYS } = await import(
      '../resetProviderConfig.js'
    )

    resetProviderConfiguration()

    expect(updates.length).toBe(1)
    const update = updates[0]!
    expect(update.modelType).toBeUndefined()
    expect('modelType' in update).toBe(true)
    for (const key of LOGOUT_ENV_KEYS) {
      expect(key in (update.env ?? {})).toBe(true)
      expect(update.env?.[key]).toBeUndefined()
    }
  })

  test('clears the per-tier settings so the next login reseeds them', async () => {
    const { resetProviderConfiguration } = await import(
      '../resetProviderConfig.js'
    )

    resetProviderConfiguration()

    const update = updates[0]!
    // Present-and-undefined, which is how updateSettingsForSource spells
    // deletion. Merely absent would leave DeepSeek's 1M/max on the five slots
    // for the next provider's wizard to prefill and persist.
    expect('modelSettings' in update).toBe(true)
    expect(update.modelSettings).toBeUndefined()
    expect('effortLevel' in update).toBe(true)
    expect(update.effortLevel).toBeUndefined()
  })

  test('the live process stops seeing the credentials', async () => {
    const { resetProviderConfiguration } = await import(
      '../resetProviderConfig.js'
    )
    process.env.OPENAI_API_KEY = 'sk-live'
    process.env.OPENAI_BASE_URL = 'https://api.example.com/v1'
    process.env.OPENAI_WIRE_API = 'responses'
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    process.env.GEMINI_AUTH_MODE = 'antigravity'
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_API_KEY = 'zen-key'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    resetProviderConfiguration()

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_WIRE_API).toBeUndefined()
    expect(process.env.OPENAI_AUTH_MODE).toBeUndefined()
    expect(process.env.GEMINI_AUTH_MODE).toBeUndefined()
    expect(process.env.OPENCODE_AUTH_MODE).toBeUndefined()
    expect(process.env.OPENCODE_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('keeps saved profiles but drops the active pointer', async () => {
    const { resetProviderConfiguration } = await import(
      '../resetProviderConfig.js'
    )
    const { captureProfile, loadProfilesFile, saveProfilesFile } = await import(
      '../../../services/providerProfiles/profiles.js'
    )

    const profile = captureProfile({
      name: 'ds',
      modelType: 'openai',
      mergedEnv: {
        OPENAI_API_KEY: 'sk-x',
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      },
    })
    saveProfilesFile({ version: 1, active: 'ds', profiles: { ds: profile } })

    resetProviderConfiguration()

    const after = loadProfilesFile()
    expect(after.active).toBeUndefined()
    expect(after.profiles.ds?.env.OPENAI_API_KEY).toBe('sk-x')
  })

  test('is a no-op on the profiles file when nothing was active', async () => {
    const { resetProviderConfiguration } = await import(
      '../resetProviderConfig.js'
    )
    const { loadProfilesFile } = await import(
      '../../../services/providerProfiles/profiles.js'
    )

    resetProviderConfiguration()

    expect(loadProfilesFile()).toEqual({ version: 1, profiles: {} })
  })
})
