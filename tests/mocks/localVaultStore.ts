/**
 * Shared complete-surface mock for src/services/localVault/store.js.
 *
 * The real `getSecret` decrypts an on-disk vault and can reach the OS keychain,
 * so suites that exercise a consumer (VaultHttpFetchTool) have to hand it a
 * fixed secret. Everything else — setSecret / deleteSecret / listKeys /
 * maskSecret and the exported error classes — delegates to the real module, so
 * localVault's own store.test.ts keeps its real round-trip behaviour even when
 * it loads after a consumer suite in the same Bun process.
 *
 * The module has no import-time side effects (module-level state is a function
 * reference and a resolved promise), so loading it to build the surface is free.
 *
 * Usage:
 *   import { setupLocalVaultStoreMock } from '../../tests/mocks/localVaultStore.js'
 *   const storeMock = setupLocalVaultStoreMock({ getSecret: async () => 'S' })
 *   afterAll(() => storeMock.reset())
 */

import * as realLocalVaultStore from 'src/services/localVault/store.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type LocalVaultStoreOverrides = ModuleOverrides<
  typeof realLocalVaultStore
>

const shared = makeSharedModuleMock(
  'src/services/localVault/store.js',
  realLocalVaultStore,
)

export function setupLocalVaultStoreMock(
  initial: LocalVaultStoreOverrides = {},
): {
  set(overrides: LocalVaultStoreOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
