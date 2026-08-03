/**
 * Shared, complete mock for `src/utils/git/detectRepository.js`. The module is
 * safe to delegate to: the parse helpers are pure, and the detect functions
 * only shell out to `git remote get-url` when actually called WITHOUT an
 * override — the same subprocess the unmocked module would run. Single
 * instance per process: two test files each creating their own
 * makeSharedModuleMock for this specifier would fight over the registry with
 * independent override states; routing both through this wrapper makes
 * setup(overrides) whole-map semantics well-defined.
 * See tests/mocks/sharedModuleMock.ts for the pollution background.
 */

import * as realDetectRepository from 'src/utils/git/detectRepository.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type DetectRepositoryOverrides = ModuleOverrides<
  typeof realDetectRepository
>

const shared = makeSharedModuleMock(
  'src/utils/git/detectRepository.js',
  realDetectRepository,
)

export function setupDetectRepositoryMock(
  initial: DetectRepositoryOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
