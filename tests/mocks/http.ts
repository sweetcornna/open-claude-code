/**
 * Shared complete-surface mock for src/utils/network/http.js.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupHttpMock } from '<relative>/tests/mocks/http.js'
 *   const m = setupHttpMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realHttp from 'src/utils/network/http.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type HttpOverrides = ModuleOverrides<typeof realHttp>

const shared = makeSharedModuleMock('src/utils/network/http.js', realHttp)

export function setupHttpMock(initial: HttpOverrides = {}): {
  set(overrides: HttpOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
