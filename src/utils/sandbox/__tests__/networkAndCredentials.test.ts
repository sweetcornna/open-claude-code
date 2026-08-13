import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

// The adapter must not read the developer's real settings files, so the
// per-source readers are stubbed out. Scope matters as much as surface here:
// mock.module is process-global, so leaving these overrides installed makes
// every later file in the src/utils shard see getSettingsFilePathForSource()
// === undefined. That is exactly how this file used to break
// settings/__tests__/changeDetector.test.ts on Linux (different file order
// than macOS, so only CI saw it). setup() installs an all-real surface at
// load; the overrides live only for this suite.
const settingsMock = setupSettingsMock()
const HERMETIC_SOURCES = {
  getSettingsForSource: () => ({}),
  getSettingsFilePathForSource: () => undefined,
}
beforeAll(() => settingsMock.set(HERMETIC_SOURCES))
afterAll(() => settingsMock.reset())

const { convertToSandboxRuntimeConfig } = await import('../sandbox-adapter.js')
const { occConfigDir } = await import('src/config/paths.js')

import { join } from 'path'
import { homedir } from 'os'
import type { SettingsJson } from '../../settings/types.js'

describe('sandbox.network.deniedDomains independent key (2.1.113 parity)', () => {
  test('settings-key denials merge with rule-derived denials', () => {
    const config = convertToSandboxRuntimeConfig({
      sandbox: { network: { deniedDomains: ['tracker.evil'] } },
      permissions: { deny: ['WebFetch(domain:rule.evil)'] },
    } as SettingsJson)
    expect(config.network.deniedDomains).toContain('tracker.evil')
    expect(config.network.deniedDomains).toContain('rule.evil')
  })
})

describe('sandbox.credentials (2.1.187 parity, filesystem half)', () => {
  test('well-known credential stores land in denyRead when enabled', () => {
    const config = convertToSandboxRuntimeConfig({
      sandbox: { credentials: true },
    } as SettingsJson)
    const home = homedir()
    for (const path of [
      join(home, '.aws'),
      join(home, '.ssh'),
      join(home, '.kube'),
      join(home, '.netrc'),
      join(occConfigDir(), '.credentials.json'),
    ]) {
      expect(config.filesystem.denyRead).toContain(path)
    }
  })

  test('disabled or absent leaves denyRead untouched', () => {
    const config = convertToSandboxRuntimeConfig({
      sandbox: { credentials: false },
    } as SettingsJson)
    expect(config.filesystem.denyRead.some(p => p.includes('.aws'))).toBe(false)
  })

  test('credential denial survives trusted filesystem.disabled mode', () => {
    const settings = {
      sandbox: { credentials: true, filesystem: { disabled: true } },
    } as SettingsJson
    settingsMock.set({
      ...HERMETIC_SOURCES,
      getSettingsForSource: source =>
        source === 'userSettings' ? settings : {},
    })

    const config = convertToSandboxRuntimeConfig(settings)
    expect(config.filesystem.allowWrite).toContain('/')
    expect(config.filesystem.denyRead).toContain(join(homedir(), '.ssh'))

    settingsMock.set(HERMETIC_SOURCES)
  })
})

describe('sandbox.network.strictAllowlist (2.1.219 parity)', () => {
  test('strict mode closes the dangerouslyDisableSandbox escape hatch', async () => {
    // Enforcement lives in areUnsandboxedCommandsAllowed (private) — observe
    // it through SandboxManager, the surface shouldUseSandbox consults.
    const { SandboxManager } = await import('../sandbox-adapter.js')

    // set() has whole-map semantics, so the hermetic readers must be carried
    // along; the trailing set() restores the suite-wide baseline for any test
    // that runs after this one.
    settingsMock.set({
      ...HERMETIC_SOURCES,
      getSettings_DEPRECATED: () => ({
        sandbox: {
          network: { strictAllowlist: true },
          allowUnsandboxedCommands: true,
        },
      }),
    })
    expect(SandboxManager.areUnsandboxedCommandsAllowed()).toBe(false)

    settingsMock.set({
      ...HERMETIC_SOURCES,
      getSettings_DEPRECATED: () => ({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    })
    expect(SandboxManager.areUnsandboxedCommandsAllowed()).toBe(true)

    settingsMock.set(HERMETIC_SOURCES)
  })
})
