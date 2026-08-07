/**
 * Shared complete-surface mock for src/services/auth/hostGuard.ts.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupHostGuardMock } from '<relative>/tests/mocks/hostGuard.js'
 *   const m = setupHostGuardMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realHostGuard from 'src/services/auth/hostGuard.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type HostGuardOverrides = ModuleOverrides<typeof realHostGuard>

const shared = makeSharedModuleMock(
  'src/services/auth/hostGuard.js',
  realHostGuard,
)

export function setupHostGuardMock(initial: HostGuardOverrides = {}): {
  set(overrides: HostGuardOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
