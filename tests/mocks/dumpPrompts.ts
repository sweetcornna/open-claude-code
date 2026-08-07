/**
 * Shared complete-surface mock for src/services/api/dumpPrompts.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realDumpPrompts from 'src/services/api/dumpPrompts.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type DumpPromptsOverrides = ModuleOverrides<typeof realDumpPrompts>

const shared = makeSharedModuleMock(
  'src/services/api/dumpPrompts.js',
  realDumpPrompts,
)

export function setupDumpPromptsMock(initial: DumpPromptsOverrides = {}): {
  set(overrides: DumpPromptsOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
