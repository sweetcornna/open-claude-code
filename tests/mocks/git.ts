/**
 * Shared complete-surface mock for src/utils/git/git.js.
 *
 * Almost every command suite needs one or two git answers pinned
 * (`getDefaultBranch`, `findGitRoot`) but the module exports 28 functions, half
 * of them memoized and several spawning `git`. A hand-rolled surface listing
 * only what one suite reads is installed process-wide by Bun's mock registry,
 * so the rest of the shard sees `undefined` for everything else — and the
 * hand-copied "real" fallbacks that get added to paper over that then drift
 * from the implementation. See tests/mocks/sharedModuleMock.ts.
 *
 * The delegating surface forwards each memoized export's `.cache`, so callers
 * that clear it keep working, and pure helpers such as `normalizeGitRemoteUrl`
 * keep their real semantics without being copied into the test file.
 *
 * Importing the real module is side-effect free: it only builds memoized
 * closures at load.
 *
 * Usage:
 *   import { setupGitMock } from '<relative>/tests/mocks/git.js'
 *   const m = setupGitMock({ getDefaultBranch: async () => 'main' })
 *   afterAll(() => m.reset())
 */

import * as realGit from 'src/utils/git/git.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type GitOverrides = ModuleOverrides<typeof realGit>

const shared = makeSharedModuleMock('src/utils/git/git.js', realGit)

export function setupGitMock(initial: GitOverrides = {}): {
  set(overrides: GitOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
