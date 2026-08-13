import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

// Per-source rules must be empty for hermeticity (the disabled branch skips
// them; the enabled-control case must not see the developer's real settings
// files). Overrides are scoped to this suite rather than installed for the
// life of the process — mock.module is process-global, and a permanent
// getSettingsFilePathForSource() === undefined poisons every later file in
// the src/utils shard. See tests/mocks/settings.ts.
const settingsMock = setupSettingsMock()
const sourceSettings = new Map<string, SettingsJson>()
const installSourceSettings = () =>
  settingsMock.set({
    getSettingsForSource: source => sourceSettings.get(source) ?? {},
    getSettingsFilePathForSource: () => undefined,
  })
beforeAll(installSourceSettings)
afterAll(() => settingsMock.reset())

const { convertToSandboxRuntimeConfig } = await import('../sandbox-adapter.js')
const { occConfigDir } = await import('src/config/paths.js')

import type { SettingsJson } from '../../settings/types.js'

describe('sandbox.filesystem.disabled trusted-source policy (2.1.227 parity)', () => {
  const baseSettings: SettingsJson = {
    sandbox: {
      filesystem: { disabled: true },
      network: {
        allowedDomains: ['example.com'],
        allowLocalBinding: true,
      },
    },
    permissions: {
      allow: ['WebFetch(domain:allowed.dev)', 'Edit(/srv/data/**)'],
      deny: ['WebFetch(domain:evil.dev)', 'Edit(/srv/secret/**)'],
    },
  } as SettingsJson

  test.each([
    'projectSettings',
    'localSettings',
  ] as const)('%s cannot disable filesystem isolation', source => {
    sourceSettings.clear()
    sourceSettings.set(source, baseSettings)

    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.filesystem.allowWrite).toContain('.')
    expect(config.filesystem.allowWrite).not.toContain('/')
  })

  test.each([
    'userSettings',
    'flagSettings',
    'policySettings',
  ] as const)('%s can disable filesystem isolation', source => {
    sourceSettings.clear()
    sourceSettings.set(source, baseSettings)

    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.filesystem.allowWrite).toContain('/')
    expect(config.filesystem.allowWrite).not.toContain('/srv/data/**')
    expect(
      config.filesystem.denyWrite.some(p => p.includes('/srv/secret')),
    ).toBe(false)
    expect(config.filesystem.denyRead).toEqual([])
  })

  test('managed filesystem settings prevent lower-trust disabling', () => {
    sourceSettings.clear()
    sourceSettings.set('policySettings', {
      sandbox: { filesystem: { denyWrite: ['/managed/secret'] } },
    } as SettingsJson)
    sourceSettings.set('flagSettings', baseSettings)
    sourceSettings.set('userSettings', baseSettings)

    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.filesystem.allowWrite).not.toContain('/')
    expect(config.filesystem.denyWrite).toContain('/managed/secret')
  })

  test('network controls remain fully active', () => {
    sourceSettings.clear()
    sourceSettings.set('userSettings', baseSettings)
    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.network.allowedDomains).toContain('example.com')
    expect(config.network.allowedDomains).toContain('allowed.dev')
    expect(config.network.deniedDomains).toContain('evil.dev')
    expect(config.network.allowLocalBinding).toBe(true)
  })

  test('protected config directories stay denied even when disabled', () => {
    sourceSettings.clear()
    sourceSettings.set('userSettings', baseSettings)
    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.filesystem.denyWrite).toContain(occConfigDir())
  })

  test('disabled=false keeps the isolated default (cwd-scoped writes)', () => {
    const settings = {
      ...baseSettings,
      sandbox: { ...baseSettings.sandbox, filesystem: { disabled: false } },
    } as SettingsJson
    sourceSettings.clear()
    sourceSettings.set('userSettings', settings)
    const config = convertToSandboxRuntimeConfig(settings)
    expect(config.filesystem.allowWrite).toContain('.')
    expect(config.filesystem.allowWrite).not.toContain('/')
  })
})
