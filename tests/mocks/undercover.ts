/**
 * Shared complete-surface mock for src/utils/auth/undercover.ts.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupUndercoverMock } from '<relative>/tests/mocks/undercover.js'
 *   const m = setupUndercoverMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realUndercover from 'src/utils/auth/undercover.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type UndercoverOverrides = ModuleOverrides<typeof realUndercover>

const shared = makeSharedModuleMock(
  'src/utils/auth/undercover.js',
  realUndercover,
)

export function setupUndercoverMock(initial: UndercoverOverrides = {}): {
  set(overrides: UndercoverOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
