/**
 * Shared complete-surface mock for `src/services/lsp/config.js`.
 *
 * The real `getAllLspServers()` walks the installed plugin set from disk, so
 * suites that drive LSPServerManager have to stub it. A hand-rolled surface
 * would drop every other export for the rest of the shard — see
 * tests/mocks/sharedModuleMock.ts for why that is process-global damage rather
 * than a local choice.
 *
 * Usage:
 *   import { setupLspConfigMock } from '<relative>/tests/mocks/lspConfig.js'
 *   const lspConfigMock = setupLspConfigMock({
 *     getAllLspServers: async () => ({ servers: {} }),
 *   })
 *   afterAll(() => lspConfigMock.reset())
 */

import * as realLspConfig from 'src/services/lsp/config.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type LspConfigOverrides = ModuleOverrides<typeof realLspConfig>

const shared = makeSharedModuleMock('src/services/lsp/config.js', realLspConfig)

export function setupLspConfigMock(
  initial: LspConfigOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
