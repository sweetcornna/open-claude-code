/**
 * Shared, complete mock for `src/utils/model/gptTuning.js`.
 *
 * Two suites drive this gate (EnterPlanMode tool copy, plan-mode instruction
 * variants). They must share ONE mock instance: `mock.module` is process-global
 * and last-write-wins, so two independently constructed mocks for the same
 * specifier would leave whichever loaded last holding the registry — the other
 * suite's overrides would then silently do nothing.
 *
 * See tests/mocks/sharedModuleMock.ts for the delegating mechanism.
 *
 * Usage:
 *   import { setupGptTuningMock } from 'tests/mocks/gptTuning.js'
 *   const gptTuning = setupGptTuningMock()        // all-real surface
 *   gptTuning.set({ isGptTuningActive: () => true })
 *   afterAll(() => gptTuning.reset())             // back to all-real
 */

import * as realGptTuning from 'src/utils/model/gptTuning.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type GptTuningOverrides = ModuleOverrides<typeof realGptTuning>

const shared = makeSharedModuleMock(
  'src/utils/model/gptTuning.js',
  realGptTuning,
)

export function setupGptTuningMock(
  initial: GptTuningOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
