/**
 * Shared complete-surface mock for `src/utils/permissions/permissions.js`.
 *
 * The permission pipeline is imported by most of the tool/agent surface, so a
 * hand-rolled partial mock here is one of the worst offenders under Bun's
 * process-global, last-write-wins `mock.module`: every later file in the shard
 * loses `getPermissionHandling`, `savePermissionRule`, … See
 * tests/mocks/sharedModuleMock.ts for the full failure mode.
 *
 * Usage:
 *   import { setupPermissionsMock } from '<relative>/tests/mocks/permissions.js'
 *   const permissionsMock = setupPermissionsMock({
 *     hasPermissionsToUseTool: myRecordingStub,
 *   })
 *   afterAll(() => permissionsMock.reset())
 */

import * as realPermissions from 'src/utils/permissions/permissions.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type PermissionsOverrides = ModuleOverrides<typeof realPermissions>

const shared = makeSharedModuleMock(
  'src/utils/permissions/permissions.js',
  realPermissions,
)

export function setupPermissionsMock(
  initial: PermissionsOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
