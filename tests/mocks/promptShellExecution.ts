/**
 * Shared complete-surface mock for src/utils/shell/promptShellExecution.ts.
 *
 * Hand-rolled `mock.module` copies of this specifier each covered only the
 * exports their own suite happened to touch. Bun's mock registry is
 * process-global and last-write-wins, so whichever file loads last decides
 * what every other file in the shard sees — a partial surface there means
 * "Export not found" or silent `undefined` somewhere unrelated. See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupPromptShellExecutionMock } from '<relative>/tests/mocks/promptShellExecution.js'
 *   const m = setupPromptShellExecutionMock({ someExport: () => 'stub' })
 *   afterAll(() => m.reset())
 */

import * as realPromptShellExecution from 'src/utils/shell/promptShellExecution.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type PromptShellExecutionOverrides = ModuleOverrides<
  typeof realPromptShellExecution
>

const shared = makeSharedModuleMock(
  'src/utils/shell/promptShellExecution.js',
  realPromptShellExecution,
)

export function setupPromptShellExecutionMock(
  initial: PromptShellExecutionOverrides = {},
): {
  set(overrides: PromptShellExecutionOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
