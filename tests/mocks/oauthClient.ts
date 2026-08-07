/**
 * Shared complete-surface mock for src/services/oauth/client.js.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupOauthClientMock } from '<relative>/tests/mocks/oauthClient.js'
 *   const m = setupOauthClientMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realOauthClient from 'src/services/oauth/client.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type OauthClientOverrides = ModuleOverrides<typeof realOauthClient>

const shared = makeSharedModuleMock(
  'src/services/oauth/client.js',
  realOauthClient,
)

export function setupOauthClientMock(initial: OauthClientOverrides = {}): {
  set(overrides: OauthClientOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
