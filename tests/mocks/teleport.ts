/**
 * Shared complete-surface mock for src/utils/teleport/teleport.js.
 *
 * Every export here talks to the remote sessions API, so the autofix-pr and
 * teleport command suites both have to stub it. Both used to hand-roll their
 * own surface, and both missed the same two exports (`pollRemoteSessionEvents`,
 * `archiveRemoteSession`) — which, because Bun's mock registry is process-global
 * and last-write-wins, become `undefined` for every file loaded afterwards in
 * the shard. See tests/mocks/sharedModuleMock.ts.
 *
 * Importing the real module is side-effect free: it only declares functions,
 * components and schemas at load.
 *
 * Usage:
 *   import { setupTeleportMock } from '<relative>/tests/mocks/teleport.js'
 *   const m = setupTeleportMock({ teleportToRemote: spy })
 *   afterAll(() => m.reset())
 */

import * as realTeleport from 'src/utils/teleport/teleport.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type TeleportOverrides = ModuleOverrides<typeof realTeleport>

const shared = makeSharedModuleMock(
  'src/utils/teleport/teleport.js',
  realTeleport,
)

export function setupTeleportMock(
  initial: TeleportOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
