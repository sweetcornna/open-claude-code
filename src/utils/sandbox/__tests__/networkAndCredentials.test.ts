import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
// Same real-module-spread pattern as filesystemDisabled.test.ts — keep the
// per-source rule reader hermetic without enumerating the export surface.
const realSettings = await import('../../settings/settings.js')
mock.module('src/utils/settings/settings.js', () => ({
  ...realSettings,
  getSettingsForSource: () => ({}),
  getSettingsFilePathForSource: () => undefined,
}))

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

  test('credential denial survives filesystem.disabled mode', () => {
    const config = convertToSandboxRuntimeConfig({
      sandbox: { credentials: true, filesystem: { disabled: true } },
    } as SettingsJson)
    expect(config.filesystem.allowWrite).toContain('/')
    expect(config.filesystem.denyRead).toContain(join(homedir(), '.ssh'))
  })
})

describe('sandbox.network.strictAllowlist (2.1.219 parity)', () => {
  test('strict mode closes the dangerouslyDisableSandbox escape hatch', async () => {
    // Enforcement lives in areUnsandboxedCommandsAllowed (private) — observe
    // it through SandboxManager, the surface shouldUseSandbox consults.
    const { SandboxManager } = await import('../sandbox-adapter.js')
    const withStrict = { ...realSettings }
    mock.module('src/utils/settings/settings.js', () => ({
      ...withStrict,
      getSettingsForSource: () => ({}),
      getSettingsFilePathForSource: () => undefined,
      getSettings_DEPRECATED: () => ({
        sandbox: {
          network: { strictAllowlist: true },
          allowUnsandboxedCommands: true,
        },
      }),
    }))
    expect(SandboxManager.areUnsandboxedCommandsAllowed()).toBe(false)

    mock.module('src/utils/settings/settings.js', () => ({
      ...withStrict,
      getSettingsForSource: () => ({}),
      getSettingsFilePathForSource: () => undefined,
      getSettings_DEPRECATED: () => ({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    }))
    expect(SandboxManager.areUnsandboxedCommandsAllowed()).toBe(true)
  })
})
