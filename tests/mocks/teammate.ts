/**
 * Shared, complete mock for `src/utils/agents/teammate.js`.
 *
 * `src/utils/__tests__/tasks.test.ts` used to install a three-export partial
 * mock (getTeamName / isTeammate / isPlanModeRequired). Bun's `mock.module` is
 * process-global and last-write-wins, so that surface replaced the module's
 * other ~14 exports for every file loaded afterwards — and, worse, its
 * hardcoded `getTeamName: () => undefined` silently stubbed out the REAL
 * implementations that `src/utils/task/__tests__/agentScopedTasks.test.ts`
 * exists to exercise (that suite drives `setDynamicTeamContext` and asserts the
 * resulting task-list id). Two tests failed in a full run, in either file order.
 *
 * See tests/mocks/sharedModuleMock.ts for the delegating-surface mechanism.
 *
 * Usage:
 *   import { setupTeammateMock } from 'tests/mocks/teammate.js'
 *   const teammateMock = setupTeammateMock()          // all-real surface
 *   beforeAll(() => teammateMock.set({ getTeamName: () => undefined }))
 *   afterAll(() => teammateMock.reset())              // back to all-real
 */

import * as realTeammate from 'src/utils/agents/teammate.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type TeammateOverrides = ModuleOverrides<typeof realTeammate>

const shared = makeSharedModuleMock(
  'src/utils/agents/teammate.js',
  realTeammate,
)

export function setupTeammateMock(
  initial: TeammateOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
