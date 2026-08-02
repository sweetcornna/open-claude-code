/**
 * Barrel over src/utils/messages/. Every name below used to live in this file;
 * the modules behind it are the same code, moved verbatim. Keep the re-exports
 * explicit — call sites and the characterization test both pin this surface.
 */
export {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  PLAN_REJECTION_PREFIX,
  DENIAL_WORKAROUND_GUIDANCE,
  NO_RESPONSE_REQUESTED,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  SYNTHETIC_MODEL,
  SYNTHETIC_MESSAGES,
} from './messages/constants.js'
export {
  withMemoryCorrectionHint,
  deriveShortMessageId,
  extractTag,
  isEmptyMessageText,
  stripPromptXMLTags,
  getAssistantMessageText,
  getUserMessageText,
  textForResubmit,
  extractTextContent,
  getContentText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
  wrapCommandText,
} from './messages/text.js'
export {
  AUTO_REJECT_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
  isClassifierDenial,
  buildYoloRejectionMessage,
  buildClassifierUnavailableMessage,
  isSyntheticMessage,
  getLastAssistantMessage,
  hasToolCallsInLastAssistantTurn,
  isNotEmptyMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  isSystemLocalCommandMessage,
  shouldShowUserMessage,
  isThinkingMessage,
  countToolCalls,
  hasSuccessfulToolCall,
} from './messages/predicates.js'
export {
  createAssistantMessage,
  createAssistantAPIErrorMessage,
  createUserMessage,
  prepareUserContent,
  createUserInterruptionMessage,
  createSyntheticUserCaveatMessage,
  formatCommandInputTags,
  createModelSwitchBreadcrumbs,
  createProgressMessage,
  createToolResultStopMessage,
} from './messages/constructors.js'
export {
  createSystemMessage,
  createPermissionRetryMessage,
  createBridgeStatusMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createTurnDurationMessage,
  createAwaySummaryMessage,
  createMemorySavedMessage,
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMicrocompactBoundaryMessage,
  createSystemAPIErrorMessage,
  isCompactBoundaryMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
} from './messages/systemMessages.js'
export {
  deriveUUID,
  normalizeMessages,
  reorderMessagesInUI,
  normalizeContentFromAPI,
} from './messages/normalize.js'
export {
  hasUnresolvedHooks,
  getToolResultIDs,
  getSiblingToolUseIDs,
  getToolUseIDs,
  getToolUseID,
} from './messages/toolUseIds.js'
export {
  buildMessageLookups,
  updateMessageLookupsIncremental,
  computeMessageStructureKey,
  resolveMessageLookups,
} from './messages/lookups.js'
export type {
  MessageLookups,
  MessageLookupsCache,
  MessageLookupsSource,
  ResolvedMessageLookups,
} from './messages/lookups.js'
export {
  EMPTY_LOOKUPS,
  EMPTY_STRING_SET,
  buildSubagentLookups,
  getSiblingToolUseIDsFromLookup,
  getProgressMessagesFromLookup,
  hasUnresolvedHooksFromLookup,
} from './messages/lookupAccessors.js'
export {
  mergeUserMessagesAndToolResults,
  mergeAssistantMessages,
  mergeUserMessages,
  mergeUserContentBlocks,
} from './messages/merge.js'
export {
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  filterOrphanedThinkingOnlyMessages,
  stripSignatureBlocks,
  stripAdvisorBlocks,
} from './messages/filters.js'
export { ensureToolResultPairing } from './messages/pairing.js'
export {
  stripToolReferenceBlocksFromUserMessage,
  stripCallerFieldFromAssistantMessage,
} from './messages/toolReferences.js'
export {
  reorderAttachmentsForAPI,
  normalizeMessagesForAPI,
} from './messages/apiNormalize.js'
export { PLAN_PHASE4_CONTROL } from './messages/planModeInstructions.js'
export { normalizeAttachmentForAPI } from './messages/attachmentNormalize.js'
export { handleMessageFromStream } from './messages/streaming.js'
export type {
  StreamingToolUse,
  StreamingThinking,
} from './messages/streaming.js'
