/**
 * Shared complete-surface mock for src/utils/messages.ts.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realMessages from 'src/utils/messages.ts'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type MessagesOverrides = ModuleOverrides<typeof realMessages>

const shared = makeSharedModuleMock('src/utils/messages.ts', realMessages)

export function setupMessagesMock(initial: MessagesOverrides = {}): {
  set(overrides: MessagesOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
