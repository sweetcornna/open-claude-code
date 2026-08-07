/**
 * Shared complete-surface mock for @open-claude-code/builtin-tools/tools/AgentTool/runAgent.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realRunAgent from '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type RunAgentOverrides = ModuleOverrides<typeof realRunAgent>

const shared = makeSharedModuleMock(
  '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
  realRunAgent,
)

export function setupRunAgentMock(initial: RunAgentOverrides = {}): {
  set(overrides: RunAgentOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
