/**
 * Barrel over src/utils/hooks/. Every name below used to live in this file;
 * the modules behind it are the same code, moved verbatim. Keep re-exports
 * explicit because the characterization test pins the runtime surface.
 *
 * The barrel is deliberately NOT exhaustive. `executeMessageDisplayHooks`,
 * `executeUserPromptExpansionHooks` and `getUserPromptExpansionHookBlockingMessage`
 * are reachable only from their leaf modules on purpose: importing this file
 * pulls in lifecycleHooks.ts (compaction, session storage, elicitation) plus
 * toolHooks/commandHooks, and their call sites — QueryEngine.ts via
 * hooks/messageDisplay.ts, and processUserInput/processSlashCommand.tsx — sit
 * where that import set closes 17 new import cycles. Do not "restore
 * consistency" by adding them here and routing the callers through the barrel.
 */
export {
  createBaseHookInput,
  getMatchingHooks,
  getSessionEndHookTimeoutMs,
  shouldSkipHookDueToTrust,
} from './hooks/config.js'
export {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getUserPromptSubmitHookBlockingMessage,
} from './hooks/messages.js'
export { hasBlockingResult } from './hooks/execution.js'
export type {
  AggregatedHookResult,
  ElicitationResponse,
  HookBlockingError,
  HookOutsideReplResult,
  HookResult,
} from './hooks/execution.js'
export {
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreToolHooks,
} from './hooks/toolHooks.js'
export {
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeDirectoryAddedHooks,
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeFileChangedHooks,
  executeInstructionsLoadedHooks,
  executeNotificationHooks,
  executePostCompactHooks,
  executePreCompactHooks,
  executeSessionEndHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeStopFailureHooks,
  executeStopHooks,
  executeSubagentStartHooks,
  executeTaskCompletedHooks,
  executeTaskCreatedHooks,
  executeTeammateIdleHooks,
  executeUserPromptSubmitHooks,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasInstructionsLoadedHook,
  hasWorktreeCreateHook,
} from './hooks/lifecycleHooks.js'
export type {
  ConfigChangeSource,
  ElicitationHookResult,
  ElicitationResultHookResult,
  InstructionsLoadReason,
  InstructionsMemoryType,
} from './hooks/lifecycleHooks.js'
export {
  executeFileSuggestionCommand,
  executeStatusLineCommand,
} from './hooks/commandHooks.js'
