/**
 * Shared complete-surface mock for src/utils/agents/remoteTriggerAudit.js.
 *
 * The real `appendRemoteTriggerAuditRecord` mkdir's and appends to
 * `<projectRoot>/<PROJECT_DIR_NAME>/remote-trigger-audit.jsonl`, so a suite that
 * exercises RemoteTriggerTool has to intercept it — otherwise every run leaves
 * audit lines in the working tree. Only that one export needs overriding; the
 * rest (resolveRemoteTriggerAuditPath, listRemoteTriggerAuditRecords,
 * formatRemoteTriggerAuditStatus) delegate to the real module so later files in
 * the shard are unaffected.
 *
 * The module has no import-time side effects (a `join()` of two constants), so
 * loading it here to build the surface is free.
 *
 * Usage:
 *   import { setupRemoteTriggerAuditMock } from '../../tests/mocks/remoteTriggerAudit.js'
 *   const auditMock = setupRemoteTriggerAuditMock({
 *     appendRemoteTriggerAuditRecord: async record => { … },
 *   })
 *   afterAll(() => auditMock.reset())
 */

import * as realRemoteTriggerAudit from 'src/utils/agents/remoteTriggerAudit.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type RemoteTriggerAuditOverrides = ModuleOverrides<
  typeof realRemoteTriggerAudit
>

const shared = makeSharedModuleMock(
  'src/utils/agents/remoteTriggerAudit.js',
  realRemoteTriggerAudit,
)

export function setupRemoteTriggerAuditMock(
  initial: RemoteTriggerAuditOverrides = {},
): {
  set(overrides: RemoteTriggerAuditOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
