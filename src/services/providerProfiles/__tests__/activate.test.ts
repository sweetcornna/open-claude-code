import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from 'src/utils/settings/types.js'

const settingsMock = setupSettingsMock()

let activate: typeof import('../activate.js')
let paths: typeof import('../../../config/paths.js')
let profiles: typeof import('../profiles.js')
let persistedSettings: SettingsJson = {}
let lastUpdate:
  | {
      modelType: SettingsJson['modelType']
      env: Record<string, string | undefined>
    }
  | undefined
let tempDir: string

const previousConfigDir = process.env.OCC_CONFIG_DIR
const savedEnv = new Map<string, string | undefined>()
const targetApiKey = 'gemini-managed'

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-profile-activate-'))
  process.env.OCC_CONFIG_DIR = tempDir
  paths = await import('../../../config/paths.js')
  paths.occConfigDir.cache.clear?.()

  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? persistedSettings : null,
    getSettings_DEPRECATED: () => persistedSettings,
    updateSettingsForSource: (_source, settings) => {
      const patch = settings as unknown as {
        modelType: SettingsJson['modelType']
        env: Record<string, string | undefined>
      }
      lastUpdate = patch

      // Mutate the old env object in place, as a settings merge may do. The
      // activation code must therefore have taken a value snapshot beforehand.
      const managedEnv = persistedSettings.env ?? {}
      for (const [key, value] of Object.entries(patch.env)) {
        if (value === undefined) delete managedEnv[key]
        else managedEnv[key] = value
      }
      persistedSettings = {
        ...persistedSettings,
        modelType: patch.modelType,
        env: managedEnv,
      }
      return { error: null }
    },
  })

  profiles = await import('../profiles.js')
  activate = await import('../activate.js')
  for (const key of profiles.ALL_PROFILE_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterAll(() => {
  settingsMock.reset()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (previousConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = previousConfigDir
  paths.occConfigDir.cache.clear?.()
  rmSync(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  persistedSettings = {}
  lastUpdate = undefined
  for (const key of profiles.ALL_PROFILE_ENV_KEYS) delete process.env[key]
  profiles.saveProfilesFile({
    version: 1,
    profiles: {
      'gemini-work': {
        name: 'gemini-work',
        modelType: 'gemini',
        env: { GEMINI_API_KEY: targetApiKey },
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    },
  })
})

afterEach(() => {
  for (const key of profiles.ALL_PROFILE_ENV_KEYS) delete process.env[key]
})

function activateAndExpectPersisted(clearedKey: string): void {
  expect(activate.activateProfile('gemini-work')).toMatchObject({
    profile: { name: 'gemini-work' },
  })

  expect(lastUpdate?.modelType).toBe('gemini')
  expect(Object.keys(lastUpdate?.env ?? {})).toHaveLength(
    profiles.ALL_PROFILE_ENV_KEYS.length,
  )
  for (const key of profiles.ALL_PROFILE_ENV_KEYS) {
    expect(key in (lastUpdate?.env ?? {})).toBe(true)
  }
  expect(clearedKey in (persistedSettings.env ?? {})).toBe(false)
  expect(persistedSettings.env?.GEMINI_API_KEY).toBe(targetApiKey)
}

describe('activateProfile live environment ownership', () => {
  test('preserves a parent-shell value that old settings did not manage', () => {
    persistedSettings = {
      modelType: 'openai',
      env: { OPENAI_API_KEY: 'openai-managed' },
    }
    process.env.ANTHROPIC_API_KEY = 'anthropic-from-shell'

    activateAndExpectPersisted('OPENAI_API_KEY')

    expect(process.env.ANTHROPIC_API_KEY).toBe('anthropic-from-shell')
  })

  test('preserves a managed key that the user manually overrode later', () => {
    persistedSettings = {
      modelType: 'anthropic',
      env: { ANTHROPIC_BASE_URL: 'https://settings.example' },
    }
    process.env.ANTHROPIC_BASE_URL = 'https://manual.example'

    activateAndExpectPersisted('ANTHROPIC_BASE_URL')

    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://manual.example')
  })

  test('deletes an old managed value that is still live', () => {
    persistedSettings = {
      modelType: 'openai',
      env: { OPENAI_API_KEY: 'openai-managed' },
    }
    process.env.OPENAI_API_KEY = 'openai-managed'

    activateAndExpectPersisted('OPENAI_API_KEY')

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('writes target profile values unconditionally', () => {
    persistedSettings = {
      modelType: 'grok',
      env: {
        GROK_API_KEY: 'grok-managed',
        GEMINI_API_KEY: 'gemini-old',
      },
    }
    process.env.GEMINI_API_KEY = 'gemini-manual-override'

    activateAndExpectPersisted('GROK_API_KEY')

    expect(process.env.GEMINI_API_KEY).toBe(targetApiKey)
  })
})
