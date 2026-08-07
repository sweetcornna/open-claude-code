/**
 * Shared complete-surface mock for src/utils/collections/uuid.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realUuid from 'src/utils/collections/uuid.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type UuidOverrides = ModuleOverrides<typeof realUuid>

const shared = makeSharedModuleMock('src/utils/collections/uuid.js', realUuid)

export function setupUuidMock(initial: UuidOverrides = {}): {
  set(overrides: UuidOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
