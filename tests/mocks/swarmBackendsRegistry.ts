/**
 * Shared, complete mock for `src/utils/swarm/backends/registry.js`. Import of
 * the real module is side-effect free; delegation only runs a real function
 * when a test actually calls it WITHOUT an override, so files that import the
 * register* hooks (WindowsTerminalBackend.test.ts etc.) keep loading after a
 * file with executor overrides ran first — a hand-rolled PARTIAL surface here
 * used to kill them at load ("Export named 'registerWindowsTerminalBackend'
 * not found"). Single instance per process: two test files each creating
 * their own makeSharedModuleMock for this specifier would fight over the
 * registry with independent override states.
 * See tests/mocks/sharedModuleMock.ts for the pollution background.
 */

import * as realSwarmBackendsRegistry from 'src/utils/swarm/backends/registry.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SwarmBackendsRegistryOverrides = ModuleOverrides<
  typeof realSwarmBackendsRegistry
>

const shared = makeSharedModuleMock(
  'src/utils/swarm/backends/registry.js',
  realSwarmBackendsRegistry,
)

export function setupSwarmBackendsRegistryMock(
  initial: SwarmBackendsRegistryOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
