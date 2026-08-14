/**
 * Barrel over src/utils/sessionStorage/. Every runtime and type export below
 * used to live in this file. Keep re-exports explicit because the
 * characterization test pins the complete runtime surface.
 */
export {
  cleanMessagesForLogging,
  getFirstMeaningfulUserMessageTextContent,
  isChainParticipant,
  isEphemeralToolProgress,
  isLoggableMessage,
  isTranscriptMessage,
  removeExtraFields,
} from './sessionStorage/entries.js'
export {
  buildConversationChain,
  checkResumeConsistency,
} from './sessionStorage/conversationChain.js'
export {
  clearAgentTranscriptSubdir,
  deleteRemoteAgentMetadata,
  getAgentTranscriptPath,
  getNodeEnv,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  getUserType,
  isCustomTitleEnabled,
  listRemoteAgentMetadata,
  MAX_TRANSCRIPT_READ_BYTES,
  readAgentMetadata,
  readRemoteAgentMetadata,
  sessionIdExists,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
  writeRemoteAgentMetadata,
} from './sessionStorage/paths.js'
export type {
  AgentMetadata,
  RemoteAgentMetadata,
} from './sessionStorage/paths.js'
export {
  clearSessionMessagesCache,
  getSessionMessages,
  getSessionMessagesCache,
  loadTranscriptFile,
} from './sessionStorage/transcriptLoader.js'
export {
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
} from './sessionStorage/hydration.js'
export {
  cacheSessionTitle,
  clearGoalEntry,
  clearSessionMetadata,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  linkSessionToPR,
  reAppendSessionMetadata,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveGoal,
  saveMode,
  saveResumeAnchor,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
} from './sessionStorage/sessionMetadata.js'
export {
  adoptResumedSessionFile,
  flushSessionStorage,
  recordAttributionSnapshot,
  recordContentReplacement,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  removeTranscriptMessage,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  resetSessionFilePointer,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
} from './sessionStorage/transcriptWriter.js'
export type { TeamInfo } from './sessionStorage/transcriptWriter.js'
export {
  doesMessageExistInSession,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadTranscriptFromFile,
} from './sessionStorage/logAssembly.js'
export {
  enrichLogs,
  getSessionFilesLite,
  getSessionFilesWithMtime,
  loadAllLogsFromSessionFile,
} from './sessionStorage/sessionDiscovery.js'
export {
  fetchLogs,
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadMessageLogs,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  searchSessionsByCustomTitle,
} from './sessionStorage/sessionListing.js'
export type { SessionLogResult } from './sessionStorage/sessionListing.js'
export {
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  getAgentTranscript,
  loadAllSubagentTranscriptsFromDisk,
  loadSubagentTranscripts,
} from './sessionStorage/agentTranscripts.js'
export {
  findUnresolvedToolUse,
  getLogByIndex,
} from './sessionStorage/queries.js'
