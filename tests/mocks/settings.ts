/**
 * Shared, complete mock for `src/utils/settings/settings.js`.
 *
 * A dozen test files mock this module. Hand-written partial surfaces are the
 * hazard: `src/services/providerRegistry/__tests__/switcher.test.ts` used to
 * export just two functions, one of them `updateSettingsForSource: () => {}`.
 * Under Bun's process-global last-write-wins `mock.module`, every file loaded
 * afterwards got that surface, so callers doing
 * `const { error } = updateSettingsForSource(...)` crashed on a `undefined`
 * return — visible only in a full-suite run, and only depending on file order.
 *
 * See tests/mocks/sharedModuleMock.ts for the delegating mechanism.
 *
 * Usage:
 *   import { setupSettingsMock } from 'tests/mocks/settings.js'
 *   const settingsMock = setupSettingsMock()          // all-real surface
 *   beforeAll(() => settingsMock.set({ getSettings_DEPRECATED: () => ({}) }))
 *   afterAll(() => settingsMock.reset())              // back to all-real
 */

import * as realSettings from 'src/utils/settings/settings.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SettingsOverrides = ModuleOverrides<typeof realSettings>

const shared = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
)

export function setupSettingsMock(
  initial: SettingsOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
