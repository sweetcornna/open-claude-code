/**
 * Shared complete-surface mock for src/utils/config/config.js.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupConfigMock } from '<relative>/tests/mocks/config.js'
 *   const m = setupConfigMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realConfig from 'src/utils/config/config.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ConfigOverrides = ModuleOverrides<typeof realConfig>

const shared = makeSharedModuleMock('src/utils/config/config.js', realConfig)

export function setupConfigMock(initial: ConfigOverrides = {}): {
  set(overrides: ConfigOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
