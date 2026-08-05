/**
 * Shared, complete mock for `src/utils/sessionStorage.js`.
 *
 * `src/tasks/LocalAgentTask/__tests__/LocalAgentTask.test.ts` used to install a
 * four-export partial mock (getAgentTranscriptPath, recordSidechainTranscript,
 * recordQueueOperation, writeAgentMetadata). Under Bun's process-global,
 * last-write-wins `mock.module`, that erased the module's other ~60 exports for
 * every file loaded afterwards in the same process — a co-running suite that
 * touches the barrel died with "Export named 'getTranscriptPathForSession' not
 * found". The failure only appears in a combined run, and which file loses
 * depends on Bun's file order (which differs between macOS and Linux).
 *
 * See tests/mocks/sharedModuleMock.ts for the delegating-surface mechanism.
 *
 * Usage:
 *   import { setupSessionStorageMock } from 'tests/mocks/sessionStorage.js'
 *   const sessionStorageMock = setupSessionStorageMock()   // all-real surface
 *   beforeAll(() => sessionStorageMock.set({ writeAgentMetadata: async () => {} }))
 *   afterAll(() => sessionStorageMock.reset())             // back to all-real
 */

import * as realSessionStorage from 'src/utils/sessionStorage.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SessionStorageOverrides = ModuleOverrides<typeof realSessionStorage>

const shared = makeSharedModuleMock(
  'src/utils/sessionStorage.js',
  realSessionStorage,
)

export function setupSessionStorageMock(
  initial: SessionStorageOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
