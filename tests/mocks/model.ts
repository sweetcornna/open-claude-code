/**
 * Shared complete-surface mock for `src/utils/model/model.js`.
 *
 * Two prompt suites (MagicDocs, SessionMemory) used to hand-roll ~28-entry
 * copies of this module's surface, each re-implementing `getDefaultOpusModel`
 * and `firstPartyNameToCanonical` from memory and gating them behind a
 * `useMockForX` sentinel so the *other* files in the shard would still see
 * something close to real behaviour. That is exactly the drift-prone shape
 * tests/mocks/sharedModuleMock.ts exists to remove: here the non-overridden
 * exports ARE the real functions, so they cannot fall out of sync, and
 * `reset()` restores everything for the rest of the process.
 *
 * Usage:
 *   import { setupModelMock } from '<relative>/tests/mocks/model.js'
 *   const modelMock = setupModelMock({ getMainLoopModel: () => 'claude-opus-4-7' })
 *   afterAll(() => modelMock.reset())
 */

import * as realModel from 'src/utils/model/model.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ModelOverrides = ModuleOverrides<typeof realModel>

const shared = makeSharedModuleMock('src/utils/model/model.js', realModel)

export function setupModelMock(
  initial: ModelOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
