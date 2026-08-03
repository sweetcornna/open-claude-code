/**
 * Shared, complete mock for `src/utils/auth/user.js`. Import of the real
 * module is side-effect free (execa/config/state are only touched when a
 * function is CALLED), and delegation without an override runs exactly what an
 * unpoisoned consumer would have run — e.g. growthbook code importing
 * `getUserForGrowthBook` keeps working after a langfuse test overrode
 * `getCoreUserData`. Single instance per process: two test files each creating
 * their own makeSharedModuleMock for this specifier would fight over the
 * registry with independent override states. See tests/mocks/sharedModuleMock.ts
 * for the pollution background.
 */

import * as realUser from 'src/utils/auth/user.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type UserOverrides = ModuleOverrides<typeof realUser>

const shared = makeSharedModuleMock('src/utils/auth/user.js', realUser)

export function setupUserMock(
  initial: UserOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
