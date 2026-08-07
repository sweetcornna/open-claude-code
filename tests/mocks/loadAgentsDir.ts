/**
 * Shared complete-surface mock for @open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realLoadAgentsDir from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type LoadAgentsDirOverrides = ModuleOverrides<typeof realLoadAgentsDir>

const shared = makeSharedModuleMock(
  '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js',
  realLoadAgentsDir,
)

export function setupLoadAgentsDirMock(initial: LoadAgentsDirOverrides = {}): {
  set(overrides: LoadAgentsDirOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
