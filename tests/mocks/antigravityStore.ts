/**
 * Shared, complete mock for `src/services/auth/antigravity/store.js`.
 *
 * The Antigravity credential store writes into occConfigDir(), which is
 * memoized on first call — a test that points OCC_CONFIG_DIR at a temp dir
 * after some earlier file already resolved it would silently write into the
 * developer's real config. Overriding the store surface keeps credential tests
 * entirely in memory instead.
 *
 * Complete-surface delegation per tests/mocks/sharedModuleMock.ts: exports the
 * suite does not override still run the real implementation, so a later test
 * file inheriting this process-global mock is unaffected.
 *
 * Usage:
 *   import { setupAntigravityStoreMock } from 'tests/mocks/antigravityStore.js'
 *   const storeMock = setupAntigravityStoreMock()
 *   beforeEach(() => storeMock.set({ readAntigravityTokens: async () => tokens }))
 *   afterAll(() => storeMock.reset())
 */

import * as realStore from 'src/services/auth/antigravity/store.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AntigravityStoreOverrides = ModuleOverrides<typeof realStore>

const shared = makeSharedModuleMock(
  'src/services/auth/antigravity/store.js',
  realStore,
)

export function setupAntigravityStoreMock(
  initial: AntigravityStoreOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
