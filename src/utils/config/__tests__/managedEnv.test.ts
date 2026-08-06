import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// Complete-surface shared mocks, never a hand-rolled `mock.module`: Bun's
// module registry is process-global and last-write-wins, so a partial surface
// here would poison every later importer of config.js / settings.js.
import * as realConfig from 'src/utils/config/config.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

const configMock = makeSharedModuleMock(
  'src/utils/config/config.js',
  realConfig,
).setup()
const settingsMock = setupSettingsMock()

const { createSettingsAwareEnvLookup, getEffectiveSettingsEnv } = await import(
  '../managedEnv'
)

/** Vars the assertions read straight out of process.env. */
const ENV_KEYS = [
  'MANAGED_ENV_TEST_ONLY_IN_PROCESS',
  'MANAGED_ENV_TEST_BOTH',
  'MANAGED_ENV_TEST_ONLY_IN_SETTINGS',
  // Guards: filterSettingsEnv strips keys when these are set.
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
] as const
const saved: Record<string, string | undefined> = {}

function setSettingsEnv(
  globalEnv: Record<string, string>,
  settingsEnv: Record<string, string>,
): void {
  configMock.set({
    getGlobalConfig: () =>
      ({ env: globalEnv }) as ReturnType<typeof realConfig.getGlobalConfig>,
  })
  settingsMock.set({ getSettings_DEPRECATED: () => ({ env: settingsEnv }) })
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  configMock.reset()
  settingsMock.reset()
})

describe('getEffectiveSettingsEnv', () => {
  test('merges global config env under the merged settings env', () => {
    setSettingsEnv(
      { MANAGED_ENV_TEST_BOTH: 'from-global', GLOBAL_ONLY: 'g' },
      { MANAGED_ENV_TEST_BOTH: 'from-settings', SETTINGS_ONLY: 's' },
    )

    expect(getEffectiveSettingsEnv()).toMatchObject({
      MANAGED_ENV_TEST_BOTH: 'from-settings',
      GLOBAL_ONLY: 'g',
      SETTINGS_ONLY: 's',
    })
  })

  test('tolerates absent env blocks', () => {
    configMock.set({
      getGlobalConfig: () =>
        ({}) as ReturnType<typeof realConfig.getGlobalConfig>,
    })
    settingsMock.set({ getSettings_DEPRECATED: () => ({}) })

    expect(getEffectiveSettingsEnv()).toEqual({})
  })
})

describe('createSettingsAwareEnvLookup', () => {
  // The regression this exists for: MCP configs are parsed during startup,
  // several hundred lines before showSetupScreens() runs the trust dialog and
  // applyConfigEnvironmentVariables() copies project-scoped settings.env into
  // process.env. A process.env-only lookup froze `${FRED_API_KEY}` as a
  // literal in exactly the snapshot that got spawned.
  test('resolves a var that only settings.env has, not process.env', () => {
    setSettingsEnv({}, { MANAGED_ENV_TEST_ONLY_IN_SETTINGS: 'secret' })

    expect(process.env.MANAGED_ENV_TEST_ONLY_IN_SETTINGS).toBeUndefined()
    expect(
      createSettingsAwareEnvLookup()('MANAGED_ENV_TEST_ONLY_IN_SETTINGS'),
    ).toBe('secret')
  })

  test('settings win over process.env, matching what applyConfigEnvironmentVariables would leave behind', () => {
    process.env.MANAGED_ENV_TEST_BOTH = 'ambient'
    setSettingsEnv({}, { MANAGED_ENV_TEST_BOTH: 'from-settings' })

    expect(createSettingsAwareEnvLookup()('MANAGED_ENV_TEST_BOTH')).toBe(
      'from-settings',
    )
  })

  test('falls back to process.env when settings say nothing', () => {
    process.env.MANAGED_ENV_TEST_ONLY_IN_PROCESS = 'ambient'
    setSettingsEnv({}, {})

    expect(
      createSettingsAwareEnvLookup()('MANAGED_ENV_TEST_ONLY_IN_PROCESS'),
    ).toBe('ambient')
  })

  test('returns undefined for a var nobody defines', () => {
    setSettingsEnv({}, {})

    expect(
      createSettingsAwareEnvLookup()('MANAGED_ENV_TEST_NOT_SET'),
    ).toBeUndefined()
  })

  test('snapshots settings once per lookup instance', () => {
    setSettingsEnv({}, { MANAGED_ENV_TEST_BOTH: 'first' })
    const lookup = createSettingsAwareEnvLookup()

    setSettingsEnv({}, { MANAGED_ENV_TEST_BOTH: 'second' })

    expect(lookup('MANAGED_ENV_TEST_BOTH')).toBe('first')
    expect(createSettingsAwareEnvLookup()('MANAGED_ENV_TEST_BOTH')).toBe(
      'second',
    )
  })
})
