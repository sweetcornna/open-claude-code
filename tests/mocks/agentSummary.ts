/**
 * Shared complete-surface mock for src/services/AgentSummary/agentSummary.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realAgentSummary from 'src/services/AgentSummary/agentSummary.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AgentSummaryOverrides = ModuleOverrides<typeof realAgentSummary>

const shared = makeSharedModuleMock(
  'src/services/AgentSummary/agentSummary.js',
  realAgentSummary,
)

export function setupAgentSummaryMock(initial: AgentSummaryOverrides = {}): {
  set(overrides: AgentSummaryOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
