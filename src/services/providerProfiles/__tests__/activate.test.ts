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
import type { ProfileModelSettings } from '../profiles.js'

const settingsMock = setupSettingsMock()

let activate: typeof import('../activate.js')
let paths: typeof import('../../../config/paths.js')
let profiles: typeof import('../profiles.js')
let persistedSettings: SettingsJson = {}
type SettingsUpdatePatch = {
  modelType: SettingsJson['modelType']
  env: Record<string, string | undefined>
  modelSettings?: Record<
    string,
    { effort?: string; contextTokens?: number } | undefined
  >
  effortLevel?: SettingsJson['effortLevel']
}
let lastUpdate: SettingsUpdatePatch | undefined
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
      const patch = settings as unknown as SettingsUpdatePatch
      lastUpdate = patch

      // Mutate the old env object in place, as a settings merge may do. The
      // activation code must therefore have taken a value snapshot beforehand.
      const managedEnv = persistedSettings.env ?? {}
      for (const [key, value] of Object.entries(patch.env)) {
        if (value === undefined) delete managedEnv[key]
        else managedEnv[key] = value
      }
      // The real updateSettingsForSource deep-merges and treats `undefined` as
      // deletion at every level (lodash mergeWith + the customizer in
      // settings.ts). Reproduced here because that is exactly what makes a
      // whole-shape patch necessary: a shallow replace would hide the bug this
      // suite is about.
      const modelSettings: NonNullable<SettingsJson['modelSettings']> = {
        ...persistedSettings.modelSettings,
      }
      for (const [slot, value] of Object.entries(patch.modelSettings ?? {})) {
        const key = slot as keyof typeof modelSettings
        if (value === undefined) {
          delete modelSettings[key]
          continue
        }
        const merged = { ...modelSettings[key] }
        for (const [axis, axisValue] of Object.entries(value)) {
          const axisKey = axis as keyof typeof merged
          if (axisValue === undefined) delete merged[axisKey]
          else Object.assign(merged, { [axisKey]: axisValue })
        }
        modelSettings[key] = merged
      }
      persistedSettings = {
        ...persistedSettings,
        modelType: patch.modelType,
        env: managedEnv,
        modelSettings,
      }
      if ('effortLevel' in patch && patch.effortLevel === undefined) {
        delete persistedSettings.effortLevel
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

  test('reclaims an orphaned session-kind marker the comparison would keep', () => {
    // The marker is live but settings.env never held it, so the value-match
    // rule that protects shell exports would leave it in place. For an ordinary
    // key that is right; for this one it is how a session kept talking to
    // OpenCode after switching away — applyOpencodeWire() reads it on every
    // client build and repoints OPENAI_BASE_URL, so the endpoint went on being
    // rewritten while settings.json described the profile just activated. Only
    // /logout cleared it, because that is the one path deleting these outright.
    persistedSettings = {
      modelType: 'openai',
      env: { OPENAI_API_KEY: 'openai-managed' },
    }
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_INFERENCE_PLANE = 'console'
    process.env.OPENAI_AUTH_MODE = 'chatgpt'

    activateAndExpectPersisted('OPENAI_API_KEY')

    expect(process.env.OPENCODE_AUTH_MODE).toBeUndefined()
    expect(process.env.OPENCODE_INFERENCE_PLANE).toBeUndefined()
    expect(process.env.OPENAI_AUTH_MODE).toBeUndefined()
  })

  test('an orphaned endpoint is still preserved — only the markers are special', () => {
    // The narrowness is the point: OPENCODE_BASE_URL is just as orphaned here,
    // and it stays, because a user could plausibly have exported it and it is
    // read as configuration rather than as a mode switch.
    persistedSettings = {
      modelType: 'openai',
      env: { OPENAI_API_KEY: 'openai-managed' },
    }
    process.env.OPENCODE_BASE_URL = 'https://opencode.example/zen/v1'

    activateAndExpectPersisted('OPENAI_API_KEY')

    expect(process.env.OPENCODE_BASE_URL).toBe(
      'https://opencode.example/zen/v1',
    )
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

describe('saving a DeepSeek Anthropic-wire session', () => {
  test('captures its persisted OpenAI ownership, not mirrored Anthropic keys', () => {
    persistedSettings = {
      modelType: 'openai',
      env: {
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_API_KEY: 'sk-deepseek',
        OPENAI_MODEL: 'deepseek-chat',
      },
    }
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
    process.env.OPENAI_API_KEY = 'sk-deepseek'
    process.env.OPENAI_MODEL = 'deepseek-chat'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_API_KEY = 'mirrored-deepseek-key'

    const saved = activate.saveCurrentAsProfile({ name: 'deepseek' })
    expect('error' in saved).toBe(false)
    if ('error' in saved) return

    expect(saved.profile.modelType).toBe('openai')
    expect(saved.profile.env).toMatchObject({
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_API_KEY: 'sk-deepseek',
      OPENAI_MODEL: 'deepseek-chat',
    })
    expect(saved.profile.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(saved.profile.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(Object.values(saved.profile.env)).not.toContain(
      'mirrored-deepseek-key',
    )
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

/**
 * Per-tier effort and context window are provider-shaped: tierPersistence.ts
 * seeds them from the model family behind each tier, so DeepSeek's row is
 * `max`/1M and GPT's is `xhigh`/272k. Before profiles carried them, switching
 * restored the endpoint and the key and left the PREVIOUS provider's row in
 * force — the same defect `/logout` was fixed for in 2.38.0.
 */
describe('activateProfile restores per-tier model settings', () => {
  /** A session tuned for DeepSeek: its row, plus the legacy flat effort. */
  function runningOnDeepSeek(): void {
    persistedSettings = {
      modelType: 'openai',
      env: { OPENAI_BASE_URL: 'https://api.deepseek.com/v1' },
      effortLevel: 'high',
      modelSettings: {
        default: { effort: 'max', contextTokens: 1_000_000 },
        opus: { effort: 'max', contextTokens: 1_000_000 },
        sonnet: { effort: 'max', contextTokens: 1_000_000 },
        haiku: { effort: 'max', contextTokens: 1_000_000 },
        fable: { effort: 'max', contextTokens: 1_000_000 },
      },
    }
  }

  /** Omit `modelSettings` to get the 2.38.3-era shape. */
  function seedGptProfile(modelSettings?: ProfileModelSettings): void {
    profiles.saveProfilesFile({
      version: 1,
      profiles: {
        gpt: {
          name: 'gpt',
          modelType: 'openai',
          env: {
            OPENAI_BASE_URL: 'https://api.openai.com/v1',
            OPENAI_API_KEY: 'sk-gpt',
          },
          ...(modelSettings ? { modelSettings } : {}),
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
      },
    })
  }

  test('the target profile’s row replaces the previous provider’s', () => {
    runningOnDeepSeek()
    seedGptProfile({
      default: { effort: 'xhigh', contextTokens: 272_000 },
      opus: { effort: 'xhigh', contextTokens: 272_000 },
      haiku: { effort: 'low', contextTokens: 272_000 },
    })

    expect(activate.activateProfile('gpt')).toMatchObject({
      profile: { name: 'gpt' },
    })

    expect(persistedSettings.modelSettings).toEqual({
      default: { effort: 'xhigh', contextTokens: 272_000 },
      opus: { effort: 'xhigh', contextTokens: 272_000 },
      haiku: { effort: 'low', contextTokens: 272_000 },
    })
    // Slots this profile never configured are GONE, not inherited: sonnet and
    // fable were on DeepSeek's 1M/max row a moment ago.
    expect(persistedSettings.modelSettings?.sonnet).toBeUndefined()
    expect(persistedSettings.modelSettings?.fable).toBeUndefined()
  })

  test('an axis the profile did not configure does not survive the switch', () => {
    runningOnDeepSeek()
    seedGptProfile({ opus: { effort: 'xhigh' } })

    activate.activateProfile('gpt')

    // The whole-shape point: a deep merge that only named `effort` would leave
    // DeepSeek's 1M window sitting under GPT's effort.
    expect(persistedSettings.modelSettings?.opus).toEqual({ effort: 'xhigh' })
  })

  test('a profile saved before this field clears the slots instead of inheriting', () => {
    runningOnDeepSeek()
    seedGptProfile()

    activate.activateProfile('gpt')

    // Decided, not incidental. Leaving them is the bug; clearing them puts
    // every tier back on getTierDefaults for the models this profile just
    // restored, and makes the outcome depend only on the profile rather than
    // on when it happened to be saved.
    expect(persistedSettings.modelSettings).toEqual({})
  })

  test('the legacy flat effortLevel is dropped rather than carried', () => {
    runningOnDeepSeek()
    seedGptProfile({ opus: { effort: 'low' } })

    activate.activateProfile('gpt')

    // It seeds AppState and AppState outranks the per-tier layer, so a value
    // left here would shadow the row that was just restored — the restore
    // would look like it did nothing.
    expect('effortLevel' in lastUpdate!).toBe(true)
    expect(lastUpdate?.effortLevel).toBeUndefined()
    expect(persistedSettings.effortLevel).toBeUndefined()
  })

  test('the env overrides keep their place above the restored layer', () => {
    runningOnDeepSeek()
    seedGptProfile({ opus: { effort: 'low', contextTokens: 272_000 } })

    activate.activateProfile('gpt')

    // CLAUDE_CODE_MAX_CONTEXT_TOKENS still travels with settings.env — it is a
    // managed key for every family — so it is cleared here rather than being
    // promoted or demoted. CLAUDE_CODE_EFFORT_LEVEL is not managed at all:
    // nothing in occ writes it, so a value in the environment is the user's own
    // and activation must not touch it.
    expect('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in (lastUpdate?.env ?? {})).toBe(
      true,
    )
    expect(lastUpdate?.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined()
    expect('CLAUDE_CODE_EFFORT_LEVEL' in (lastUpdate?.env ?? {})).toBe(false)
  })

  test('saving snapshots the live per-tier settings', () => {
    persistedSettings = {
      env: {},
      modelSettings: { opus: { effort: 'xhigh', contextTokens: 272_000 } },
    }

    const saved = activate.saveCurrentAsProfile({ name: 'snap' })
    expect('error' in saved).toBe(false)
    if ('error' in saved) return

    expect(saved.profile.modelSettings).toEqual({
      opus: { effort: 'xhigh', contextTokens: 272_000 },
    })
  })

  test('an add-flow capture can mark the saved profile active atomically', () => {
    profiles.saveProfilesFile({
      version: 1,
      active: 'old',
      profiles: profiles.loadProfilesFile().profiles,
    })

    const saved = activate.saveCurrentAsProfile({
      name: 'new',
      aggregate: true,
      setActive: true,
    })

    expect('error' in saved).toBe(false)
    expect(profiles.loadProfilesFile()).toMatchObject({
      active: 'new',
      profiles: { new: { aggregate: true } },
    })
  })
})
