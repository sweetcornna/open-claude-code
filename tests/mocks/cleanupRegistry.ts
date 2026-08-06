/**
 * Shared, complete mock for `src/utils/process/cleanupRegistry.js`.
 *
 * The registry is a process-global Set, so a test that lets real cleanup
 * functions accumulate leaks them into every later suite. The obvious fix —
 * `mock.module(..., { registerCleanup: () => noop })` — is worse: it is a
 * partial surface, and Bun's mock.module is process-global and last-write-wins,
 * so `runCleanupFunctions` became `undefined` for every file loaded afterwards.
 * See tests/mocks/sharedModuleMock.ts for the mechanism.
 *
 * Usage:
 *   import { setupCleanupRegistryMock } from 'tests/mocks/cleanupRegistry.js'
 *   const cleanupMock = setupCleanupRegistryMock()          // all-real surface
 *   beforeAll(() => cleanupMock.set({ registerCleanup: () => () => {} }))
 *   afterAll(() => cleanupMock.reset())                     // back to all-real
 */

import * as realCleanupRegistry from 'src/utils/process/cleanupRegistry.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type CleanupRegistryOverrides = ModuleOverrides<
  typeof realCleanupRegistry
>

const shared = makeSharedModuleMock(
  'src/utils/process/cleanupRegistry.js',
  realCleanupRegistry,
)

export function setupCleanupRegistryMock(
  initial: CleanupRegistryOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
