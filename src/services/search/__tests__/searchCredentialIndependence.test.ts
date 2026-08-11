/**
 * The property the pinned-credential store exists for: a web-search credential
 * that outlives the account plane.
 *
 * Both halves of that plane are exercised for real, not asserted about:
 *
 *   - `resetProviderConfiguration()` — the synchronous half of `/logout`, and
 *     the function that deletes LOGOUT_ENV_KEYS (derived from
 *     ALL_PROFILE_ENV_KEYS, i.e. every key a search source used to read).
 *   - `activateProfile()` — `/provider use`, which clears the union of EVERY
 *     family's env keys before applying the target profile's. Switching from a
 *     Gemini setup to an OpenCode one therefore took `GEMINI_API_KEY` with it.
 *
 * Each test asserts the provider credential really did go before checking that
 * the pinned one stayed. Without that first assertion the test would still pass
 * against a build where neither was ever removed.
 *
 * Injection and a temporary OCC_CONFIG_DIR rather than module mocks: the store
 * is a real file, and "it survived" is only meaningful about a real one.
 */

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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { occConfigDir } from 'src/config/paths.js'
import type { SettingsJson } from 'src/utils/settings/types.js'
import { activateProfile } from 'src/services/providerProfiles/activate.js'
import { saveProfilesFile } from 'src/services/providerProfiles/profiles.js'
import { resetProviderConfiguration } from 'src/commands/logout/resetProviderConfig.js'
import {
  listPinnedSearchSources,
  pinSearchCredential,
  readPinnedSearchCredential,
  reloadPinnedSearchCredentials,
} from '../searchCredentialStore.js'
import {
  resolveDeepSeekSearchEndpoint,
  resolvePinnedGeminiSearchCredential,
} from '../searchEndpoints.js'

mock.module('src/utils/telemetry/log.ts', logMock)

const settingsMock = setupSettingsMock()

let persistedSettings: SettingsJson = {}

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_WIRE_API',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_API_KEY',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
] as const

const savedEnv = new Map<string, string | undefined>()
const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? persistedSettings : null,
    getSettings_DEPRECATED: () => persistedSettings,
    updateSettingsForSource: (_source, settings) => {
      const patch = settings as unknown as {
        env?: Record<string, string | undefined>
      } & Record<string, unknown>
      const env = { ...(persistedSettings.env ?? {}) }
      for (const [key, value] of Object.entries(patch.env ?? {})) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      persistedSettings = { ...persistedSettings, ...patch, env }
      return { error: null }
    },
  })
})

afterAll(() => {
  settingsMock.reset()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-search-independence-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
  persistedSettings = {}
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  rmSync(tempDir, { recursive: true, force: true })
  reloadPinnedSearchCredentials()
})

describe('a pinned search credential survives /logout', () => {
  test('logout takes the provider key and leaves the pinned one', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-pinned-for-search' })
    persistedSettings = { env: { GEMINI_API_KEY: 'AIza-provider' } }
    process.env.GEMINI_API_KEY = 'AIza-provider'

    resetProviderConfiguration()

    // The account plane really was reset — otherwise the assertion below would
    // hold against a build that never removed anything.
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
    expect(persistedSettings.env?.GEMINI_API_KEY).toBeUndefined()

    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe(
      'AIza-pinned-for-search',
    )
    expect(listPinnedSearchSources()).toEqual(['gemini'])
  })

  test('the DeepSeek lane still resolves an endpoint after logout', async () => {
    await pinSearchCredential('deepseek', {
      apiKey: 'sk-pinned',
      baseURL: 'https://api.deepseek.com/anthropic',
    })
    persistedSettings = {
      env: {
        OPENAI_API_KEY: 'sk-provider',
        OPENAI_BASE_URL: 'https://api.deepseek.com',
      },
    }
    process.env.OPENAI_API_KEY = 'sk-provider'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'

    resetProviderConfiguration()

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()

    // Before the store, this is precisely where web search went dark: with the
    // env derivation gone the source dropped out and the tool degraded to the
    // keyless scraping lane, silently.
    expect(resolveDeepSeekSearchEndpoint()).toEqual({
      baseURL: 'https://api.deepseek.com/anthropic',
      messagesURL: 'https://api.deepseek.com/anthropic/v1/messages',
      apiKey: 'sk-pinned',
    })
  })
})

describe('a pinned search credential survives a provider switch', () => {
  function seedOpencodeProfile(): void {
    saveProfilesFile({
      version: 1,
      profiles: {
        'oc-work': {
          name: 'oc-work',
          modelType: 'opencode',
          env: { OPENCODE_API_KEY: 'oc-key' },
          createdAt: '2026-08-11T00:00:00.000Z',
          updatedAt: '2026-08-11T00:00:00.000Z',
        },
      },
    })
  }

  test('activateProfile clears the provider key and leaves the pin', async () => {
    seedOpencodeProfile()
    await pinSearchCredential('gemini', { apiKey: 'AIza-pinned-for-search' })
    persistedSettings = {
      modelType: 'gemini',
      env: { GEMINI_API_KEY: 'AIza-provider' },
    }
    process.env.GEMINI_API_KEY = 'AIza-provider'

    expect(activateProfile('oc-work')).toMatchObject({
      profile: { name: 'oc-work' },
    })

    // activateProfile clears the union of every family's keys before applying
    // the target's — that is the mechanism that used to take web search with it.
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
    expect(persistedSettings.env?.GEMINI_API_KEY).toBeUndefined()
    expect(persistedSettings.env?.OPENCODE_API_KEY).toBe('oc-key')

    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe(
      'AIza-pinned-for-search',
    )
  })

  test('a pinned DeepSeek endpoint outlives the OpenAI keys it was captured from', async () => {
    seedOpencodeProfile()
    await pinSearchCredential('deepseek', {
      apiKey: 'sk-pinned',
      baseURL: 'https://api.deepseek.com/anthropic',
    })
    persistedSettings = {
      modelType: 'openai',
      env: {
        OPENAI_API_KEY: 'sk-provider',
        OPENAI_BASE_URL: 'https://api.deepseek.com',
      },
    }
    process.env.OPENAI_API_KEY = 'sk-provider'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'

    expect(activateProfile('oc-work')).toMatchObject({
      profile: { name: 'oc-work' },
    })

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(resolveDeepSeekSearchEndpoint()?.apiKey).toBe('sk-pinned')
  })
})

describe('nothing pinned: the provider env is still the credential', () => {
  test('the DeepSeek endpoint is derived from OPENAI_* exactly as before', () => {
    process.env.OPENAI_API_KEY = 'sk-provider'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'

    expect(listPinnedSearchSources()).toEqual([])
    expect(resolveDeepSeekSearchEndpoint()).toEqual({
      baseURL: 'https://api.deepseek.com/anthropic',
      messagesURL: 'https://api.deepseek.com/anthropic/v1/messages',
      apiKey: 'sk-provider',
    })
  })

  test('the Gemini lane is left entirely alone, so the client reads env', () => {
    process.env.GEMINI_API_KEY = 'AIza-provider'

    // `undefined` means "no pin", which is what tells the adapter to leave
    // streamGeminiGenerateContent on its existing GEMINI_API_KEY / Antigravity
    // route. An existing setup therefore needs no migration.
    expect(resolvePinnedGeminiSearchCredential()).toBeUndefined()
  })

  test('an unpinned source still goes dark on logout — the bug this fixes', () => {
    persistedSettings = {
      env: {
        OPENAI_API_KEY: 'sk-provider',
        OPENAI_BASE_URL: 'https://api.deepseek.com',
      },
    }
    process.env.OPENAI_API_KEY = 'sk-provider'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    expect(resolveDeepSeekSearchEndpoint()).toBeDefined()

    resetProviderConfiguration()

    expect(resolveDeepSeekSearchEndpoint()).toBeUndefined()
  })

  test('the opt-out still outranks a pin', async () => {
    // CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0 names this endpoint specifically.
    // A pin says which credential to use, never "ignore a capability the user
    // switched off" — the same asymmetry the source overrides have.
    await pinSearchCredential('deepseek', { apiKey: 'sk-pinned' })
    process.env.CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE = '0'

    expect(resolveDeepSeekSearchEndpoint()).toBeUndefined()
  })
})
