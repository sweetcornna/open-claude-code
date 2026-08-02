/**
 * Barrel over src/utils/attachments/. Every runtime and type export below used
 * to live in this file. Keep the re-exports explicit: roughly 100 importers and
 * the characterization test both pin this path and runtime surface.
 */
export {
  AUTO_MODE_ATTACHMENT_CONFIG,
  PLAN_MODE_ATTACHMENT_CONFIG,
  RELEVANT_MEMORIES_CONFIG,
  TODO_REMINDER_CONFIG,
  VERIFY_PLAN_REMINDER_CONFIG,
} from './attachments/config.js'
export type {
  AgentMentionAttachment,
  AlreadyReadFileAttachment,
  AsyncHookResponseAttachment,
  Attachment,
  CompactFileReferenceAttachment,
  FileAttachment,
  HookAttachment,
  HookCancelledAttachment,
  HookErrorDuringExecutionAttachment,
  HookNonBlockingErrorAttachment,
  HookPermissionDecisionAttachment,
  HookSuccessAttachment,
  HookSystemMessageAttachment,
  PDFReferenceAttachment,
  TeamContextAttachment,
  TeammateMailboxAttachment,
} from './attachments/types.js'
export {
  getDirectoriesToProcess,
  memoryFilesToAttachments,
} from './attachments/directories.js'
export {
  extractAgentMentions,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  parseAtMentionedFileLines,
} from './attachments/mentions.js'
export { getChangedFiles } from './attachments/changedFiles.js'
export {
  generateFileAttachment,
  tryGetPDFReference,
} from './attachments/files.js'
export {
  getAgentPendingMessageAttachments,
  getQueuedCommandAttachments,
} from './attachments/queue.js'
export { getDateChangeAttachments } from './attachments/modes.js'
export {
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from './attachments/deltas.js'
export { collectRecentSuccessfulTools } from './attachments/history.js'
export {
  getCompactionReminderAttachment,
  getVerifyPlanReminderTurnCount,
} from './attachments/usage.js'
export {
  collectSurfacedMemories,
  filterDuplicateMemoryAttachments,
  memoryHeader,
  readMemoriesForSurfacing,
  startRelevantMemoryPrefetch,
} from './attachments/memories.js'
export type { MemoryPrefetch } from './attachments/memories.js'
export {
  filterToBundledAndMcp,
  suppressNextSkillListing,
} from './attachments/skills.js'
export {
  getAttachments,
  resetSentSkillNames,
  suppressNextSkillDiscovery,
} from './attachments/orchestrator.js'
export {
  createAttachmentMessage,
  getAttachmentMessages,
} from './attachments/messages.js'
