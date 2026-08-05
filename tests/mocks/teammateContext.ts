/**
 * Shared, complete mock for `src/utils/agents/teammateContext.js`.
 *
 * `src/utils/__tests__/tasks.test.ts` used to install a one-export partial mock
 * (`getTeammateContext: () => undefined`). Under Bun's process-global,
 * last-write-wins `mock.module` that erased `runWithTeammateContext`,
 * `isInProcessTeammate` and `createTeammateContext` for every file loaded
 * afterwards, and pinned `getTeammateContext` to undefined — which is exactly
 * the AsyncLocalStorage lookup `agentScopedTasks.test.ts` drives through
 * `runWithTeammateContext` to prove that in-process teammates share the team
 * task list.
 *
 * See tests/mocks/sharedModuleMock.ts for the delegating-surface mechanism.
 *
 * Usage:
 *   import { setupTeammateContextMock } from 'tests/mocks/teammateContext.js'
 *   const ctxMock = setupTeammateContextMock()        // all-real surface
 *   beforeAll(() => ctxMock.set({ getTeammateContext: () => undefined }))
 *   afterAll(() => ctxMock.reset())                   // back to all-real
 */

import * as realTeammateContext from 'src/utils/agents/teammateContext.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type TeammateContextOverrides = ModuleOverrides<
  typeof realTeammateContext
>

const shared = makeSharedModuleMock(
  'src/utils/agents/teammateContext.js',
  realTeammateContext,
)

export function setupTeammateContextMock(
  initial: TeammateContextOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
