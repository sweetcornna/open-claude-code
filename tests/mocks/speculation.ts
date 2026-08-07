/**
 * Shared complete-surface mock for src/services/PromptSuggestion/speculation.js.
 *
 * `abortSpeculation` reaches into `prev.speculation` on the app state, so any
 * suite driving a stripped-down fake state has to stub it. The hand-rolled
 * version listed that one export and therefore erased the rest of the module
 * for every file Bun loaded afterwards in the shard — see
 * tests/mocks/sharedModuleMock.ts.
 *
 * Importing the real module is side-effect free: it only declares functions and
 * constants at load.
 *
 * Usage:
 *   import { setupSpeculationMock } from '<relative>/tests/mocks/speculation.js'
 *   const m = setupSpeculationMock({ abortSpeculation: () => {} })
 *   afterAll(() => m.reset())
 */

import * as realSpeculation from 'src/services/PromptSuggestion/speculation.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SpeculationOverrides = ModuleOverrides<typeof realSpeculation>

const shared = makeSharedModuleMock(
  'src/services/PromptSuggestion/speculation.js',
  realSpeculation,
)

export function setupSpeculationMock(
  initial: SpeculationOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
