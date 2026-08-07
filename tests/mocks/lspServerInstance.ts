/**
 * Shared complete-surface mock for `src/services/lsp/LSPServerInstance.js`.
 *
 * `createLSPServerInstance()` spawns a real language-server child process, so
 * any suite exercising LSPServerManager has to replace it. Going through the
 * shared factory keeps the rest of the module's surface real for every file
 * that loads after this one — Bun's mock registry is process-global and
 * last-write-wins (see tests/mocks/sharedModuleMock.ts).
 *
 * Usage:
 *   import { setupLspServerInstanceMock } from '<relative>/tests/mocks/lspServerInstance.js'
 *   const lspInstanceMock = setupLspServerInstanceMock({
 *     createLSPServerInstance: (name, config) => fakeInstance(name, config),
 *   })
 *   afterAll(() => lspInstanceMock.reset())
 */

import * as realLspServerInstance from 'src/services/lsp/LSPServerInstance.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type LspServerInstanceOverrides = ModuleOverrides<
  typeof realLspServerInstance
>

const shared = makeSharedModuleMock(
  'src/services/lsp/LSPServerInstance.js',
  realLspServerInstance,
)

export function setupLspServerInstanceMock(
  initial: LspServerInstanceOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
