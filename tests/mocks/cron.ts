/**
 * Shared, complete mock for `src/utils/task/cron.js` (pure functions —
 * delegate-to-real is safe). Single instance per process: two test files each
 * creating their own makeSharedModuleMock for this specifier would fight over
 * the registry with independent override states; routing both through this
 * wrapper makes setup(overrides) whole-map semantics well-defined.
 * See tests/mocks/sharedModuleMock.ts for the pollution background.
 */

import * as realCron from 'src/utils/task/cron.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type CronOverrides = ModuleOverrides<typeof realCron>

const shared = makeSharedModuleMock('src/utils/task/cron.js', realCron)

export function setupCronMock(
  initial: CronOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
