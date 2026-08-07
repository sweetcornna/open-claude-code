/**
 * Shared complete-surface mock for src/utils/git/attribution.ts.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupGitAttributionMock } from '<relative>/tests/mocks/gitAttribution.js'
 *   const m = setupGitAttributionMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realGitAttribution from 'src/utils/git/attribution.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type GitAttributionOverrides = ModuleOverrides<typeof realGitAttribution>

const shared = makeSharedModuleMock(
  'src/utils/git/attribution.js',
  realGitAttribution,
)

export function setupGitAttributionMock(
  initial: GitAttributionOverrides = {},
): {
  set(overrides: GitAttributionOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
