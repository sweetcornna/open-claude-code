import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { relative } from 'path'
import { getCwd } from 'src/utils/filesystem/cwd.js'
import { addInvokedSkill } from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import type {
  AttributionSnapshotMessage,
  LogOption,
  PersistedWorktreeSession,
  SerializedMessage,
} from '../../types/logs.js'
import type {
  Message,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../../types/message.js'
import { PERMISSION_MODES } from '../../types/permissions.js'
import {
  suppressNextSkillDiscovery,
  suppressNextSkillListing,
} from '../attachments.js'
import {
  copyFileHistoryForResume,
  type FileHistorySnapshot,
} from '../filesystem/fileHistory.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logError } from '../telemetry/log.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessages,
} from '../messages.js'
import { copyPlanForResume } from '../agents/plans.js'
import { processSessionStartHooks } from './sessionStart.js'
import {
  buildConversationChain,
  checkResumeConsistency,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFile,
  removeExtraFields,
} from '../sessionStorage.js'
import type { ContentReplacementRecord } from '../tools/toolResultStorage.js'

// Dead code elimination: ant-only tool names are conditionally required so
// their strings don't leak into external builds. Static imports always bundle.
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@open-claude-code/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@open-claude-code/builtin-tools/tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const LEGACY_BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@open-claude-code/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@open-claude-code/builtin-tools/tools/BriefTool/prompt.js')
      ).LEGACY_BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('@open-claude-code/builtin-tools/tools/SendUserFileTool/prompt.js') as typeof import('@open-claude-code/builtin-tools/tools/SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

const DERIVED_UUID_PREFIX_LENGTH = 24
const PERSISTED_OUTPUT_PREFIX = '<persisted-output>'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Checks the attachment fields that recovery and API normalization access
 * without further guards. Unknown attachment types are deliberately accepted:
 * transcripts can outlive the build that introduced an attachment.
 */
export function isWellFormedAttachmentPayload(
  attachment: unknown,
): attachment is { type: string; [key: string]: unknown } {
  if (
    !isRecord(attachment) ||
    !('type' in attachment) ||
    typeof attachment.type !== 'string'
  ) {
    return false
  }

  switch (attachment.type) {
    case 'invoked_skills':
      return (
        Array.isArray(attachment.skills) &&
        attachment.skills.every(skill => isRecord(skill))
      )
    case 'hook_success':
      return typeof attachment.content === 'string'
    case 'skill_listing':
      return typeof attachment.content === 'string'
    case 'hook_additional_context':
      return (
        Array.isArray(attachment.content) &&
        attachment.content.every(item => typeof item === 'string')
      )
    default:
      return true
  }
}

/** Drop attachment entries whose payload cannot be safely restored. */
export function dropMalformedAttachments(messages: Message[]): Message[] {
  let dropped = false
  const filtered = messages.filter(message => {
    if (
      message.type === 'attachment' &&
      !isWellFormedAttachmentPayload(message.attachment)
    ) {
      dropped = true
      return false
    }
    return true
  })
  return dropped ? filtered : messages
}

/**
 * Remove messages retracted by model-refusal fallback. UUIDs are compared by
 * the stable 24-character prefix used by deriveUUID, so split/normalized
 * descendants of a retracted message are removed as well. System bookkeeping
 * messages, including the fallback marker itself, remain in the transcript.
 */
export function dropRetractedMessages(messages: Message[]): Message[] {
  const retractedUuidPrefixes = new Set<string>()
  for (const message of messages) {
    if (
      message.type !== 'system' ||
      message.subtype !== 'model_refusal_fallback' ||
      !Array.isArray(message.retractedMessageUuids)
    ) {
      continue
    }
    for (const uuid of message.retractedMessageUuids) {
      if (typeof uuid === 'string') {
        retractedUuidPrefixes.add(uuid.slice(0, DERIVED_UUID_PREFIX_LENGTH))
      }
    }
  }

  if (retractedUuidPrefixes.size === 0) return messages
  return messages.filter(
    message =>
      message.type === 'system' ||
      !retractedUuidPrefixes.has(
        message.uuid.slice(0, DERIVED_UUID_PREFIX_LENGTH),
      ),
  )
}

/**
 * Drop interrupted-stream text blocks whose text payload is not a string. The
 * enclosing message and all provider-specific fields are retained when any
 * valid content remains; a message made empty by the repair is removed.
 */
function dropMalformedTextBlocks(messages: Message[]): Message[] {
  let changed = false
  const repaired: Message[] = []

  for (const message of messages) {
    if (message.type !== 'assistant' && message.type !== 'user') {
      repaired.push(message)
      continue
    }

    const content = message.message?.content
    if (!Array.isArray(content)) {
      repaired.push(message)
      continue
    }

    const filteredContent = content.filter(block => {
      if (!isRecord(block) || block.type !== 'text') return true
      return typeof block.text === 'string'
    })
    if (filteredContent.length === content.length) {
      repaired.push(message)
      continue
    }

    changed = true
    if (filteredContent.length === 0) continue
    repaired.push({
      ...message,
      message: {
        ...message.message,
        content: filteredContent,
      },
    })
  }

  return changed ? repaired : messages
}

function normalizeSessionStartHookContent(content: string): string {
  if (!content.startsWith(PERSISTED_OUTPUT_PREFIX)) return content
  return content.replace(/(Full output saved to: ).*$/m, '$1<persisted>')
}

function getSessionStartHookMessageKeys(message: Message): string[] {
  if (message.type !== 'attachment') return []
  const attachment = message.attachment
  if (
    !isWellFormedAttachmentPayload(attachment) ||
    attachment.hookEvent !== 'SessionStart'
  ) {
    return []
  }

  switch (attachment.type) {
    case 'hook_additional_context':
      return (attachment.content as string[]).map(
        normalizeSessionStartHookContent,
      )
    case 'hook_success': {
      const content = attachment.content as string
      return content === '' ? [] : [normalizeSessionStartHookContent(content)]
    }
    case 'hook_non_blocking_error':
      return [
        `${attachment.command ?? ''}\0${attachment.exitCode}\0${attachment.stderr}`,
      ]
    default:
      return []
  }
}

/**
 * Keep only SessionStart hook output not already present in the restored
 * transcript. Additional-context batches are filtered item-by-item so one new
 * context is not lost merely because another context in the batch is old.
 */
export function dedupeSessionStartHookMessages(
  existingMessages: Message[],
  hookMessages: Message[],
): Message[] {
  if (hookMessages.length === 0) return []

  const existingKeys = new Set<string>()
  for (const message of existingMessages) {
    for (const key of getSessionStartHookMessageKeys(message)) {
      existingKeys.add(key)
    }
  }
  if (existingKeys.size === 0) return [...hookMessages]

  let hasNewSessionStartOutput = false
  const deduped: Message[] = []
  for (const message of hookMessages) {
    const keys = getSessionStartHookMessageKeys(message)
    if (keys.length === 0 || message.type !== 'attachment') {
      deduped.push(message)
      continue
    }

    const attachment = message.attachment!
    if (
      attachment.type === 'hook_additional_context' &&
      (attachment.content as string[]).length > 1
    ) {
      const content = (attachment.content as string[]).filter(
        item => !existingKeys.has(normalizeSessionStartHookContent(item)),
      )
      if (content.length === 0) continue
      hasNewSessionStartOutput = true
      deduped.push(
        content.length === (attachment.content as string[]).length
          ? message
          : ({
              ...message,
              attachment: { ...attachment, content },
            } as Message),
      )
      continue
    }

    if (existingKeys.has(keys[0]!)) continue
    hasNewSessionStartOutput = true
    deduped.push(message)
  }

  return hasNewSessionStartOutput ? deduped : []
}

/**
 * Transforms legacy attachment types to current types for backward compatibility
 */
function migrateLegacyAttachmentTypes(message: Message): Message {
  if (message.type !== 'attachment') {
    return message
  }

  const attachment = message.attachment as {
    type: string
    [key: string]: unknown
  } // Handle legacy types not in current type system

  // Transform legacy attachment types
  if (attachment.type === 'new_file') {
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'file',
        displayPath: relative(getCwd(), attachment.filename as string),
      },
    } as unknown as SerializedMessage // Cast entire message since we know the structure is correct
  }

  if (attachment.type === 'new_directory') {
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'directory',
        displayPath: relative(getCwd(), attachment.path as string),
      },
    } as unknown as SerializedMessage // Cast entire message since we know the structure is correct
  }

  // Backfill displayPath for attachments from old sessions
  if (!('displayPath' in attachment)) {
    const path =
      'filename' in attachment
        ? (attachment.filename as string)
        : 'path' in attachment
          ? (attachment.path as string)
          : 'skillDir' in attachment
            ? (attachment.skillDir as string)
            : undefined
    if (path) {
      return {
        ...message,
        attachment: {
          ...attachment,
          displayPath: relative(getCwd(), path),
        },
      } as unknown as Message
    }
  }

  return message
}

export type TeleportRemoteResponse = {
  log: Message[]
  branch?: string
}

export type TurnInterruptionState =
  | { kind: 'none' }
  | {
      kind: 'interrupted_prompt'
      message: NormalizedUserMessage
      /**
       * The transcript tail this offer was made against — the uuid the NEXT
       * resume compares against to notice it is being asked to replay the same
       * turn. Whoever acts on the offer persists it (see `saveResumeAnchor`).
       *
       * Carried on the state rather than as a separate return value because
       * only an offer has one, and it must be the tail as it stood BEFORE the
       * synthetic continuation was appended — recomputing it downstream, after
       * the continuation and sentinel are in the array, would name the wrong
       * message.
       */
      resumeAnchorUuid?: string
    }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

export type ResumeDropGuardResult = { ok: true } | { ok: false; reason: string }

const RESUME_FURNITURE_ATTACHMENTS = new Set([
  'agent_listing_delta',
  'agent_mention',
  'already_read_file',
  'attention_budget',
  'auto_mode',
  'auto_mode_exit',
  'budget_usd',
  'command_permissions',
  'compact_file_reference',
  'context_efficiency',
  'critical_system_reminder',
  'date_change',
  'deferred_tools_delta',
  'diagnostics',
  'directory',
  'dynamic_skill',
  'edited_image_file',
  'edited_text_file',
  'file',
  'goal_status',
  'hook_additional_context',
  'hook_blocking_error',
  'hook_cancelled',
  'hook_error_during_execution',
  'hook_non_blocking_error',
  'hook_permission_decision',
  'hook_stopped_continuation',
  'hook_success',
  'hook_system_message',
  'invoked_skills',
  'max_turns_reached',
  'mcp_dropped_tools_delta',
  'mcp_instructions_delta',
  'mcp_resource',
  'memory_update',
  'nested_memory',
  'opened_file_in_ide',
  'output_style',
  'output_token_usage',
  'pdf_reference',
  'plan_file_reference',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'read_truncation_notice',
  'relevant_memories',
  'selected_lines_in_diff',
  'selected_lines_in_ide',
  'skill_listing',
  'structured_output',
  'task_reminder',
  'team_context',
  'teammate_shutdown_batch',
  'todo_reminder',
  'token_usage',
  'tool_search_usage_reminder',
  'total_tokens_reminder',
  'ultrathink_effort',
  'workflow_keyword_request',
  'workflow_size_guideline_change',
])

function messageOriginIsLocal(message: Message): boolean {
  const origin = message.origin as unknown
  if (origin === undefined) return true
  if (typeof origin === 'object' && origin !== null) {
    const kind = (origin as { kind?: unknown }).kind
    return kind === 'human' || kind === 'auto-continuation'
  }
  return origin === 'human' || origin === 'auto-continuation'
}

function onlyToolResults(message: Message): boolean {
  const content = message.message?.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      block =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    )
  )
}

function describeResumeEntry(message: Message, index: number): string {
  const attachment =
    message.type === 'attachment' ? ` (${message.attachment?.type})` : ''
  return `entry ${index} [type=${message.type}${attachment}, uuid=${message.uuid}]`
}

function isSkippableBeforeResumeTurn(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = message.message?.content
    return (
      Array.isArray(content) &&
      content.length === 1 &&
      content[0]?.type === 'text' &&
      content[0].text === NO_RESPONSE_REQUESTED
    )
  }
  if (message.type === 'system' || message.type === 'progress') return true
  if (message.type === 'attachment') {
    return (
      message.attachment?.type !== 'queued_command' &&
      message.attachment?.type !== 'mcp_resource' &&
      message.attachment?.type !== 'structured_output' &&
      RESUME_FURNITURE_ATTACHMENTS.has(message.attachment?.type ?? '')
    )
  }
  if (message.type !== 'user' || !messageOriginIsLocal(message)) return false
  return (
    message.isCompactSummary !== true &&
    message.isMeta === true &&
    message.promptSource === undefined
  )
}

export function validateResumeDropRange(
  discardedMessages: Message[],
  turnId: string,
): ResumeDropGuardResult {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      turnId,
    )
  ) {
    return { ok: false, reason: `declared turn id is not a UUID: ${turnId}` }
  }
  let start = 0
  while (
    start < discardedMessages.length &&
    isSkippableBeforeResumeTurn(discardedMessages[start]!)
  ) {
    start++
  }
  if (start === discardedMessages.length) return { ok: true }

  const first = discardedMessages[start]!
  if (first.type !== 'user' || first.uuid !== turnId) {
    return {
      ok: false,
      reason: `range does not start with the declared turn prompt; first discarded ${describeResumeEntry(first, start)}`,
    }
  }
  if (
    first.isMeta === true ||
    first.isCompactSummary === true ||
    first.stackedExpansion === true ||
    onlyToolResults(first)
  ) {
    return {
      ok: false,
      reason: `declared turn id names a non-prompt user entry; ${describeResumeEntry(first, start)}`,
    }
  }
  if (!messageOriginIsLocal(first)) {
    return {
      ok: false,
      reason: `declared turn id names an externally-sourced entry; ${describeResumeEntry(first, start)}`,
    }
  }

  for (let index = start + 1; index < discardedMessages.length; index++) {
    const message = discardedMessages[index]!
    if (
      message.type === 'assistant' ||
      message.type === 'system' ||
      message.type === 'progress'
    ) {
      continue
    }
    if (message.type === 'attachment') {
      if (message.attachment?.type === 'queued_command') {
        return {
          ok: false,
          reason: `range contains absorbed queued content; ${describeResumeEntry(message, index)}`,
        }
      }
      if (!RESUME_FURNITURE_ATTACHMENTS.has(message.attachment?.type ?? '')) {
        return {
          ok: false,
          reason: `range contains a non-furniture attachment; ${describeResumeEntry(message, index)}`,
        }
      }
      continue
    }
    if (message.type === 'user') {
      if (message.uuid === turnId) continue
      if (message.isCompactSummary === true) {
        return {
          ok: false,
          reason: `range contains a compaction summary; ${describeResumeEntry(message, index)}`,
        }
      }
      if (!messageOriginIsLocal(message)) {
        return {
          ok: false,
          reason: `range contains an externally-sourced user entry; ${describeResumeEntry(message, index)}`,
        }
      }
      if (
        message.stackedExpansion === true ||
        onlyToolResults(message) ||
        (message.isMeta === true && message.promptSource === undefined)
      ) {
        continue
      }
      if (message.isMeta === true) {
        return {
          ok: false,
          reason: `range contains a system-injected turn prompt; ${describeResumeEntry(message, index)}`,
        }
      }
      return {
        ok: false,
        reason: `range contains a user entry not attributable to the declared turn; ${describeResumeEntry(message, index)}`,
      }
    }
    return {
      ok: false,
      reason: `range contains an unrecognized entry; ${describeResumeEntry(message, index)}`,
    }
  }
  return { ok: true }
}

/**
 * Deserializes messages from a log file into the format expected by the REPL.
 * Filters unresolved tool uses, orphaned thinking messages, and appends a
 * synthetic assistant sentinel when the last message is from the user.
 * @internal Exported for testing - use loadConversationForResume instead
 */
export function deserializeMessages(serializedMessages: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serializedMessages).messages
}

/**
 * Fallback age above which an interrupted turn is no longer auto-continued.
 *
 * Auto-continuation runs tools and writes files with no human present. Doing
 * that to a turn that was abandoned days ago is not "resuming work", it is
 * replaying stale intent into a workspace that has since moved on — so the
 * gate is on by default here and `0` turns it off.
 *
 * (Upstream reads the same env var but treats *unset* as "no age limit"; occ
 * deliberately defaults it on. The parsing, the `0` escape hatch and the
 * suppression behavior are otherwise identical.)
 */
const RESUME_INTERRUPTED_TURN_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Max age for auto-continuation, or undefined when the gate is disabled.
 * A garbage value falls back to the default rather than disabling the gate —
 * a typo must not silently remove the guard.
 */
function resumeInterruptedTurnMaxAgeMs(): number | undefined {
  const raw = process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS
  if (raw === undefined || raw.trim() === '') {
    return RESUME_INTERRUPTED_TURN_DEFAULT_MAX_AGE_MS
  }
  const parsed = Number(raw)
  if (parsed === 0) return undefined
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : RESUME_INTERRUPTED_TURN_DEFAULT_MAX_AGE_MS
}

/** Parse a persisted timestamp (ISO string or epoch ms) to epoch ms. */
function parseMessageTimestamp(timestamp: unknown): number {
  if (typeof timestamp === 'number') return timestamp
  if (typeof timestamp === 'string') return Date.parse(timestamp)
  return NaN
}

/**
 * True when the newest turn-relevant message is older than the configured
 * max age — i.e. this transcript has been sitting untouched and should not
 * be auto-continued.
 *
 * System and progress entries are skipped for the same reason
 * detectTurnInterruption skips them: they are bookkeeping that can be written
 * long after the turn itself and would make an old transcript look fresh.
 *
 * A transcript with no parseable timestamp anywhere counts as stale: the age
 * cannot be established, and the whole point of the gate is to not act
 * unattended on a turn whose age is unknown.
 */
function isInterruptedTurnStale(messages: NormalizedMessage[]): boolean {
  const maxAgeMs = resumeInterruptedTurnMaxAgeMs()
  if (maxAgeMs === undefined) return false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.type === 'system' || message.type === 'progress') continue
    const parsed = parseMessageTimestamp(message.timestamp)
    if (Number.isFinite(parsed)) return Date.now() - parsed >= maxAgeMs
  }
  return true
}

/**
 * The prompt injected to continue an interrupted turn. Overridable so a
 * harness that resumes on the user's behalf can say something more specific
 * than the generic default.
 */
export function getResumePrompt(): string {
  return (
    process.env.CLAUDE_CODE_RESUME_PROMPT || 'Continue from where you left off.'
  )
}

export type InterruptDetectionOptions = {
  /**
   * UUID of the last user/assistant message that a previous pass already
   * offered a continuation for. When the transcript still ends on that exact
   * message, the continuation was either already injected or already declined,
   * and offering it a second time would replay the same turn.
   *
   * Persisted as a `resume-anchor` entry in the session log; callers that have
   * no such anchor (a transcript written before that entry existed, or a
   * `--resume <path>.jsonl` load that never builds a LogOption) simply omit it
   * and get the age gate alone.
   */
  resumeAnchorUuid?: string
}

/**
 * Like deserializeMessages, but also detects whether the session was
 * interrupted mid-turn. Used by the SDK resume path to auto-continue
 * interrupted turns after a gateway-triggered restart.
 *
 * Three things can suppress the continuation, and all three matter because the
 * consumer of `interrupted_prompt` runs it unattended:
 *   1. the turn is older than the max age (see isInterruptedTurnStale),
 *   2. the transcript still ends on `resumeAnchorUuid`,
 *   3. no interruption was detected at all.
 * @internal Exported for testing
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
  options?: InterruptDetectionOptions,
): DeserializeResult {
  try {
    // Clean transcript corruption before migrations or the existing API-shape
    // filters access attachment/content fields.
    const unretractedMessages = dropRetractedMessages(serializedMessages)
    const wellFormedMessages = dropMalformedAttachments(unretractedMessages)
    const repairedMessages = dropMalformedTextBlocks(wellFormedMessages)

    // Transform legacy attachment types before processing
    const migratedMessages = repairedMessages.map(migrateLegacyAttachmentTypes)

    // Strip invalid permissionMode values from deserialized user messages.
    // The field is unvalidated JSON from disk and may contain modes from a different build.
    const validModes = new Set<string>(PERMISSION_MODES)
    for (const msg of migratedMessages) {
      if (
        msg.type === 'user' &&
        msg.permissionMode !== undefined &&
        !validModes.has(msg.permissionMode as string)
      ) {
        msg.permissionMode = undefined
      }
    }

    // Filter out unresolved tool uses and any synthetic messages that follow them
    const filteredToolUses = filterUnresolvedToolUses(
      migratedMessages,
    ) as NormalizedMessage[]

    // Filter out orphaned thinking-only assistant messages that can cause API errors
    // during resume. These occur when streaming yields separate messages per content
    // block and interleaved user messages prevent proper merging by message.id.
    const filteredThinking = filterOrphanedThinkingOnlyMessages(
      filteredToolUses,
    ) as NormalizedMessage[]

    // Filter out assistant messages with only whitespace text content.
    // This can happen when model outputs "\n\n" before thinking, user cancels mid-stream.
    const filteredMessages = filterWhitespaceOnlyAssistantMessages(
      filteredThinking,
    ) as NormalizedMessage[]

    const internalState = detectTurnInterruption(filteredMessages)

    // The transcript tail as it stands before any continuation is appended.
    // Both the "already offered" comparison and the anchor handed back for the
    // next resume must name this exact message.
    const tailUuid =
      internalState.kind === 'none'
        ? undefined
        : filteredMessages.findLast(
            m => m.type === 'user' || m.type === 'assistant',
          )?.uuid

    // Already offered for this exact tail — re-offering would replay the turn.
    const alreadyOfferedForAnchor =
      options?.resumeAnchorUuid !== undefined &&
      internalState.kind !== 'none' &&
      tailUuid === options.resumeAnchorUuid

    // Too old to act on unattended. Checked after detection (not before) so the
    // suppression event records which kind of interruption was withheld.
    const staleTurn =
      !alreadyOfferedForAnchor &&
      internalState.kind !== 'none' &&
      isInterruptedTurnStale(filteredMessages)
    if (staleTurn) {
      logEvent('tengu_resume_stale_turn_suppressed', {
        kind: internalState.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    // Transform mid-turn interruptions into interrupted_prompt by appending
    // a synthetic continuation message. This unifies both interruption kinds
    // so the consumer only needs to handle interrupted_prompt.
    let turnInterruptionState: TurnInterruptionState
    if (alreadyOfferedForAnchor || staleTurn) {
      // Suppressed: no continuation message is appended, so the sentinel logic
      // below sees the transcript exactly as a non-interrupted one.
      turnInterruptionState = { kind: 'none' }
    } else if (internalState.kind === 'interrupted_turn') {
      const [continuationMessage] = normalizeMessages([
        createUserMessage({
          content: getResumePrompt(),
          isMeta: true,
        }),
      ])
      filteredMessages.push(continuationMessage!)
      turnInterruptionState = {
        kind: 'interrupted_prompt',
        message: continuationMessage!,
        resumeAnchorUuid: tailUuid,
      }
    } else if (internalState.kind === 'interrupted_prompt') {
      turnInterruptionState = { ...internalState, resumeAnchorUuid: tailUuid }
    } else {
      turnInterruptionState = internalState
    }

    // Append a synthetic assistant sentinel after the last user message so
    // the conversation is API-valid if no resume action is taken. Skip past
    // trailing system/progress messages and insert right after the user
    // message so removeInterruptedMessage's splice(idx, 2) removes the
    // correct pair.
    const lastRelevantIdx = filteredMessages.findLastIndex(
      m => m.type !== 'system' && m.type !== 'progress',
    )
    if (
      lastRelevantIdx !== -1 &&
      filteredMessages[lastRelevantIdx]!.type === 'user'
    ) {
      filteredMessages.splice(
        lastRelevantIdx + 1,
        0,
        createAssistantMessage({
          content: NO_RESPONSE_REQUESTED,
        }) as NormalizedMessage,
      )
    }

    return { messages: filteredMessages, turnInterruptionState }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}

/**
 * Internal 3-way result from detection, before transforming interrupted_turn
 * into interrupted_prompt with a synthetic continuation message.
 */
type InternalInterruptionState =
  | TurnInterruptionState
  | { kind: 'interrupted_turn' }

/**
 * Determines whether the conversation was interrupted mid-turn based on the
 * last message after filtering. An assistant as last message (after filtering
 * unresolved tool_uses) is treated as a completed turn because stop_reason is
 * not a dependable interruption signal on persisted messages: the streaming
 * path records each record at content_block_stop and only backfills
 * stop_reason when message_delta arrives, so a record whose transcript flush
 * won that race is persisted with `null` even though the turn completed.
 *
 * System and progress messages are skipped when finding the last turn-relevant
 * message — they are bookkeeping artifacts that should not mask a genuine
 * interruption. Attachments are kept as part of the turn.
 */
function detectTurnInterruption(
  messages: NormalizedMessage[],
): InternalInterruptionState {
  if (messages.length === 0) {
    return { kind: 'none' }
  }

  // Find the last turn-relevant message, skipping system/progress and
  // synthetic API error assistants. Error assistants are already filtered
  // before API send (normalizeMessagesForAPI) — skipping them here lets
  // auto-resume fire after retry exhaustion instead of reading the error as
  // a completed turn.
  const lastMessageIdx = messages.findLastIndex(
    m =>
      m.type !== 'system' &&
      m.type !== 'progress' &&
      !(m.type === 'assistant' && m.isApiErrorMessage),
  )
  const lastMessage =
    lastMessageIdx !== -1 ? messages[lastMessageIdx] : undefined

  if (!lastMessage) {
    return { kind: 'none' }
  }

  if (lastMessage.type === 'assistant') {
    // stop_reason cannot decide this. The streaming path records a message at
    // content_block_stop and backfills stop_reason on message_delta, so a
    // persisted `null` means "the flush beat the backfill", not "the turn was
    // cut short". After filterUnresolvedToolUses has removed assistant messages
    // with unmatched tool_uses, an assistant as the last message means the turn
    // most likely completed normally.
    return { kind: 'none' }
  }

  if (lastMessage.type === 'user') {
    if (lastMessage.isMeta || lastMessage.isCompactSummary) {
      return { kind: 'none' }
    }
    if (isToolUseResultMessage(lastMessage)) {
      // Brief mode (#20467) drops the trailing assistant text block, so a
      // completed brief-mode turn legitimately ends on SendUserMessage's
      // tool_result. Without this check, resume misclassifies every
      // brief-mode session as interrupted mid-turn and injects a phantom
      // "Continue from where you left off." before the user's real next
      // prompt. Look back one step for the originating tool_use.
      if (isTerminalToolResult(lastMessage, messages, lastMessageIdx)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    // Plain text user prompt — CC hadn't started responding
    return {
      kind: 'interrupted_prompt',
      message: lastMessage as NormalizedUserMessage,
    }
  }

  if (lastMessage.type === 'attachment') {
    // Attachments are part of the user turn — the user provided context but
    // the assistant never responded.
    return { kind: 'interrupted_turn' }
  }

  return { kind: 'none' }
}

/**
 * Is this tool_result the output of a tool that legitimately terminates a
 * turn? SendUserMessage is the canonical case: in brief mode, calling it is
 * the turn's final act — there is no follow-up assistant text (#20467
 * removed it). A transcript ending here means the turn COMPLETED, not that
 * it was killed mid-tool.
 *
 * Walks back to find the assistant tool_use that this result belongs to and
 * checks its name. The matching tool_use is typically the immediately
 * preceding relevant message (filterUnresolvedToolUses has already dropped
 * unpaired ones), but we walk just in case system/progress noise is
 * interleaved.
 */
function isTerminalToolResult(
  result: NormalizedUserMessage,
  messages: NormalizedMessage[],
  resultIdx: number,
): boolean {
  const content = result.message.content
  if (!Array.isArray(content)) return false
  const block = content[0]
  if (block?.type !== 'tool_result') return false
  const toolUseId = block.tool_use_id

  for (let i = resultIdx - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    const msgContent = msg.message!.content
    if (!Array.isArray(msgContent)) continue
    for (const b of msgContent) {
      if (
        typeof b !== 'string' &&
        'type' in b &&
        b.type === 'tool_use' &&
        'id' in b &&
        b.id === toolUseId
      ) {
        return (
          ('name' in b ? b.name : undefined) === BRIEF_TOOL_NAME ||
          ('name' in b ? b.name : undefined) === LEGACY_BRIEF_TOOL_NAME ||
          ('name' in b ? b.name : undefined) === SEND_USER_FILE_TOOL_NAME
        )
      }
    }
  }
  return false
}

/**
 * Restores skill state from invoked_skills attachments in messages.
 * This ensures that skills are preserved across resume after compaction.
 * Without this, if another compaction happens after resume, the skills would be lost
 * because STATE.invokedSkills would be empty.
 * @internal Exported for testing - use loadConversationForResume instead
 */
export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (
      message.type !== 'attachment' ||
      !isWellFormedAttachmentPayload(message.attachment)
    ) {
      continue
    }
    if (message.attachment.type === 'invoked_skills') {
      const skills = message.attachment.skills as Array<{
        name?: string
        path?: string
        content?: string
      }>
      for (const skill of skills) {
        if (skill.name && skill.path && skill.content) {
          // Resume only happens for the main session, so agentId is null
          addInvokedSkill(skill.name, skill.path, skill.content, null)
        }
      }
    }
    // A prior process already injected the skills-available reminder — it's
    // in the transcript the model is about to see. sentSkillNames is
    // process-local, so without this every resume re-announces the same
    // ~600 tokens. Fire-once latch; consumed on the first attachment pass.
    if (message.attachment.type === 'skill_listing') {
      suppressNextSkillListing()
    }
  }

  // Unconditionally suppress skill_listing and skill_discovery on resume.
  // Attachments are not persisted to transcript for non-ant users
  // (isLoggableMessage filters them out), so the per-type checks above may
  // never find them even though the prior process already injected the content
  // into the conversation via <system-reminder> blocks. Without this, every
  // resume re-injects ~1K tokens of duplicate content and busts the Anthropic
  // prompt cache prefix (which requires 100% byte-identical segments).
  suppressNextSkillListing()
  suppressNextSkillDiscovery()
}

/**
 * Chain-walk a transcript jsonl by path.  Same sequence loadFullLog
 * runs internally — loadTranscriptFile → find newest non-sidechain
 * leaf → buildConversationChain → removeExtraFields — just starting
 * from an arbitrary path instead of the sid-derived one.
 *
 * leafUuids is populated by loadTranscriptFile as "uuids that no
 * other message's parentUuid points at" — the chain tips.  There can
 * be several (sidechains, orphans); newest non-sidechain is the main
 * conversation's end.
 */
export async function loadMessagesFromJsonlPath(path: string): Promise<{
  messages: SerializedMessage[]
  sessionId: UUID | undefined
}> {
  const { messages: byUuid, leafUuids } = await loadTranscriptFile(path)
  let tip: (typeof byUuid extends Map<UUID, infer T> ? T : never) | null = null
  let tipTs = 0
  for (const m of byUuid.values()) {
    if (m.isSidechain || !leafUuids.has(m.uuid)) continue
    const ts = new Date(m.timestamp).getTime()
    if (ts > tipTs) {
      tipTs = ts
      tip = m
    }
  }
  if (!tip) return { messages: [], sessionId: undefined }
  const chain = buildConversationChain(byUuid, tip)
  return {
    messages: removeExtraFields(chain),
    // Leaf's sessionId — forked sessions copy chain[0] from the source
    // transcript, so the root retains the source session's ID. Matches
    // loadFullLog's mostRecentLeaf.sessionId.
    sessionId: tip.sessionId as UUID | undefined,
  }
}

/**
 * Loads a conversation for resume from various sources.
 * This is the centralized function for loading and deserializing conversations.
 *
 * @param source - The source to load from:
 *   - undefined: load most recent conversation
 *   - string: session ID to load
 *   - LogOption: already loaded conversation
 * @param sourceJsonlFile - Alternate: path to a transcript jsonl.
 *   Used when --resume receives a .jsonl path (cli/print.ts routes
 *   on suffix), typically for cross-directory resume where the
 *   transcript lives outside the current project dir.
 * @returns Object containing the deserialized messages and the original log, or null if not found
 */
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  sessionId: UUID | undefined
  // Session metadata for restoring agent context
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  // Full path to the session file (for cross-directory resume)
  fullPath?: string
  // Goal state for hydration on resume
  goal?: import('../../types/logs.js').GoalState
} | null> {
  try {
    let log: LogOption | null = null
    let messages: Message[] | null = null
    let sessionId: UUID | undefined

    if (source === undefined) {
      // --continue: most recent session, skipping live --bg/daemon sessions
      // that are actively writing their own transcript.
      const logsPromise = loadMessageLogs()
      let skip = new Set<string>()
      if (feature('BG_SESSIONS')) {
        try {
          const { listAllLiveSessions } = await import(
            './concurrentSessions.js'
          )
          const live = await listAllLiveSessions()
          skip = new Set(
            live.flatMap(s =>
              s.kind && s.kind !== 'interactive' && s.sessionId
                ? [s.sessionId]
                : [],
            ),
          )
        } catch {
          // UDS unavailable — treat all sessions as continuable
        }
      }
      const logs = await logsPromise
      log =
        logs.find(l => {
          const id = getSessionIdFromLog(l)
          return !id || !skip.has(id)
        }) ?? null
    } else if (sourceJsonlFile) {
      // --resume with a .jsonl path (cli/print.ts routes on suffix).
      // Same chain walk as the sid branch below — only the starting
      // path differs.
      const loaded = await loadMessagesFromJsonlPath(sourceJsonlFile)
      messages = loaded.messages
      sessionId = loaded.sessionId
    } else if (typeof source === 'string') {
      // Load specific session by ID
      log = await getLastSessionLog(source as UUID)
      sessionId = source as UUID
    } else {
      // Already have a LogOption
      log = source
    }

    if (!log && !messages) {
      return null
    }

    if (log) {
      // Load full messages for lite logs
      if (isLiteLog(log)) {
        log = await loadFullLog(log)
      }

      // Determine sessionId first so we can pass it to copy functions
      if (!sessionId) {
        sessionId = getSessionIdFromLog(log) as UUID
      }
      // Pass the original session ID to ensure the plan slug is associated with
      // the session we're resuming, not the temporary session ID before resume
      if (sessionId) {
        await copyPlanForResume(log, asSessionId(sessionId))
      }

      // Copy file history for resume
      void copyFileHistoryForResume(log)

      messages = log.messages
      checkResumeConsistency(messages)
    }

    // Clean entries before restoreSkillStateFromMessages dereferences attachment
    // payloads. deserializeMessages repeats these idempotent passes because it is
    // also called directly by SDK, teleport, and agent-resume paths.
    messages = dropMalformedAttachments(dropRetractedMessages(messages!))

    // Restore skill state from invoked_skills attachments before deserialization.
    // This ensures skills survive multiple compaction cycles after resume.
    restoreSkillStateFromMessages(messages)

    // Deserialize messages to handle unresolved tool uses and ensure proper
    // format. The anchor comes off the log, so a `--resume <path>.jsonl` load
    // (which never builds a LogOption) and any transcript written before the
    // `resume-anchor` entry existed both pass undefined and fall back to the
    // age gate alone — same behaviour as before this was wired.
    const deserialized = deserializeMessagesWithInterruptDetection(messages, {
      resumeAnchorUuid: log?.resumeAnchorUuid,
    })
    messages = deserialized.messages

    // Process session start hooks for resume
    const hookMessages = await processSessionStartHooks('resume', { sessionId })

    // Append only SessionStart output not already persisted by an earlier
    // resume. Hooks still execute so their non-message side effects are kept.
    messages.push(...dedupeSessionStartHookMessages(messages, hookMessages))

    return {
      messages,
      turnInterruptionState: deserialized.turnInterruptionState,
      fileHistorySnapshots: log?.fileHistorySnapshots,
      attributionSnapshots: log?.attributionSnapshots,
      contentReplacements: log?.contentReplacements,
      sessionId,
      // Include session metadata for restoring agent context on resume
      agentName: log?.agentName,
      agentColor: log?.agentColor,
      agentSetting: log?.agentSetting,
      customTitle: log?.customTitle,
      tag: log?.tag,
      mode: log?.mode,
      worktreeSession: log?.worktreeSession,
      prNumber: log?.prNumber,
      prUrl: log?.prUrl,
      prRepository: log?.prRepository,
      // Include full path for cross-directory resume
      fullPath: log?.fullPath,
      // Goal state for hydration on resume
      goal: log?.goal,
    }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}
