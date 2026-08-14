import type { UUID } from 'crypto'
import { readFile } from 'fs/promises'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import {
  type FileHistorySnapshotMessage,
  type LogOption,
  type TranscriptMessage,
} from '../../types/logs.js'
import type { FileHistorySnapshot } from '../filesystem/fileHistory.js'
import { jsonParse } from '../telemetry/slowOperations.js'
import type { ContentReplacementRecord } from '../tools/toolResultStorage.js'
import { extractFirstPrompt, removeExtraFields } from './entries.js'
import { buildConversationChain } from './conversationChain.js'
import { getTranscriptPathForSession } from './paths.js'
import {
  getSessionMessages,
  getSessionMessagesCache,
  loadSessionFile,
  loadTranscriptFile,
} from './transcriptLoader.js'

/**
 * O(n) single-pass: find the message with the latest timestamp matching a predicate.
 * Replaces the `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` pattern
 * which is O(n log n) + 2n Date allocations.
 */
export function findLatestMessage<T extends { timestamp: string }>(
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
export function buildFileHistorySnapshotChain(
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
export function buildAttributionSnapshotChain(
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
export function countVisibleMessages(transcript: TranscriptMessage[]): number {
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

export function convertToLogOption(
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
      resumeAnchors,
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
      resumeAnchorUuid: sessionId
        ? resumeAnchors.get(sessionId)
        : log.resumeAnchorUuid,
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
    resumeAnchors,
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
    resumeAnchorUuid: resumeAnchors.get(sessionId),
  }
}
