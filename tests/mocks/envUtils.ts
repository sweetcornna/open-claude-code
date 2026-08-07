/**
 * Shared, complete mock for `src/utils/config/envUtils.js`.
 *
 * Seven test files used to install partial envUtils mocks whose hand-copied
 * fallbacks had drifted to the pre-isolation semantics (`CLAUDE_CONFIG_DIR ??
 * ~/.claude` instead of `OCC_CONFIG_DIR > CLAUDE_CONFIG_DIR > ~/.occ`) — the
 * root cause of the order-dependent `.claude`-path failures on Linux CI. See
 * tests/mocks/sharedModuleMock.ts for the mechanism that fixes this.
 *
 * Usage:
 *   import { setupEnvUtilsMock } from '../../tests/mocks/envUtils.js'
 *   const envUtilsMock = setupEnvUtilsMock()          // all-real surface
 *   beforeAll(() => envUtilsMock.set({ getClaudeConfigHomeDir: () => tmpDir }))
 *   afterAll(() => envUtilsMock.reset())              // back to all-real
 */

import * as realEnvUtils from 'src/utils/config/envUtils.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type EnvUtilsOverrides = ModuleOverrides<typeof realEnvUtils>

const shared = makeSharedModuleMock(
  'src/utils/config/envUtils.js',
  realEnvUtils,
)

export function setupEnvUtilsMock(
  initial: EnvUtilsOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
