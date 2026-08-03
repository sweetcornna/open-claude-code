/**
 * Shared, complete mock for `src/tasks/RemoteAgentTask/RemoteAgentTask.js`.
 * Import of the real module is side-effect free, and delegation only runs a
 * real function when a test actually calls it WITHOUT an override — the same
 * code path the unmocked module would take. Crucially, the `RemoteAgentTask`
 * Task VALUE export is forwarded from the real module, so files that only
 * import the task definition (local-vault / teleport / local-memory command
 * tests) keep loading after a file with overrides ran first. Single instance
 * per process: two test files each creating their own makeSharedModuleMock
 * for this specifier would fight over the registry with independent override
 * states. See tests/mocks/sharedModuleMock.ts for the pollution background.
 */

import * as realRemoteAgentTask from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type RemoteAgentTaskOverrides = ModuleOverrides<
  typeof realRemoteAgentTask
>

const shared = makeSharedModuleMock(
  'src/tasks/RemoteAgentTask/RemoteAgentTask.js',
  realRemoteAgentTask,
)

export function setupRemoteAgentTaskMock(
  initial: RemoteAgentTaskOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
