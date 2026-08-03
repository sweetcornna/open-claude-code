/**
 * Shared, complete mock for `src/utils/session/messageQueueManager.js`.
 *
 * `src/utils/task/__tests__/framework.test.ts` used to install a one-export
 * partial mock (`enqueuePendingNotification: noop`). Under Bun's process-global
 * last-write-wins `mock.module`, that erased the other 23 exports for every
 * file loaded afterwards — `runBackgroundQuery`'s test saw an empty command
 * queue in the full suite while passing on its own. See
 * tests/mocks/sharedModuleMock.ts for the mechanism.
 *
 * Usage:
 *   import { setupMessageQueueManagerMock } from 'tests/mocks/messageQueueManager.js'
 *   const queueMock = setupMessageQueueManagerMock()   // all-real surface
 *   beforeAll(() => queueMock.set({ enqueuePendingNotification: () => {} }))
 *   afterAll(() => queueMock.reset())                  // back to all-real
 */

import * as realMessageQueueManager from 'src/utils/session/messageQueueManager.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type MessageQueueManagerOverrides = ModuleOverrides<
  typeof realMessageQueueManager
>

const shared = makeSharedModuleMock(
  'src/utils/session/messageQueueManager.js',
  realMessageQueueManager,
)

export function setupMessageQueueManagerMock(
  initial: MessageQueueManagerOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
