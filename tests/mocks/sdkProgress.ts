/**
 * Shared complete-surface mock for src/utils/task/sdkProgress.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realSdkProgress from 'src/utils/task/sdkProgress.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SdkProgressOverrides = ModuleOverrides<typeof realSdkProgress>

const shared = makeSharedModuleMock(
  'src/utils/task/sdkProgress.js',
  realSdkProgress,
)

export function setupSdkProgressMock(initial: SdkProgressOverrides = {}): {
  set(overrides: SdkProgressOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
