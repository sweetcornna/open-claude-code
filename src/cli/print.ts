/**
 * Public surface of the headless (`-p` / SDK) CLI path.
 *
 * The implementation lives under `src/cli/print/`; this file only re-exports
 * the symbols other modules and tests import. `runHeadlessStreaming` — the
 * streaming session driver — is in `./print/runHeadlessStreaming.js` and is
 * consumed directly by `runHeadless`, so it is intentionally not re-exported
 * here.
 */
export { canBatchWith, joinPromptValues } from './print/promptQueue.js'
export { runHeadless } from './print/runHeadless.js'
export {
  createCanUseToolWithPermissionPrompt,
  getCanUseToolFn,
} from './print/toolPermissions.js'
export { removeInterruptedMessage } from './print/sessionLoading.js'
export { handleOrphanedPermissionResponse } from './print/structuredIO.js'
export {
  handleMcpSetServers,
  reconcileMcpServers,
  type DynamicMcpState,
  type McpSetServersResult,
  type SdkMcpState,
} from './print/mcpServers.js'
