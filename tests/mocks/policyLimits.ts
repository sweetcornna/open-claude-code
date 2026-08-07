/**
 * Shared complete-surface mock for src/services/policyLimits/index.js.
 *
 * `isPolicyAllowed` is the only export most suites want to pin, but the module
 * also owns background polling, cache invalidation and the eligibility probe —
 * a hand-rolled surface that lists just `isPolicyAllowed` turns every one of
 * those into `undefined` for whatever file Bun loads next in the same shard.
 * See tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Importing the real module is side-effect free: the `setInterval` lives inside
 * `startBackgroundPolling()`, not at module scope.
 *
 * Usage:
 *   import { setupPolicyLimitsMock } from '<relative>/tests/mocks/policyLimits.js'
 *   const m = setupPolicyLimitsMock({ isPolicyAllowed: () => false })
 *   afterAll(() => m.reset())
 */

import * as realPolicyLimits from 'src/services/policyLimits/index.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type PolicyLimitsOverrides = ModuleOverrides<typeof realPolicyLimits>

const shared = makeSharedModuleMock(
  'src/services/policyLimits/index.js',
  realPolicyLimits,
)

export function setupPolicyLimitsMock(initial: PolicyLimitsOverrides = {}): {
  set(overrides: PolicyLimitsOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
