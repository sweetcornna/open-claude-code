/**
 * Barrel over src/utils/hooks/. Every name below used to live in this file;
 * the modules behind it are the same code, moved verbatim. Keep re-exports
 * explicit because the characterization test pins the runtime surface.
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
