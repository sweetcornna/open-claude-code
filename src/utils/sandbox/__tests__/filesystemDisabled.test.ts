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
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: () => ({}),
    getSettingsFilePathForSource: () => undefined,
  }),
)
afterAll(() => settingsMock.reset())

const { convertToSandboxRuntimeConfig } = await import('../sandbox-adapter.js')
const { occConfigDir } = await import('src/config/paths.js')

import type { SettingsJson } from '../../settings/types.js'

describe('sandbox.filesystem.disabled (2.1.216 parity)', () => {
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

  test('filesystem opens to / and skips rule-derived path collection', () => {
    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.filesystem.allowWrite).toContain('/')
    // Rule-derived paths are NOT collected in disabled mode
    expect(config.filesystem.allowWrite).not.toContain('/srv/data/**')
    expect(
      config.filesystem.denyWrite.some(p => p.includes('/srv/secret')),
    ).toBe(false)
    expect(config.filesystem.denyRead).toEqual([])
  })

  test('network controls remain fully active', () => {
    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.network.allowedDomains).toContain('example.com')
    expect(config.network.allowedDomains).toContain('allowed.dev')
    expect(config.network.deniedDomains).toContain('evil.dev')
    expect(config.network.allowLocalBinding).toBe(true)
  })

  test('protected config directories stay denied even when disabled', () => {
    const config = convertToSandboxRuntimeConfig(baseSettings)
    expect(config.filesystem.denyWrite).toContain(occConfigDir())
  })

  test('disabled=false keeps the isolated default (cwd-scoped writes)', () => {
    const settings = {
      ...baseSettings,
      sandbox: { ...baseSettings.sandbox, filesystem: { disabled: false } },
    } as SettingsJson
    const config = convertToSandboxRuntimeConfig(settings)
    expect(config.filesystem.allowWrite).toContain('.')
    expect(config.filesystem.allowWrite).not.toContain('/')
  })
})
