/**
 * Shared, complete mock for `src/utils/teleport/api.js`. Import of the real
 * module is side-effect free; the network-touching functions only run when a
 * test actually calls one WITHOUT an override — the same request the unmocked
 * module would make. This module is the most-mocked surface in the repo
 * (schedule / agents-platform / memory-stores / skill-store / vault / teleport
 * / review command tests all stub `prepare*ApiRequest` or `getOAuthHeaders`):
 * hand-rolled PARTIAL surfaces here used to break every later file importing
 * any other export ("Export named 'getBranchFromSession' not found" at load).
 * Single instance per process: two test files each creating their own
 * makeSharedModuleMock for this specifier would fight over the registry with
 * independent override states. See tests/mocks/sharedModuleMock.ts for the
 * pollution background.
 */

import * as realTeleportApi from 'src/utils/teleport/api.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type TeleportApiOverrides = ModuleOverrides<typeof realTeleportApi>

const shared = makeSharedModuleMock(
  'src/utils/teleport/api.js',
  realTeleportApi,
)

export function setupTeleportApiMock(
  initial: TeleportApiOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
