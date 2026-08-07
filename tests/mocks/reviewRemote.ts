/**
 * Shared complete-surface mock for src/commands/review/reviewRemote.js.
 *
 * `checkOverageGate` reads quota/utilization over the network and
 * `launchRemoteReview` creates a remote session, so the ultrareview command
 * suite drives both through stubs. That stub is installed process-wide by Bun's
 * mock registry, hence the complete delegating surface — see
 * tests/mocks/sharedModuleMock.ts.
 *
 * Importing the real module is side-effect free: it only declares functions and
 * a session-scoped boolean at load.
 *
 * Usage:
 *   import { setupReviewRemoteMock } from '<relative>/tests/mocks/reviewRemote.js'
 *   const m = setupReviewRemoteMock({ checkOverageGate: async () => gate })
 *   afterAll(() => m.reset())
 */

import * as realReviewRemote from 'src/commands/review/reviewRemote.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ReviewRemoteOverrides = ModuleOverrides<typeof realReviewRemote>

const shared = makeSharedModuleMock(
  'src/commands/review/reviewRemote.js',
  realReviewRemote,
)

export function setupReviewRemoteMock(
  initial: ReviewRemoteOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
