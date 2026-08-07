/**
 * Shared complete-surface mock for @open-claude-code/tool-runtime/analytics.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realToolRuntimeAnalytics from '@open-claude-code/tool-runtime/analytics.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ToolRuntimeAnalyticsOverrides = ModuleOverrides<
  typeof realToolRuntimeAnalytics
>

const shared = makeSharedModuleMock(
  '@open-claude-code/tool-runtime/analytics.js',
  realToolRuntimeAnalytics,
)

export function setupToolRuntimeAnalyticsMock(
  initial: ToolRuntimeAnalyticsOverrides = {},
): {
  set(overrides: ToolRuntimeAnalyticsOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
