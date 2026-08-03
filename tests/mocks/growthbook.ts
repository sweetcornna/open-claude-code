/**
 * Shared, complete mock for `src/services/analytics/growthbook.js`.
 *
 * Five test files used to install partial growthbook mocks with different
 * hand-picked export lists. Whichever ran last broke every later import that
 * needed an export missing from its list ("Export named X not found" at module
 * load, or `undefined is not a function` at call time) — order-dependent on
 * CI. See tests/mocks/sharedModuleMock.ts for the mechanism that fixes this.
 *
 * Usage:
 *   import { setupGrowthbookMock } from 'tests/mocks/growthbook.ts'
 *   setupGrowthbookMock({ getFeatureValue_CACHED_MAY_BE_STALE: () => false })
 */

import * as realGrowthbook from 'src/services/analytics/growthbook.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.ts'

export type GrowthbookOverrides = ModuleOverrides<typeof realGrowthbook>

const shared = makeSharedModuleMock(
  'src/services/analytics/growthbook.js',
  realGrowthbook,
)

export function setupGrowthbookMock(
  initial: GrowthbookOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
