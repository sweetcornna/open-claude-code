/**
 * Shared complete-surface mock for src/utils/git/worktree.js.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

import * as realWorktree from 'src/utils/git/worktree.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type WorktreeOverrides = ModuleOverrides<typeof realWorktree>

const shared = makeSharedModuleMock('src/utils/git/worktree.js', realWorktree)

export function setupWorktreeMock(initial: WorktreeOverrides = {}): {
  set(overrides: WorktreeOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
