/**
 * Shared complete-surface mock for @open-claude-code/builtin-tools/tools/AgentTool/agentToolUtils.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realAgentToolUtils from '@open-claude-code/builtin-tools/tools/AgentTool/agentToolUtils.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AgentToolUtilsOverrides = ModuleOverrides<typeof realAgentToolUtils>

const shared = makeSharedModuleMock(
  '@open-claude-code/builtin-tools/tools/AgentTool/agentToolUtils.js',
  realAgentToolUtils,
)

export function setupAgentToolUtilsMock(
  initial: AgentToolUtilsOverrides = {},
): {
  set(overrides: AgentToolUtilsOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
