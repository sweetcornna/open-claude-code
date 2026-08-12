/**
 * GH #3117 regression guard: a global-config write must never drop auth state
 * that the in-memory cache still holds.
 *
 * Deliberately mock-free. The bug this pins is a filesystem race (a config file
 * caught truncated mid-write by another process), and every mocked fs layer in
 * this repo models the happy path — so a mock would have hidden it. Everything
 * below runs against a real temp directory pointed at by OCC_CONFIG_DIR.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousConfigDir = process.env.OCC_CONFIG_DIR
const previousLegacyConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousNodeEnv = process.env.NODE_ENV

let tempConfigDir = ''

beforeAll(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), 'occ-auth-loss-guard-'))
  process.env.OCC_CONFIG_DIR = tempConfigDir
  delete process.env.CLAUDE_CONFIG_DIR
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = previousConfigDir
  if (previousLegacyConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousLegacyConfigDir
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true })
})

type ConfigModule = typeof import('../config.js')
type EnvModule = typeof import('../env.js')

let config: ConfigModule
let globalConfigFile = ''

async function loadModules(): Promise<void> {
  if (config) return
  config = (await import('../config.js')) as ConfigModule
  const env = (await import('../env.js')) as EnvModule
  // Memoized with no resolver, so the first caller in this process pins the
  // path. Clear it after OCC_CONFIG_DIR is set or we would write into the
  // developer's real ~/.occ.json.
  ;(
    env.getGlobalClaudeFile as unknown as { cache: { clear(): void } }
  ).cache.clear()
  globalConfigFile = env.getGlobalClaudeFile()
  expect(globalConfigFile.startsWith(tempConfigDir)).toBe(true)
  config.enableConfigs()
}

const OAUTH_ACCOUNT = {
  accountUuid: '00000000-0000-4000-8000-000000000001',
  emailAddress: 'user@example.com',
  organizationUuid: '00000000-0000-4000-8000-000000000002',
} as const

describe('wouldLoseAuthState', () => {
  test('covers every credential-bearing field, not just oauthAccount', async () => {
    await loadModules()
    const {
      _wouldLoseAuthStateForTesting: wouldLoseAuthState,
      _setGlobalConfigCacheForTesting: setCache,
    } = config

    // No cache yet: nothing to lose, so nothing to refuse.
    setCache(null)
    expect(wouldLoseAuthState({})).toBe(false)

    const base = config.getGlobalConfig()

    for (const field of [
      'oauthAccount',
      'primaryApiKey',
      'workspaceApiKey',
    ] as const) {
      const value = field === 'oauthAccount' ? OAUTH_ACCOUNT : 'sk-ant-api03-x'
      setCache({ ...base, [field]: value })
      expect(wouldLoseAuthState({})).toBe(true)
      // Present in the re-read too: nothing lost.
      expect(wouldLoseAuthState({ [field]: value })).toBe(false)
    }

    setCache({ ...base, hasCompletedOnboarding: true })
    expect(wouldLoseAuthState({})).toBe(true)
    expect(wouldLoseAuthState({ hasCompletedOnboarding: true })).toBe(false)

    // An approval ledger is not a credential -- losing it re-prompts, it does
    // not log anyone out, so it must NOT block a write.
    setCache({ ...base, customApiKeyResponses: { approved: ['abc123'] } })
    expect(wouldLoseAuthState({})).toBe(false)

    setCache(null)
  })
})

describe('saveConfig auth guard (final writer)', () => {
  test('refuses a global-config write whose merge base lost auth', async () => {
    await loadModules()
    const {
      _saveConfigForTesting: saveConfig,
      _setGlobalConfigCacheForTesting: setCache,
    } = config

    const good = {
      ...config.getGlobalConfig(),
      primaryApiKey: 'sk-ant-api03-live',
    }
    writeFileSync(globalConfigFile, JSON.stringify(good, null, 2), 'utf8')
    setCache(good)

    // Merge base is a truncated/defaulted read: the write must be refused and
    // the file left exactly as it was.
    const before = readFileSync(globalConfigFile, 'utf8')
    const wrote = saveConfig(
      globalConfigFile,
      { ...good, primaryApiKey: undefined, verbose: true },
      config.DEFAULT_GLOBAL_CONFIG,
      { caller: 'unit test', mergeBase: {} },
    )
    expect(wrote).toBe(false)
    expect(readFileSync(globalConfigFile, 'utf8')).toBe(before)

    setCache(null)
  })

  test('allows a write whose merge base still has the auth fields', async () => {
    await loadModules()
    const {
      _saveConfigForTesting: saveConfig,
      _setGlobalConfigCacheForTesting: setCache,
    } = config

    const good = {
      ...config.getGlobalConfig(),
      primaryApiKey: 'sk-ant-api03-live',
    }
    writeFileSync(globalConfigFile, JSON.stringify(good, null, 2), 'utf8')
    setCache(good)

    // Intentional logout: the merge base still has the key, the CONTENT drops
    // it. Guarding the content instead of the base would break /logout.
    const wrote = saveConfig(
      globalConfigFile,
      { ...good, primaryApiKey: undefined, oauthAccount: undefined },
      config.DEFAULT_GLOBAL_CONFIG,
      { caller: 'unit test', mergeBase: good },
    )
    expect(wrote).toBe(true)
    const onDisk = JSON.parse(readFileSync(globalConfigFile, 'utf8')) as Record<
      string,
      unknown
    >
    expect(onDisk.primaryApiKey).toBeUndefined()

    setCache(null)
  })
})

describe('saveGlobalConfig end-to-end', () => {
  test('a corrupted config file cannot wipe a cached login', async () => {
    await loadModules()
    process.env.NODE_ENV = 'production'
    try {
      config._setGlobalConfigCacheForTesting(null)
      config.saveGlobalConfig(current => ({
        ...current,
        oauthAccount: OAUTH_ACCOUNT,
        primaryApiKey: 'sk-ant-api03-live',
      }))

      const written = JSON.parse(
        readFileSync(globalConfigFile, 'utf8'),
      ) as Record<string, unknown>
      expect(written.primaryApiKey).toBe('sk-ant-api03-live')
      expect(written.oauthAccount).toBeDefined()

      // Simulate another process caught mid-write: the file is now unparseable,
      // so getConfig() hands back defaults with no auth at all.
      const corrupted = '{"theme":"dark"'
      writeFileSync(globalConfigFile, corrupted, 'utf8')

      config.saveGlobalConfig(current => ({ ...current, verbose: true }))

      // The guard must have refused: the corrupt bytes are still there, which
      // means we did not overwrite the file with an auth-less default config.
      expect(readFileSync(globalConfigFile, 'utf8')).toBe(corrupted)
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      config._setGlobalConfigCacheForTesting(null)
    }
  })
})
