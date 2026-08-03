/**
 * Shared complete-surface mock for src/services/analytics/index.js.
 *
 * Many test files hand-roll their own `mock.module` for this specifier. Each
 * copy happens to cover the full value-export surface today, but every new
 * export added to the real module silently turns those copies into partial
 * surfaces — the exact order-dependent CI poison documented in
 * tests/mocks/sharedModuleMock.ts. New suites must use this wrapper instead
 * of hand-rolling; existing copies migrate as they're touched.
 *
 * The real module is a no-op shell (no sink attached by default), so the
 * all-real surface is already side-effect free — most suites need no overrides.
 *
 * Usage:
 *   import { setupAnalyticsMock } from 'tests/mocks/analytics.js'
 *   const analyticsMock = setupAnalyticsMock()   // all-real (effectively no-op)
 *   afterAll(() => analyticsMock.reset())
 */

import * as realAnalytics from 'src/services/analytics/index.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AnalyticsOverrides = ModuleOverrides<typeof realAnalytics>

const shared = makeSharedModuleMock(
  'src/services/analytics/index.js',
  realAnalytics,
)

export function setupAnalyticsMock(initial: AnalyticsOverrides = {}): {
  set(overrides: AnalyticsOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
