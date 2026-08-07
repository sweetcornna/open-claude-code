/**
 * Shared complete-surface mock for `src/utils/model/effort.js`.
 *
 * Companion to tests/mocks/model.ts — the same two prompt suites hand-rolled a
 * ~20-entry stub of this module purely to pin `getDisplayedEffortLevel`, which
 * meant every later file in the shard got `resolveAppliedEffort() === 'high'`
 * and `EFFORT_LEVELS` frozen at whatever the copy said. Delegating keeps the
 * rest real.
 *
 * Usage:
 *   import { setupEffortMock } from '<relative>/tests/mocks/effort.js'
 *   const effortMock = setupEffortMock({ getDisplayedEffortLevel: () => 'high' })
 *   afterAll(() => effortMock.reset())
 */

import * as realEffort from 'src/utils/model/effort.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type EffortOverrides = ModuleOverrides<typeof realEffort>

const shared = makeSharedModuleMock('src/utils/model/effort.js', realEffort)

export function setupEffortMock(
  initial: EffortOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
