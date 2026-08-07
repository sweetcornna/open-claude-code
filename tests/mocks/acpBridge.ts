/**
 * Shared complete-surface mock for `src/services/acp/bridge.js`.
 *
 * `bridge.ts` is a barrel over `./bridge/*`; its header explicitly asks that
 * the public export list stay stable because permissions.test.ts replaces the
 * module. A delegating surface built from the real barrel keeps that promise
 * automatically — new re-exports show up without anyone editing a mock — and,
 * unlike a snapshot, restores real behaviour on `reset()` rather than pinning
 * whatever the module looked like at load time.
 *
 * Usage:
 *   import { setupAcpBridgeMock } from '<relative>/tests/mocks/acpBridge.js'
 *   const bridgeMock = setupAcpBridgeMock({ toolInfoFromToolUse: stub })
 *   afterAll(() => bridgeMock.reset())
 */

import * as realAcpBridge from 'src/services/acp/bridge.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AcpBridgeOverrides = ModuleOverrides<typeof realAcpBridge>

const shared = makeSharedModuleMock('src/services/acp/bridge.js', realAcpBridge)

export function setupAcpBridgeMock(
  initial: AcpBridgeOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
