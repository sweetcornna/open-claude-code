import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import type { Dirent } from 'fs'
// Sync fs primitives for readFileTailSync — separate from fs/promises
// imports above. Named (not wildcard) per CLAUDE.md style; no collisions
// with the async-suffixed names.
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import {
  appendFile as fsAppendFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { builtInCommandNames } from '../commands.js'
import { COMMAND_NAME_TAG, TICK_TAG } from '../constants/xml.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import * as sessionIngress from '../services/api/sessionIngress.js'
import { REPL_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/REPLTool/constants.js'
import {
  type AgentId,
  asAgentId,
  asSessionId,
  type SessionId,
} from '../types/ids.js'
import type { AttributionSnapshotMessage } from '../types/logs.js'
import {
  type ContentReplacementEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type GoalState,
  type LogOption,
  type PersistedWorktreeSession,
  type SerializedMessage,
  sortLogs,
  type TranscriptMessage,
} from '../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'
import type { QueueOperationMessage } from '../types/messageQueueTypes.js'
import { uniq } from './array.js'
import { registerCleanup } from './cleanupRegistry.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getWorktreePaths } from './getWorktreePaths.js'
import { getBranch } from './git.js'
import { gracefulShutdownSync, isShuttingDown } from './gracefulShutdown.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { extractTag, isCompactBoundaryMessage } from './messages.js'
import { sanitizePath } from './path.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from './sessionStoragePortable.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { validateUuid } from './uuid.js'
import { MAX_CACHED_SESSION_FILES } from './sessionStorage/constants.js'
import {
  cleanMessagesForLogging,
  extractFirstPrompt,
  getFirstMeaningfulUserMessageTextContent,
  isChainParticipant,
  isLegacyProgressEntry,
  isTranscriptMessage,
  removeExtraFields,
  SKIP_FIRST_PROMPT_PATTERN,
} from './sessionStorage/entries.js'
import type { Transcript } from './sessionStorage/entries.js'
import { appendEntryToFile, readFileTailSync } from './sessionStorage/fileIO.js'
import {
  buildConversationChain,
  checkResumeConsistency,
} from './sessionStorage/conversationChain.js'
import {
  clearAgentTranscriptSubdir,
  deleteRemoteAgentMetadata,
  getAgentTranscriptPath,
  getEntrypoint,
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
import {
  getSessionMessages,
  getSessionMessagesCache,
  loadSessionFile,
  loadTranscriptFile,
} from './sessionStorage/transcriptLoader.js'

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

/**
 * O(n) single-pass: find the message with the latest timestamp matching a predicate.
 * Replaces the `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` pattern
 * which is O(n log n) + 2n Date allocations.
 */
function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * Builds a filie history snapshot chain from the conversation
 */
function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → last index in snapshots[] for O(1) update lookup
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * Builds an attribution snapshot chain from the conversation.
 * Unlike file history snapshots, attribution snapshots are returned in full
 * because they use generated UUIDs (not message UUIDs) and represent
 * cumulative state that should be restored on session resume.
 */
function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // Return all attribution snapshots - they will be merged during restore
  return Array.from(attributionSnapshots.values())
}

/**
 * Loads a transcript from a JSON or JSONL file and converts it to LogOption format
 * @param filePath Path to the transcript file (.json or .jsonl)
 * @returns LogOption containing the transcript messages
 * @throws Error if file doesn't exist or contains invalid data
 */
export async function loadTranscriptFromFile(
  filePath: string,
): Promise<LogOption> {
  if (filePath.endsWith('.jsonl')) {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      fileHistorySnapshots,
      attributionSnapshots,
      contentReplacements,
      worktreeStates,
      leafUuids,
    } = await loadTranscriptFile(filePath)

    if (messages.size === 0) {
      throw new Error('No messages found in JSONL file')
    }

    // Find the most recent leaf message using pre-computed leaf UUIDs
    const leafMessage = findLatestMessage(messages.values(), msg =>
      leafUuids.has(msg.uuid),
    )

    if (!leafMessage) {
      throw new Error('No valid conversation chain found in JSONL file')
    }

    // Build the conversation chain backwards from leaf to root
    const transcript = buildConversationChain(messages, leafMessage)

    const summary = summaries.get(leafMessage.uuid)
    const customTitle = customTitles.get(leafMessage.sessionId as UUID)
    const tag = tags.get(leafMessage.sessionId as UUID)
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...convertToLogOption(
        transcript,
        0,
        summary,
        customTitle,
        buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
        tag,
        filePath,
        buildAttributionSnapshotChain(attributionSnapshots, transcript),
        undefined,
        contentReplacements.get(sessionId) ?? [],
      ),
      worktreeSession: worktreeStates.has(sessionId)
        ? worktreeStates.get(sessionId)
        : undefined,
    }
  }

  // json log files
  const content = await readFile(filePath, { encoding: 'utf-8' })
  let parsed: unknown

  try {
    parsed = jsonParse(content)
  } catch (error) {
    throw new Error(`Invalid JSON in transcript file: ${error}`)
  }

  let messages: TranscriptMessage[]

  if (Array.isArray(parsed)) {
    messages = parsed
  } else if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
    if (!Array.isArray(parsed.messages)) {
      throw new Error('Transcript messages must be an array')
    }
    messages = parsed.messages
  } else {
    throw new Error(
      'Transcript must be an array of messages or an object with a messages array',
    )
  }

  return convertToLogOption(
    messages,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    filePath,
  )
}

/**
 * Checks if a user message has visible content (text or image, not just tool_result).
 * Tool results are displayed as part of collapsed groups, not as standalone messages.
 * Also excludes meta messages which are not shown to the user.
 */
function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') return false

  // Meta messages are not shown to the user
  if (message.isMeta) return false

  const content = message.message?.content
  if (!content) return false

  // String content is always visible
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  // Array content: check for text or image blocks (not tool_result)
  if (Array.isArray(content)) {
    return content.some(
      block =>
        block.type === 'text' ||
        block.type === 'image' ||
        block.type === 'document',
    )
  }

  return false
}

/**
 * Checks if an assistant message has visible text content (not just tool_use blocks).
 * Tool uses are displayed as grouped/collapsed UI elements, not as standalone messages.
 */
function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') return false

  const content = message.message?.content
  if (!content || !Array.isArray(content)) return false

  // Check for text block (not just tool_use/thinking blocks)
  return content.some(
    block =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

/**
 * Counts visible messages that would appear as conversation turns in the UI.
 * Excludes:
 * - System, attachment, and progress messages
 * - User messages with isMeta flag (hidden from user)
 * - User messages that only contain tool_result blocks (displayed as collapsed groups)
 * - Assistant messages that only contain tool_use blocks (displayed as collapsed groups)
 */
function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case 'user':
        // Count user messages with visible content (text, image, not just tool_result or meta)
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case 'assistant':
        // Count assistant messages with text content (not just tool_use)
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case 'attachment':
      case 'system':
      case 'progress':
        // These message types are not counted as visible conversation turns
        break
    }
  }
  return count
}

function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  // Get the first user message for the prompt
  const firstPrompt = extractFirstPrompt(transcript)

  // Create timestamps from message timestamps
  const created = new Date(firstMessage.timestamp)
  const modified = new Date(lastMessage.timestamp)

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created,
    modified,
    firstPrompt,
    messageCount: countVisibleMessages(transcript),
    isSidechain: firstMessage.isSidechain,
    teamName: firstMessage.teamName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots: fileHistorySnapshots,
    attributionSnapshots: attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}

async function trackSessionBranchingAnalytics(
  logs: LogOption[],
): Promise<void> {
  const sessionIdCounts = new Map<string, number>()
  let maxCount = 0
  for (const log of logs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const newCount = (sessionIdCounts.get(sessionId) || 0) + 1
      sessionIdCounts.set(sessionId, newCount)
      maxCount = Math.max(newCount, maxCount)
    }
  }

  // Early exit if no duplicates detected
  if (maxCount <= 1) {
    return
  }

  // Count sessions with branches and calculate stats using functional approach
  const branchCounts = Array.from(sessionIdCounts.values()).filter(c => c > 1)
  const sessionsWithBranches = branchCounts.length
  const totalBranches = branchCounts.reduce((sum, count) => sum + count, 0)

  logEvent('tengu_session_forked_branches_fetched', {
    total_sessions: sessionIdCounts.size,
    sessions_with_branches: sessionsWithBranches,
    max_branches_per_session: Math.max(...branchCounts),
    avg_branches_per_session: Math.round(totalBranches / sessionsWithBranches),
    total_transcript_count: logs.length,
  })
}

export async function fetchLogs(limit?: number): Promise<LogOption[]> {
  const projectDir = getProjectDir(getOriginalCwd())
  const logs = await getSessionFilesLite(projectDir, limit, getOriginalCwd())

  await trackSessionBranchingAnalytics(logs)

  return logs
}

/**
 * Extracts the session ID from a log.
 * For lite logs, uses the sessionId field directly.
 * For full logs, extracts from the first message.
 */
export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  // For lite logs, use the direct sessionId field
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  // Fall back to extracting from first message (full logs)
  return log.messages[0]?.sessionId as UUID | undefined
}

/**
 * Checks if a log is a lite log that needs full loading.
 * Lite logs have messages: [] and sessionId set.
 */
export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

/**
 * Loads full messages for a lite log by reading its JSONL file.
 * Returns a new LogOption with populated messages array.
 * If the log is already full or loading fails, returns the original log.
 */
export async function loadFullLog(log: LogOption): Promise<LogOption> {
  // If already full, return as-is
  if (!isLiteLog(log)) {
    return log
  }

  // Use the fullPath from the index entry directly
  const sessionFile = log.fullPath
  if (!sessionFile) {
    return log
  }

  try {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      agentNames,
      agentColors,
      agentSettings,
      prNumbers,
      prUrls,
      prRepositories,
      modes,
      worktreeStates,
      goals,
      fileHistorySnapshots,
      attributionSnapshots,
      contentReplacements,
      leafUuids,
    } = await loadTranscriptFile(sessionFile)

    if (messages.size === 0) {
      const fallbackGoal = log.sessionId
        ? goals.get(log.sessionId as UUID)
        : undefined
      return fallbackGoal ? { ...log, goal: fallbackGoal } : log
    }

    // Find the most recent user/assistant leaf message from the transcript
    const mostRecentLeaf = findLatestMessage(
      messages.values(),
      msg =>
        leafUuids.has(msg.uuid) &&
        (msg.type === 'user' || msg.type === 'assistant'),
    )
    if (!mostRecentLeaf) {
      const fallbackGoal = log.sessionId
        ? goals.get(log.sessionId as UUID)
        : undefined
      return fallbackGoal ? { ...log, goal: fallbackGoal } : log
    }

    // Build the conversation chain from this leaf
    const transcript = buildConversationChain(messages, mostRecentLeaf)
    // Leaf's sessionId — forked sessions copy chain[0] from the source, but
    // metadata entries (custom-title etc.) are keyed by the current session.
    const sessionId = mostRecentLeaf.sessionId as UUID | undefined
    return {
      ...log,
      messages: removeExtraFields(transcript),
      firstPrompt: extractFirstPrompt(transcript),
      messageCount: countVisibleMessages(transcript),
      summary: mostRecentLeaf
        ? summaries.get(mostRecentLeaf.uuid)
        : log.summary,
      customTitle: sessionId ? customTitles.get(sessionId) : log.customTitle,
      tag: sessionId ? tags.get(sessionId) : log.tag,
      agentName: sessionId ? agentNames.get(sessionId) : log.agentName,
      agentColor: sessionId ? agentColors.get(sessionId) : log.agentColor,
      agentSetting: sessionId ? agentSettings.get(sessionId) : log.agentSetting,
      mode: sessionId ? (modes.get(sessionId) as LogOption['mode']) : log.mode,
      worktreeSession:
        sessionId && worktreeStates.has(sessionId)
          ? worktreeStates.get(sessionId)
          : log.worktreeSession,
      goal: sessionId ? goals.get(sessionId) : log.goal,
      prNumber: sessionId ? prNumbers.get(sessionId) : log.prNumber,
      prUrl: sessionId ? prUrls.get(sessionId) : log.prUrl,
      prRepository: sessionId
        ? prRepositories.get(sessionId)
        : log.prRepository,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
      teamName: transcript[0]?.teamName ?? log.teamName,
      leafUuid: mostRecentLeaf?.uuid ?? log.leafUuid,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        transcript,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        transcript,
      ),
      contentReplacements: sessionId
        ? (contentReplacements.get(sessionId) ?? [])
        : log.contentReplacements,
    }
  } catch {
    // If loading fails, return the original log
    return log
  }
}

/**
 * Searches for sessions by custom title match.
 * Returns matches sorted by recency (newest first).
 * Uses case-insensitive matching for better UX.
 * Deduplicates by sessionId (keeps most recent per session).
 * Searches across same-repo worktrees by default.
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  // Use worktree-aware loading to search across same-repo sessions
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  // Enrich all logs to access customTitle metadata
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  // Deduplicate by sessionId - multiple logs can have the same sessionId
  // if they're different branches of the same conversation. Keep most recent.
  const sessionIdToLog = new Map<UUID, LogOption>()
  for (const log of matchingLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = sessionIdToLog.get(sessionId)
      if (!existing || log.modified > existing.modified) {
        sessionIdToLog.set(sessionId, log)
      }
    }
  }
  const deduplicated = Array.from(sessionIdToLog.values())

  // Sort by recency
  deduplicated.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  // Apply limit if specified
  if (limit) {
    return deduplicated.slice(0, limit)
  }

  return deduplicated
}

/**
 * Check if a message UUID exists in the session storage
 */
export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}

export async function getLastSessionLog(
  sessionId: UUID,
): Promise<LogOption | null> {
  // Single read: load all session data at once instead of reading the file twice
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentSettings,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    goals,
  } = await loadSessionFile(sessionId)
  if (messages.size === 0) return null
  // Prime getSessionMessages cache so recordTranscript (called after REPL
  // mount on --resume) skips a second full file load. -170~227ms on large sessions.
  // Guard: only prime if cache is empty. Mid-session callers (e.g. IssueFeedback)
  // may call getLastSessionLog on the current session — overwriting a live cache
  // with a stale disk snapshot would lose unflushed UUIDs and break dedup.
  const messagesCache = getSessionMessagesCache()
  if (!messagesCache.has(sessionId)) {
    messagesCache.set(sessionId, Promise.resolve(new Set(messages.keys())))
  }

  // Find the most recent non-sidechain message
  const lastMessage = findLatestMessage(messages.values(), m => !m.isSidechain)
  if (!lastMessage) return null

  // Build the transcript chain from the last message
  const transcript = buildConversationChain(messages, lastMessage)

  const summary = summaries.get(lastMessage.uuid)
  const customTitle = customTitles.get(lastMessage.sessionId as UUID)
  const tag = tags.get(lastMessage.sessionId as UUID)
  const agentSetting = agentSettings.get(sessionId)
  return {
    ...convertToLogOption(
      transcript,
      0,
      summary,
      customTitle,
      buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
      tag,
      getTranscriptPathForSession(sessionId),
      buildAttributionSnapshotChain(attributionSnapshots, transcript),
      agentSetting,
      contentReplacements.get(sessionId) ?? [],
    ),
    worktreeSession: worktreeStates.get(sessionId),
    goal: goals.get(sessionId),
  }
}

/**
 * Loads the list of message logs
 * @param limit Optional limit on number of session files to load
 * @returns List of message logs sorted by date
 */
export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const sessionLogs = await fetchLogs(limit)
  // fetchLogs returns lite (stat-only) logs — enrich them to get metadata.
  // enrichLogs already filters out sidechains, empty sessions, etc.
  const { logs: enriched } = await enrichLogs(
    sessionLogs,
    0,
    sessionLogs.length,
  )

  // enrichLogs returns fresh unshared objects — mutate in place to avoid
  // re-spreading every 30-field LogOption just to renumber the index.
  const sorted = sortLogs(enriched)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * Loads message logs from all project directories.
 * @param limit Optional limit on number of session files to load per project (used when no index exists)
 * @returns List of message logs sorted by date
 */
export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<LogOption[]> {
  if (options?.skipIndex) {
    // Load all sessions with full message data (e.g. for /insights analysis)
    return loadAllProjectsMessageLogsFull(limit)
  }
  const result = await loadAllProjectsMessageLogsProgressive(
    limit,
    options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT,
  )
  return result.logs
}

async function loadAllProjectsMessageLogsFull(
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const logsPerProject = await Promise.all(
    projectDirs.map(projectDir => getLogsWithoutIndex(projectDir, limit)),
  )
  const allLogs = logsPerProject.flat()

  // Deduplicate — same session+leaf can appear in multiple project dirs.
  // This path creates one LogOption per leaf, so use sessionId+leafUuid key.
  const deduped = new Map<string, LogOption>()
  for (const log of allLogs) {
    const key = `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`
    const existing = deduped.get(key)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(key, log)
    }
  }

  // deduped values are fresh from getLogsWithoutIndex — safe to mutate
  const sorted = sortLogs([...deduped.values()])
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { logs: [], allStatLogs: [], nextIndex: 0 }
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const rawLogs: LogOption[] = []
  for (const projectDir of projectDirs) {
    rawLogs.push(...(await getSessionFilesLite(projectDir, limit)))
  }
  // Deduplicate — same session can appear in multiple project dirs
  const sorted = deduplicateLogsBySessionId(rawLogs)

  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)

  // enrichLogs returns fresh unshared objects — safe to mutate in place
  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs: sorted, nextIndex }
}

/**
 * Loads message logs from all worktrees of the same git repository.
 * Falls back to loadMessageLogs if no worktrees provided.
 *
 * Uses pure filesystem metadata for fast loading.
 *
 * @param worktreePaths Array of worktree paths (from getWorktreePaths)
 * @param limit Optional limit on number of session files to load per project
 * @returns List of message logs sorted by date
 */
/**
 * Result of loading session logs with progressive enrichment support.
 */
export type SessionLogResult = {
  /** Enriched logs ready for display */
  logs: LogOption[]
  /** Full stat-only list for progressive loading (call enrichLogs to get more) */
  allStatLogs: LogOption[]
  /** Index into allStatLogs where progressive loading should continue from */
  nextIndex: number
}

export async function loadSameRepoMessageLogs(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const result = await loadSameRepoMessageLogsProgressive(
    worktreePaths,
    limit,
    initialEnrichCount,
  )
  return result.logs
}

export async function loadSameRepoMessageLogsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  logForDebugging(
    `/resume: loading sessions for cwd=${getOriginalCwd()}, worktrees=[${worktreePaths.join(', ')}]`,
  )
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  logForDebugging(`/resume: found ${allStatLogs.length} session files on disk`)

  const { logs, nextIndex } = await enrichLogs(
    allStatLogs,
    0,
    initialEnrichCount,
  )

  // enrichLogs returns fresh unshared objects — safe to mutate in place
  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs, nextIndex }
}

/**
 * Gets stat-only logs for worktree paths (no file reads).
 */
async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  if (worktreePaths.length <= 1) {
    const cwd = getOriginalCwd()
    const projectDir = getProjectDir(cwd)
    return getSessionFilesLite(projectDir, undefined, cwd)
  }

  // On Windows, drive letter case can differ between git worktree list
  // output (e.g. C:/Users/...) and how paths were stored in project
  // directories (e.g. c:/Users/...). Use case-insensitive comparison.
  const caseInsensitive = process.platform === 'win32'

  // Sort worktree paths by sanitized prefix length (longest first) so
  // more specific matches take priority over shorter ones. Without this,
  // a short prefix like -code-myrepo could match -code-myrepo-worktree1
  // before the longer, more specific prefix gets a chance.
  const indexed = worktreePaths.map(wt => {
    const sanitized = sanitizePath(wt)
    return {
      path: wt,
      prefix: caseInsensitive ? sanitized.toLowerCase() : sanitized,
    }
  })
  indexed.sort((a, b) => b.prefix.length - a.prefix.length)

  const allLogs: LogOption[] = []
  const seenDirs = new Set<string>()

  let allDirents: Dirent[]
  try {
    allDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch (e) {
    // Fall back to current project
    logForDebugging(
      `Failed to read projects dir ${projectsDir}, falling back to current project: ${e}`,
    )
    const projectDir = getProjectDir(getOriginalCwd())
    return getSessionFilesLite(projectDir, limit, getOriginalCwd())
  }

  for (const dirent of allDirents) {
    if (!dirent.isDirectory()) continue
    const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
    if (seenDirs.has(dirName)) continue

    for (const { path: wtPath, prefix } of indexed) {
      if (dirName === prefix || dirName.startsWith(prefix + '-')) {
        seenDirs.add(dirName)
        allLogs.push(
          ...(await getSessionFilesLite(
            join(projectsDir, dirent.name),
            undefined,
            wtPath,
          )),
        )
        break
      }
    }
  }

  // Deduplicate by sessionId — the same session can appear in multiple
  // worktree project dirs. Keep the entry with the newest modified time.
  return deduplicateLogsBySessionId(allLogs)
}

/**
 * Retrieves the transcript for a specific agent by agentId.
 * Directly loads the agent-specific transcript file.
 * @param agentId The agent ID to search for
 * @returns The conversation chain and budget replacement records for the agent,
 *          or null if not found
 */
export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const agentFile = getAgentTranscriptPath(agentId)

  try {
    const { messages, agentContentReplacements } =
      await loadTranscriptFile(agentFile)

    // Find messages with matching agentId
    const agentMessages = Array.from(messages.values()).filter(
      msg => msg.agentId === agentId && msg.isSidechain,
    )

    if (agentMessages.length === 0) {
      return null
    }

    // Find the most recent leaf message with this agentId
    const parentUuids = new Set(agentMessages.map(msg => msg.parentUuid))
    const leafMessage = findLatestMessage(
      agentMessages,
      msg => !parentUuids.has(msg.uuid),
    )

    if (!leafMessage) {
      return null
    }

    // Build the conversation chain
    const transcript = buildConversationChain(messages, leafMessage)

    // Filter to only include messages with this agentId
    const agentTranscript = transcript.filter(msg => msg.agentId === agentId)

    return {
      // Convert TranscriptMessage[] to Message[]
      messages: agentTranscript.map(
        ({ isSidechain, parentUuid, ...msg }) => msg,
      ),
      contentReplacements: agentContentReplacements.get(agentId) ?? [],
    }
  } catch {
    return null
  }
}

/**
 * Extract agent IDs from progress messages in the conversation.
 * Agent/skill progress messages have type 'progress' with data.type
 * 'agent_progress' or 'skill_progress' and data.agentId.
 * This captures sync agents that emit progress messages during execution.
 */
export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  const agentIds: string[] = []

  for (const message of messages) {
    if (
      message.type === 'progress' &&
      message.data &&
      typeof message.data === 'object' &&
      'type' in message.data &&
      (message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress') &&
      'agentId' in message.data &&
      typeof message.data.agentId === 'string'
    ) {
      agentIds.push(message.data.agentId)
    }
  }

  return uniq(agentIds)
}

/**
 * Extract teammate transcripts directly from AppState tasks.
 * In-process teammates store their messages in task.messages,
 * which is more reliable than loading from disk since each teammate turn
 * uses a random agentId for transcript storage.
 */
export function extractTeammateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const transcripts: { [agentId: string]: Message[] } = {}

  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.identity?.agentId &&
      task.messages &&
      task.messages.length > 0
    ) {
      transcripts[task.identity.agentId] = task.messages
    }
  }

  return transcripts
}

/**
 * Load subagent transcripts for the given agent IDs
 */
export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const results = await Promise.all(
    agentIds.map(async agentId => {
      try {
        const result = await getAgentTranscript(asAgentId(agentId))
        if (result && result.messages.length > 0) {
          return { agentId, transcript: result.messages }
        }
        return null
      } catch {
        // Skip if transcript can't be loaded
        return null
      }
    }),
  )

  const transcripts: { [agentId: string]: Message[] } = {}
  for (const result of results) {
    if (result) {
      transcripts[result.agentId] = result.transcript
    }
  }
  return transcripts
}

// Globs the session's subagents dir directly — unlike AppState.tasks, this survives task eviction.
export async function loadAllSubagentTranscriptsFromDisk(): Promise<{
  [agentId: string]: Message[]
}> {
  const subagentsDir = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    getSessionId(),
    'subagents',
  )
  let entries: Dirent[]
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch {
    return {}
  }
  // Filename format is the inverse of getAgentTranscriptPath() — keep in sync.
  const agentIds = entries
    .filter(
      d =>
        d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'),
    )
    .map(d => d.name.slice('agent-'.length, -'.jsonl'.length))
  return loadSubagentTranscripts(agentIds)
}

/**
 * Gets a log by its index
 * @param index Index in the sorted list of logs (0-based)
 * @returns Log data or null if not found
 */
export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

/**
 * Looks up unresolved tool uses in the transcript by tool_use_id.
 * Returns the assistant message containing the tool_use, or null if not found
 * or the tool call already has a tool_result.
 */
export async function findUnresolvedToolUse(
  toolUseId: string,
): Promise<AssistantMessage | null> {
  try {
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    let toolUseMessage = null

    // Find the tool use but make sure there's not also a result
    for (const message of messages.values()) {
      if (message.type === 'assistant') {
        const content = message.message!.content
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type: string; id: string }>) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
              toolUseMessage = message
              break
            }
          }
        }
      } else if (message.type === 'user') {
        const content = message.message!.content
        if (Array.isArray(content)) {
          for (const block of content as Array<{
            type: string
            tool_use_id: string
          }>) {
            if (
              block.type === 'tool_result' &&
              block.tool_use_id === toolUseId
            ) {
              // Found tool result, bail out
              return null
            }
          }
        }
      }
    }

    return toolUseMessage as AssistantMessage | null
  } catch {
    return null
  }
}

/**
 * Gets all session JSONL files in a project directory with their stats.
 * Returns a map of sessionId → {path, mtime, ctime, size}.
 * Stats are batched via Promise.all to avoid serial syscalls in the hot loop.
 */
export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  const sessionFilesMap = new Map<
    string,
    { path: string; mtime: number; ctime: number; size: number }
  >()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectDir, { withFileTypes: true })
  } catch {
    // Directory doesn't exist - return empty map
    return sessionFilesMap
  }

  const candidates: Array<{ sessionId: string; filePath: string }> = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    const sessionId = validateUuid(basename(dirent.name, '.jsonl'))
    if (!sessionId) continue
    candidates.push({ sessionId, filePath: join(projectDir, dirent.name) })
  }

  await Promise.all(
    candidates.map(async ({ sessionId, filePath }) => {
      try {
        const st = await stat(filePath)
        sessionFilesMap.set(sessionId, {
          path: filePath,
          mtime: st.mtime.getTime(),
          ctime: st.birthtime.getTime(),
          size: st.size,
        })
      } catch {
        logForDebugging(`Failed to stat session file: ${filePath}`)
      }
    }),
  )

  return sessionFilesMap
}

/**
 * Number of sessions to enrich on the initial load of the resume picker.
 * Each enrichment reads up to 128 KB per file (head + tail), so 50 sessions
 * means ~6.4 MB of I/O — fast on any modern filesystem while giving users
 * a much better initial view than the previous default of 10.
 */
const INITIAL_ENRICH_COUNT = 50

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/**
 * Loads all logs from a single session file with full message data.
 * Builds a LogOption for each leaf message in the file.
 */
export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    leafUuids,
  } = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })

  if (messages.size === 0) return []

  const leafMessages: TranscriptMessage[] = []
  // Build parentUuid → children index once (O(n)), so trailing-message lookup is O(1) per leaf
  const childrenByParent = new Map<UUID, TranscriptMessage[]>()
  for (const msg of messages.values()) {
    if (leafUuids.has(msg.uuid)) {
      leafMessages.push(msg)
    } else if (msg.parentUuid) {
      const siblings = childrenByParent.get(msg.parentUuid)
      if (siblings) {
        siblings.push(msg)
      } else {
        childrenByParent.set(msg.parentUuid, [msg])
      }
    }
  }

  const logs: LogOption[] = []

  for (const leafMessage of leafMessages) {
    const chain = buildConversationChain(messages, leafMessage)
    if (chain.length === 0) continue

    // Append trailing messages that are children of the leaf
    const trailingMessages = childrenByParent.get(leafMessage.uuid)
    if (trailingMessages) {
      // ISO-8601 UTC timestamps are lexically sortable
      trailingMessages.sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      )
      chain.push(...trailingMessages)
    }

    const firstMessage = chain[0]!
    const sessionId = leafMessage.sessionId as UUID

    logs.push({
      date: leafMessage.timestamp,
      messages: removeExtraFields(chain),
      fullPath: sessionFile,
      value: 0,
      created: new Date(firstMessage.timestamp),
      modified: new Date(leafMessage.timestamp),
      firstPrompt: extractFirstPrompt(chain),
      messageCount: countVisibleMessages(chain),
      isSidechain: firstMessage.isSidechain ?? false,
      sessionId,
      leafUuid: leafMessage.uuid,
      summary: summaries.get(leafMessage.uuid),
      customTitle: customTitles.get(sessionId),
      tag: tags.get(sessionId),
      agentName: agentNames.get(sessionId),
      agentColor: agentColors.get(sessionId),
      agentSetting: agentSettings.get(sessionId),
      mode: modes.get(sessionId) as LogOption['mode'],
      prNumber: prNumbers.get(sessionId),
      prUrl: prUrls.get(sessionId),
      prRepository: prRepositories.get(sessionId),
      gitBranch: leafMessage.gitBranch,
      projectPath: projectPathOverride ?? firstMessage.cwd,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        chain,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        chain,
      ),
      contentReplacements: contentReplacements.get(sessionId) ?? [],
    })
  }

  return logs
}

/**
 * Gets logs by loading all session files fully, bypassing the session index.
 * Use this when you need full message data (e.g., for /insights analysis).

 */
async function getLogsWithoutIndex(
  projectDir: string,
  limit?: number,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)
  if (sessionFilesMap.size === 0) return []

  // If limit specified, only load N most recent files by mtime
  let filesToProcess: Array<{ path: string; mtime: number }>
  if (limit && sessionFilesMap.size > limit) {
    filesToProcess = [...sessionFilesMap.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } else {
    filesToProcess = [...sessionFilesMap.values()]
  }

  const logs: LogOption[] = []
  for (const fileInfo of filesToProcess) {
    try {
      const fileLogOptions = await loadAllLogsFromSessionFile(fileInfo.path)
      logs.push(...fileLogOptions)
    } catch {
      logForDebugging(`Failed to load session file: ${fileInfo.path}`)
    }
  }

  return logs
}

/**
 * Reads the first and last ~64KB of a JSONL file and extracts lite metadata.
 *
 * Head (first 64KB): isSidechain, projectPath, teamName, firstPrompt.
 * Tail (last 64KB): customTitle, tag, PR link, latest gitBranch.
 *
 * Accepts a shared buffer to avoid per-file allocation overhead.
 */
async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buf)
  if (!head) return { firstPrompt: '', isSidechain: false }

  // Extract stable metadata from the first line via string search.
  // Works even when the first line is truncated (>64KB message).
  const isSidechain =
    head.includes('"isSidechain":true') || head.includes('"isSidechain": true')
  const projectPath = extractJsonStringField(head, 'cwd')
  const teamName = extractJsonStringField(head, 'teamName')
  const agentSetting = extractJsonStringField(head, 'agentSetting')

  // Prefer the last-prompt tail entry — captured by extractFirstPrompt at
  // write time (filtered, authoritative) and shows what the user was most
  // recently doing. Head scan is the fallback for sessions written before
  // last-prompt entries existed. Raw string scrapes of head are last resort
  // and catch array-format content blocks (VS Code <ide_selection> metadata).
  const firstPrompt =
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractFirstPromptFromChunk(head) ||
    extractJsonStringFieldPrefix(head, 'content', 200) ||
    extractJsonStringFieldPrefix(head, 'text', 200) ||
    ''

  // Extract tail metadata via string search (last occurrence wins).
  // User titles (customTitle field, from custom-title entries) win over
  // AI titles (aiTitle field, from ai-title entries). The distinct field
  // names mean extractLastJsonStringField naturally disambiguates.
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractLastJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractLastJsonStringField(head, 'aiTitle')
  const summary = extractLastJsonStringField(tail, 'summary')
  const tag = extractLastJsonStringField(tail, 'tag')
  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ??
    extractJsonStringField(head, 'gitBranch')

  // PR link fields — prNumber is a number not a string, so try both
  const prUrl = extractLastJsonStringField(tail, 'prUrl')
  const prRepository = extractLastJsonStringField(tail, 'prRepository')
  let prNumber: number | undefined
  const prNumStr = extractLastJsonStringField(tail, 'prNumber')
  if (prNumStr) {
    prNumber = parseInt(prNumStr, 10) || undefined
  }
  if (!prNumber) {
    const prNumMatch = tail.lastIndexOf('"prNumber":')
    if (prNumMatch >= 0) {
      const afterColon = tail.slice(prNumMatch + 11, prNumMatch + 25)
      const num = parseInt(afterColon.trim(), 10)
      if (num > 0) prNumber = num
    }
  }

  return {
    firstPrompt,
    gitBranch,
    isSidechain,
    projectPath,
    teamName,
    customTitle,
    summary,
    tag,
    agentSetting,
    prNumber,
    prUrl,
    prRepository,
  }
}

/**
 * Scans a chunk of text for the first meaningful user prompt.
 */
function extractFirstPromptFromChunk(chunk: string): string {
  let start = 0
  let hasTickMessages = false
  let firstCommandFallback = ''
  while (start < chunk.length) {
    const newlineIdx = chunk.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? chunk.slice(start, newlineIdx) : chunk.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : chunk.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue
    }
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue

    try {
      const entry = jsonParse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      // Collect all text values from the message content. For array content
      // (common in VS Code where IDE metadata tags come before the user's
      // actual prompt), iterate all text blocks so we don't miss the real
      // prompt hidden behind <ide_selection>/<ide_opened_file> blocks.
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text as string)
          }
        }
      }

      for (const text of texts) {
        if (!text) continue

        let result = text.replace(/\n/g, ' ').trim()

        // Skip command messages (slash commands) but remember the first one
        // as a fallback title. Matches skip logic in
        // getFirstMeaningfulUserMessageTextContent, but instead of discarding
        // command messages entirely, we format them cleanly (e.g. "/clear")
        // so the session still appears in the resume picker.
        const commandNameTag = extractTag(result, COMMAND_NAME_TAG)
        if (commandNameTag) {
          const name = commandNameTag.replace(/^\//, '')
          const commandArgs = extractTag(result, 'command-args')?.trim() || ''
          if (builtInCommandNames().has(name) || !commandArgs) {
            if (!firstCommandFallback) {
              firstCommandFallback = commandNameTag
            }
            continue
          }
          // Custom command with meaningful args — use clean display
          return commandArgs
            ? `${commandNameTag} ${commandArgs}`
            : commandNameTag
        }

        // Format bash input with ! prefix before the generic XML skip
        const bashInput = extractTag(result, 'bash-input')
        if (bashInput) return `! ${bashInput}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
          if (
            (feature('PROACTIVE') || feature('KAIROS')) &&
            result.startsWith(`<${TICK_TAG}>`)
          )
            hasTickMessages = true
          continue
        }
        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '…'
        }
        return result
      }
    } catch {}
  }
  // Session started with a slash command but had no subsequent real message —
  // use the clean command name so the session still appears in the resume picker
  if (firstCommandFallback) return firstCommandFallback
  // Proactive sessions have only tick messages — give them a synthetic prompt
  // so they're not filtered out by enrichLogs
  if ((feature('PROACTIVE') || feature('KAIROS')) && hasTickMessages)
    return 'Proactive session'
  return ''
}

/**
 * Like extractJsonStringField but returns the first `maxLen` characters of the
 * value even when the closing quote is missing (truncated buffer). Newline
 * escapes are replaced with spaces and the result is trimmed.
 */
function extractJsonStringFieldPrefix(
  text: string,
  key: string,
  maxLen: number,
): string {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    // Grab up to maxLen characters from the value, stopping at closing quote
    let i = valueStart
    let collected = 0
    while (i < text.length && collected < maxLen) {
      if (text[i] === '\\') {
        i += 2 // skip escaped char
        collected++
        continue
      }
      if (text[i] === '"') break
      i++
      collected++
    }
    const raw = text.slice(valueStart, i)
    return raw.replace(/\\n/g, ' ').replace(/\\t/g, ' ').trim()
  }
  return ''
}

/**
 * Deduplicates logs by sessionId, keeping the entry with the newest
 * modified time. Returns sorted logs with sequential value indices.
 */
function deduplicateLogsBySessionId(logs: LogOption[]): LogOption[] {
  const deduped = new Map<string, LogOption>()
  for (const log of logs) {
    if (!log.sessionId) continue
    const existing = deduped.get(log.sessionId)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(log.sessionId, log)
    }
  }
  return sortLogs([...deduped.values()]).map((log, i) => ({
    ...log,
    value: i,
  }))
}

/**
 * Returns lite LogOption[] from pure filesystem metadata (stat only).
 * No file reads — instant. Call `enrichLogs` to enrich
 * visible sessions with firstPrompt, gitBranch, customTitle, etc.
 */
export async function getSessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)

  // Sort by mtime descending and apply limit
  let entries = [...sessionFilesMap.entries()].sort(
    (a, b) => b[1].mtime - a[1].mtime,
  )
  if (limit && entries.length > limit) {
    entries = entries.slice(0, limit)
  }

  const logs: LogOption[] = []

  for (const [sessionId, fileInfo] of entries) {
    logs.push({
      date: new Date(fileInfo.mtime).toISOString(),
      messages: [],
      isLite: true,
      fullPath: fileInfo.path,
      value: 0,
      created: new Date(fileInfo.ctime),
      modified: new Date(fileInfo.mtime),
      firstPrompt: '',
      messageCount: 0,
      fileSize: fileInfo.size,
      isSidechain: false,
      sessionId,
      projectPath,
    })
  }

  // logs are freshly pushed above — safe to mutate in place
  const sorted = sortLogs(logs)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * Enriches a lite log with metadata from its JSONL file.
 * Returns the enriched log, or null if the log has no meaningful content
 * (no firstPrompt, no customTitle — e.g., metadata-only session files).
 */
async function enrichLog(
  log: LogOption,
  readBuf: Buffer,
): Promise<LogOption | null> {
  if (!log.isLite || !log.fullPath) return log

  const meta = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)

  const enriched: LogOption = {
    ...log,
    isLite: false,
    firstPrompt: meta.firstPrompt,
    gitBranch: meta.gitBranch,
    isSidechain: meta.isSidechain,
    teamName: meta.teamName,
    customTitle: meta.customTitle,
    summary: meta.summary,
    tag: meta.tag,
    agentSetting: meta.agentSetting,
    prNumber: meta.prNumber,
    prUrl: meta.prUrl,
    prRepository: meta.prRepository,
    projectPath: meta.projectPath ?? log.projectPath,
  }

  // Provide a fallback title for sessions where we couldn't extract the first
  // prompt (e.g., large first messages that exceed the 16KB read buffer).
  // Previously these sessions were silently dropped, making them inaccessible
  // via /resume after crashes or large-context sessions.
  if (!enriched.firstPrompt && !enriched.customTitle) {
    enriched.firstPrompt = '(session)'
  }
  // Filter: skip sidechains and agent sessions
  if (enriched.isSidechain) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: isSidechain=true`,
    )
    return null
  }
  if (enriched.teamName) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: teamName=${enriched.teamName}`,
    )
    return null
  }

  return enriched
}

/**
 * Enriches enough lite logs from `allLogs` (starting at `startIndex`) to
 * produce `count` valid results. Returns the valid enriched logs and the
 * index where scanning stopped (for progressive loading to continue from).
 */
export async function enrichLogs(
  allLogs: LogOption[],
  startIndex: number,
  count: number,
): Promise<{ logs: LogOption[]; nextIndex: number }> {
  const result: LogOption[] = []
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  let i = startIndex

  while (i < allLogs.length && result.length < count) {
    const log = allLogs[i]!
    i++

    const enriched = await enrichLog(log, readBuf)
    if (enriched) {
      result.push(enriched)
    }
  }

  const scanned = i - startIndex
  const filtered = scanned - result.length
  if (filtered > 0) {
    logForDebugging(
      `/resume: enriched ${scanned} sessions, ${filtered} filtered out, ${result.length} visible (${allLogs.length - i} remaining on disk)`,
    )
  }

  return { logs: result, nextIndex: i }
}
