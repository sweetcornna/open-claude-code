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

describe('activateProfileForModel', () => {
  /** Two aggregating profiles that share one model id and own one each. */
  function seedAggregatedRegistry(): void {
    profiles.saveProfilesFile({
      version: 1,
      profiles: {
        'gemini-work': {
          name: 'gemini-work',
          modelType: 'gemini',
          env: { GEMINI_API_KEY: targetApiKey },
          models: [{ id: 'shared-model' }, { id: 'gemini-only' }],
          aggregate: true,
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        },
        relay: {
          name: 'relay',
          modelType: 'openai',
          env: { OPENAI_API_KEY: 'sk-relay' },
          models: [{ id: 'shared-model' }],
          aggregate: true,
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        },
      },
    })
  }

  test('a unique model id switches the session to its owning profile', () => {
    seedAggregatedRegistry()

    const result = activate.activateProfileForModel('gemini-only')

    expect(result).toMatchObject({
      profile: { name: 'gemini-work' },
      model: { id: 'gemini-only', profile: 'gemini-work', ambiguous: false },
    })
    expect(lastUpdate?.modelType).toBe('gemini')
    expect(persistedSettings.env?.GEMINI_API_KEY).toBe(targetApiKey)
    expect(profiles.loadProfilesFile().active).toBe('gemini-work')
  })

  test('a qualified selector picks the named profile', () => {
    seedAggregatedRegistry()

    const result = activate.activateProfileForModel('shared-model@relay')

    expect(result).toMatchObject({
      profile: { name: 'relay' },
      model: { id: 'shared-model', profile: 'relay', ambiguous: true },
    })
    expect(lastUpdate?.modelType).toBe('openai')
    expect(persistedSettings.env?.OPENAI_API_KEY).toBe('sk-relay')
  })

  test('an unresolvable selector activates nothing', () => {
    seedAggregatedRegistry()

    // Ambiguous without a qualifier, and simply unknown: both must leave the
    // session exactly as it was rather than half-switching.
    expect(activate.activateProfileForModel('shared-model')).toHaveProperty(
      'error',
    )
    expect(activate.activateProfileForModel('no-such-model')).toHaveProperty(
      'error',
    )
    expect(lastUpdate).toBeUndefined()
    expect(profiles.loadProfilesFile().active).toBeUndefined()
  })
})

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

describe('saving an OpenCode session', () => {
  const OPENCODE_ENV = [
    'OPENCODE_AUTH_MODE',
    'OPENCODE_BASE_URL',
    'OPENCODE_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
  ] as const

  afterEach(() => {
    for (const key of OPENCODE_ENV) delete process.env[key]
  })

  /**
   * The session is on Zen's /messages lane, so getAPIProvider() reports
   * 'firstParty' and the ANTHROPIC_* keys hold what the wire mirror wrote —
   * including an access token that expires within the hour.
   */
  function configureZenMessagesSession(): void {
    persistedSettings = { env: {} }
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/v1'
    process.env.ANTHROPIC_AUTH_TOKEN = 'mirrored-access-token'
  }

  test('captures the OPENCODE_ keys, not the lane it happens to speak', () => {
    configureZenMessagesSession()

    const saved = activate.saveCurrentAsProfile({ name: 'zen' })
    expect('error' in saved).toBe(false)
    if ('error' in saved) return

    expect(saved.profile.modelType).toBe('opencode')
    expect(saved.profile.env.OPENCODE_MODEL).toBe('claude-opus-5')
    expect(saved.profile.env.OPENCODE_BASE_URL).toBe(
      'https://opencode.ai/zen/v1',
    )
  })

  test('never persists the mirrored access token', () => {
    configureZenMessagesSession()

    const saved = activate.saveCurrentAsProfile({ name: 'zen-token' })
    expect('error' in saved).toBe(false)
    if ('error' in saved) return

    // The whole reason OpenCode is its own profile family. Captured under the
    // lane's family instead, this key held a credential with about an hour to
    // live — written into provider-profiles.json, where it would be both stale
    // and a secret on disk.
    expect(saved.profile.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(Object.values(saved.profile.env)).not.toContain(
      'mirrored-access-token',
    )
  })
})
