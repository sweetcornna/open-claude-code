/**
 * Shared complete-surface mock for src/commands/recap/generateRecap.js.
 *
 * The real `generateRecap` forks an agent and calls the API, so the recap
 * command suite stubs it. Bun installs that stub process-wide, hence the
 * complete delegating surface — see tests/mocks/sharedModuleMock.ts.
 *
 * Usage:
 *   import { setupGenerateRecapMock } from '<relative>/tests/mocks/generateRecap.js'
 *   const m = setupGenerateRecapMock({ generateRecap: async () => ({ kind: 'ok' }) })
 *   afterAll(() => m.reset())
 */

import * as realGenerateRecap from 'src/commands/recap/generateRecap.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type GenerateRecapOverrides = ModuleOverrides<typeof realGenerateRecap>

const shared = makeSharedModuleMock(
  'src/commands/recap/generateRecap.js',
  realGenerateRecap,
)

export function setupGenerateRecapMock(
  initial: GenerateRecapOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
