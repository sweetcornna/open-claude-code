/**
 * Pinning a web-search credential without being asked.
 *
 * No module mocks at all, for the same reason searchCredentialStore.test.ts has
 * none: the two things worth asserting are that a real file gets written and
 * that a real file does NOT get written, and neither survives being faked. The
 * settings half is real too — `webSearchAutoPin` is stored through
 * `updateSettingsForSource`'s deep merge, where "undefined means delete" lives,
 * so a hand-rolled stand-in would be testing the stand-in.
 *
 * Everything is scoped to a temporary OCC_CONFIG_DIR, which is what puts both
 * files (settings.json and search-credentials.json) inside the same disposable
 * root.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { applyDeepSeekAnthropicWire } from 'src/utils/model/deepseekWire.js'
import {
  applyOpencodeWire,
  setOpencodeRuntimeCredential,
} from 'src/utils/model/opencodeWire.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import {
  autoPinSearchCredentials,
  isSearchAutoPinEnabled,
  readSearchAutoPinOverrides,
  type SearchAutoPinAction,
  type SearchAutoPinResult,
  setSearchAutoPinEnabled,
} from '../autoPin.js'
import {
  listPinnedSearchSources,
  pinSearchCredential,
  readPinnedSearchCredential,
  reloadPinnedSearchCredentials,
  searchCredentialsFilePath,
} from '../searchCredentialStore.js'

/**
 * Installed all-real, and used by exactly one test — the one that has to make
 * `getSettingsForSource` throw, which nothing outside the module can otherwise
 * provoke (it swallows malformed files, missing files and validation failures
 * alike, which is the whole reason the contract needs guarding structurally).
 * Every other test in this file goes through the delegating surface to the real
 * settings implementation and its real files.
 */
const settingsMock = setupSettingsMock()

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_WIRE_API',
  'OPENCODE_API_KEY',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
] as const

const savedEnv = new Map<string, string | undefined>()
const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

/** Forget every cached view of the two files under the temporary root. */
function useTempRoot(dir: string): void {
  process.env.OCC_CONFIG_DIR = dir
  occConfigDir.cache.clear?.()
  resetSettingsCache()
  reloadPinnedSearchCredentials()
}

/** Release the mirrors' claims, so one test's wire is not the next test's env. */
function resetWires(): void {
  setOpencodeRuntimeCredential(undefined)
  applyDeepSeekAnthropicWire()
  applyOpencodeWire()
}

function writeUserSettings(settings: Record<string, unknown>): void {
  mkdirSync(occConfigDir(), { recursive: true })
  writeFileSync(
    occConfigPath('settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  )
  resetSettingsCache()
}

function readUserSettings(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(occConfigPath('settings.json'), 'utf8'),
  ) as Record<string, unknown>
}

function actionFor(
  results: SearchAutoPinResult[],
  family: SearchCredentialFamily,
): SearchAutoPinAction | undefined {
  return results.find(result => result.family === family)?.action
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  tempDir = mkdtempSync(join(tmpdir(), 'occ-search-autopin-'))
  useTempRoot(tempDir)
  resetWires()
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  resetWires()
  for (const [key, value] of savedEnv) {
    if (value !== undefined) process.env[key] = value
  }
  rmSync(tempDir, { recursive: true, force: true })
  reloadPinnedSearchCredentials()
})

afterAll(() => {
  settingsMock.reset()
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  resetSettingsCache()
  reloadPinnedSearchCredentials()
})

describe('the first run over a configured environment', () => {
  test('pins the credential the lane is already authenticating with', async () => {
    process.env.GEMINI_API_KEY = 'AIza-live'
    process.env.GEMINI_BASE_URL = 'https://gemini.example/v1beta'

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('pinned')
    expect(readPinnedSearchCredential('gemini')).toMatchObject({
      apiKey: 'AIza-live',
      baseURL: 'https://gemini.example/v1beta',
    })
  })

  test('leaves every source the environment says nothing about alone', async () => {
    process.env.GEMINI_API_KEY = 'AIza-live'

    const results = await autoPinSearchCredentials()

    // Three refusals and one pin is the shape of a normal session: users
    // configure one provider. The refusals are an outcome, not a failure.
    expect(actionFor(results, 'anthropic')).toBe('nothing-to-capture')
    expect(actionFor(results, 'codex')).toBe('nothing-to-capture')
    expect(actionFor(results, 'deepseek')).toBe('nothing-to-capture')
    expect(listPinnedSearchSources()).toEqual(['gemini'])
  })

  test('an environment with nothing pinnable writes no file and does not throw', async () => {
    const results = await autoPinSearchCredentials()

    expect(results.map(result => result.action)).toEqual([
      'nothing-to-capture',
      'nothing-to-capture',
      'nothing-to-capture',
      'nothing-to-capture',
    ])
    expect(() => readFileSync(searchCredentialsFilePath())).toThrow()
  })

  test('the capture rules still apply — a DeepSeek key is not pinned as Anthropic', async () => {
    // The wire mirrors the DeepSeek key onto ANTHROPIC_API_KEY. Running
    // unattended is exactly when nobody is watching for this, so the automatic
    // path has to inherit the refusal rather than re-derive a looser rule.
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-deepseek'
    applyDeepSeekAnthropicWire()
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-deepseek')

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'anthropic')).toBe('nothing-to-capture')
    expect(readPinnedSearchCredential('anthropic')).toBeUndefined()
    // The same credential under its own name is fine, and that row is the one
    // whose lane will send it.
    expect(actionFor(results, 'deepseek')).toBe('pinned')
    expect(readPinnedSearchCredential('deepseek')).toMatchObject({
      apiKey: 'sk-deepseek',
      baseURL: 'https://api.deepseek.com/anthropic',
    })
  })
})

describe('a pin that has fallen behind the environment', () => {
  test('follows a rotated key', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-old' })
    process.env.GEMINI_API_KEY = 'AIza-rotated'

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('refreshed')
    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe('AIza-rotated')
  })

  test('follows a moved endpoint even when the key is unchanged', async () => {
    await pinSearchCredential('gemini', {
      apiKey: 'AIza-live',
      baseURL: 'https://old.example/v1beta',
    })
    process.env.GEMINI_API_KEY = 'AIza-live'
    process.env.GEMINI_BASE_URL = 'https://new.example/v1beta'

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('refreshed')
    expect(readPinnedSearchCredential('gemini')?.baseURL).toBe(
      'https://new.example/v1beta',
    )
  })

  test('a pin outlives an environment that no longer holds anything', async () => {
    // The whole point of the store: nothing in the automatic path may treat
    // "the env went away" as a reason to drop what was captured while it was
    // there — that is the /logout case this feature exists for.
    await pinSearchCredential('gemini', { apiKey: 'AIza-live' })

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('nothing-to-capture')
    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe('AIza-live')
  })
})

describe('a pin that already agrees with the environment', () => {
  test('is left byte-identical, pinnedAt included', async () => {
    // This runs on every startup. Re-pinning an identical credential would
    // rewrite the file each time and move `pinnedAt`, so the one timestamp the
    // panel can show would stop meaning "when this was captured".
    mkdirSync(occConfigDir(), { recursive: true })
    writeFileSync(
      searchCredentialsFilePath(),
      `${JSON.stringify(
        {
          version: 1,
          sources: {
            gemini: {
              apiKey: 'AIza-live',
              baseURL: 'https://gemini.example/v1beta',
              pinnedAt: '1999-01-01T00:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    reloadPinnedSearchCredentials()
    const before = readFileSync(searchCredentialsFilePath(), 'utf8')

    process.env.GEMINI_API_KEY = 'AIza-live'
    process.env.GEMINI_BASE_URL = 'https://gemini.example/v1beta'
    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('unchanged')
    expect(readPinnedSearchCredential('gemini')?.pinnedAt).toBe(
      '1999-01-01T00:00:00.000Z',
    )
    expect(readFileSync(searchCredentialsFilePath(), 'utf8')).toBe(before)
  })

  test('a bare key and a bare pin count as the same credential', async () => {
    // `baseURL` absent on both sides means "the default", so treating one as a
    // change would make every startup a rewrite for anyone on a default
    // endpoint — the most common configuration there is.
    await pinSearchCredential('gemini', { apiKey: 'AIza-live' })
    const pinnedAt = readPinnedSearchCredential('gemini')?.pinnedAt
    process.env.GEMINI_API_KEY = 'AIza-live'

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('unchanged')
    expect(readPinnedSearchCredential('gemini')?.pinnedAt).toBe(pinnedAt)
  })
})

describe('the opt-out', () => {
  test('a source switched off is skipped, pin or no pin', async () => {
    writeUserSettings({ webSearchAutoPin: { gemini: false } })
    process.env.GEMINI_API_KEY = 'AIza-live'

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('opted-out')
    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })

  test('switching one source off leaves the others pinning', async () => {
    writeUserSettings({ webSearchAutoPin: { gemini: false } })
    process.env.GEMINI_API_KEY = 'AIza-live'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-live'

    const results = await autoPinSearchCredentials()

    expect(actionFor(results, 'gemini')).toBe('opted-out')
    expect(actionFor(results, 'anthropic')).toBe('pinned')
    expect(listPinnedSearchSources()).toEqual(['anthropic'])
  })

  test('absent means on — a settings file with no block pins normally', async () => {
    writeUserSettings({ theme: 'dark' })
    process.env.GEMINI_API_KEY = 'AIza-live'

    expect(isSearchAutoPinEnabled('gemini')).toBe(true)
    expect(actionFor(await autoPinSearchCredentials(), 'gemini')).toBe('pinned')
  })

  test('a malformed block reads as "no explicit choices", never as off', async () => {
    // Same contract as webSearchSources: settings damage degrades to the
    // default, and the default here is to pin.
    writeUserSettings({ webSearchAutoPin: 'nonsense' })
    process.env.GEMINI_API_KEY = 'AIza-live'

    expect(actionFor(await autoPinSearchCredentials(), 'gemini')).toBe('pinned')
  })
})

describe('the never-rejects contract', () => {
  test('a throwing settings read resolves instead of rejecting', async () => {
    // The three call sites are `void autoPinSearchCredentials()` on the startup
    // path, the same in the wizard's save, and a bare `.then()` in the panel —
    // not one of them has a `.catch`, by design: the guarantee belongs to this
    // module. `readSearchAutoPinOverrides()` runs in the async prologue, before
    // any await, so a throw there rejects the returned promise and lands as an
    // unhandled rejection during startup unless the try covers it.
    process.env.GEMINI_API_KEY = 'AIza-live'
    settingsMock.set({
      getSettingsForSource: () => {
        throw new Error('settings exploded')
      },
    })

    try {
      const results = await autoPinSearchCredentials()

      // Resolved, and every source still has an answer — an empty array would
      // make `find(...)?.action` undefined, which the union does not describe.
      expect(results.map(result => result.family).sort()).toEqual([
        'anthropic',
        'codex',
        'deepseek',
        'gemini',
      ])
      expect(results.every(result => result.action === 'failed')).toBe(true)
      expect(results[0]?.detail).toMatch(/settings exploded/)
    } finally {
      // In a finally, not after the assertions: a failed expectation must not
      // leave a throwing getSettingsForSource installed for the rest of this
      // file — or, under Bun's process-global mock registry, the rest of the
      // shard.
      settingsMock.reset()
    }
  })

  test('and the queue is usable again afterwards', async () => {
    // A shared promise chain fails differently from a single call: one rejected
    // link would make every later run reject too. The rejection slot in
    // `queue.then(runAutoPin, runAutoPin)` is what stops that, and this asserts
    // the run right after the failure above still works.
    process.env.GEMINI_API_KEY = 'AIza-live'

    expect(actionFor(await autoPinSearchCredentials(), 'gemini')).toBe('pinned')
  })
})

describe('what D and S write', () => {
  test('D records the opt-out, and the next run honours it', async () => {
    process.env.GEMINI_API_KEY = 'AIza-live'

    setSearchAutoPinEnabled('gemini', false)

    expect(readSearchAutoPinOverrides().gemini).toBe(false)
    expect(isSearchAutoPinEnabled('gemini')).toBe(false)
    expect(actionFor(await autoPinSearchCredentials(), 'gemini')).toBe(
      'opted-out',
    )
  })

  test('S clears the opt-out rather than storing a second kind of "on"', async () => {
    process.env.GEMINI_API_KEY = 'AIza-live'
    setSearchAutoPinEnabled('gemini', false)

    setSearchAutoPinEnabled('gemini', true)

    // Deleted, not set to true: the file carries decisions that differ from the
    // default and nothing else. The empty block that stays behind is the cost
    // of patching one nested key instead of rewriting the whole object.
    expect(readSearchAutoPinOverrides().gemini).toBeUndefined()
    expect(readUserSettings().webSearchAutoPin).toEqual({})
    expect(isSearchAutoPinEnabled('gemini')).toBe(true)
    expect(actionFor(await autoPinSearchCredentials(), 'gemini')).toBe('pinned')
  })

  test('one source’s opt-out does not disturb another’s', () => {
    setSearchAutoPinEnabled('gemini', false)
    setSearchAutoPinEnabled('codex', false)
    setSearchAutoPinEnabled('gemini', true)

    expect(readSearchAutoPinOverrides()).toMatchObject({ codex: false })
    expect(isSearchAutoPinEnabled('gemini')).toBe(true)
    expect(isSearchAutoPinEnabled('codex')).toBe(false)
  })

  test('it patches only its own key, leaving the rest of settings.json intact', () => {
    writeUserSettings({
      theme: 'dark',
      webSearchSources: { gemini: true, free: false },
    })

    setSearchAutoPinEnabled('gemini', false)

    const settings = readUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.webSearchSources).toEqual({ gemini: true, free: false })
    expect(settings.webSearchAutoPin).toEqual({ gemini: false })
  })
})
