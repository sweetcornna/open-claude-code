/**
 * Shared complete-surface mock for src/constants/oauth.js.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupConstantsOauthMock } from '<relative>/tests/mocks/constantsOauth.js'
 *   const m = setupConstantsOauthMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realConstantsOauth from 'src/constants/oauth.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ConstantsOauthOverrides = ModuleOverrides<typeof realConstantsOauth>

const shared = makeSharedModuleMock(
  'src/constants/oauth.js',
  realConstantsOauth,
)

export function setupConstantsOauthMock(
  initial: ConstantsOauthOverrides = {},
): {
  set(overrides: ConstantsOauthOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
