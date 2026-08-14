/**
 * The API-bound normalization pipeline: attachment reordering, per-message
 * strip/merge passes and the final repair passes run before a request.
 */
import type {
  ContentBlockParam,
  TextBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import last from 'lodash-es/last.js'
import { toolMatchesName, type Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../../services/api/errors.js'
import { normalizeToolInputForAPI } from '../telemetry/api.js'
import { type Attachment } from '../attachments.js'
import { validateImagesForAPI } from '../terminal/imageValidation.js'
import { isSearchExtraToolsEnabledOptimistic } from '../tools/searchExtraTools.js'
import { normalizeAttachmentForAPI } from './attachmentNormalize.js'
import { SYNTHETIC_MODEL } from './constants.js'
import { createUserMessage } from './constructors.js'
import {
  ensureNonEmptyAssistantContent,
  filterOrphanedThinkingOnlyMessages,
  filterTrailingThinkingFromLastAssistant,
  filterWhitespaceOnlyAssistantMessages,
} from './filters.js'
import {
  mergeAssistantMessages,
  mergeUserMessages,
  mergeUserMessageRun,
  mergeUserMessagesAndToolResults,
  smooshSystemReminderSiblings,
} from './merge.js'
import { isSystemLocalCommandMessage } from './predicates.js'
import { collectMissingReadTruncationBanners } from './readTruncationReminder.js'
import { deriveShortMessageId, wrapInSystemReminder } from './text.js'
import {
  contentHasToolReference,
  relocateToolReferenceSiblings,
  stripToolReferenceBlocksFromUserMessage,
  stripUnavailableToolReferencesFromUserMessage,
} from './toolReferences.js'

const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

function isSyntheticApiErrorMessage(
  message: Message,
): message is AssistantMessage & { isApiErrorMessage: true } {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    message.message?.model === SYNTHETIC_MODEL
  )
}

/**
 * Reorders messages so that attachments bubble up until they hit either:
 * - A tool call result (user message with tool_result content)
 * - Any assistant message
 */
export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  // We build `result` backwards (push) and reverse once at the end — O(N).
  // Using unshift inside the loop would be O(N²).
  const result: Message[] = []
  // Attachments are pushed as we encounter them scanning bottom-up, so
  // this buffer holds them in reverse order (relative to the input array).
  const pendingAttachments: AttachmentMessage[] = []

  // Scan from the bottom up
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!

    if (message.type === 'attachment') {
      // Collect attachment to bubble up
      pendingAttachments.push(message as AttachmentMessage)
    } else {
      // Check if this is a stopping point
      const isStoppingPoint =
        message.type === 'assistant' ||
        (message.type === 'user' &&
          Array.isArray(message.message?.content) &&
          (message.message?.content as Array<{ type: string }>)[0]?.type ===
            'tool_result')

      if (isStoppingPoint && pendingAttachments.length > 0) {
        // Hit a stopping point — attachments stop here (go after the stopping point).
        // pendingAttachments is already reversed; after the final result.reverse()
        // they will appear in original order right after `message`.
        for (let j = 0; j < pendingAttachments.length; j++) {
          result.push(pendingAttachments[j]!)
        }
        result.push(message)
        pendingAttachments.length = 0
      } else {
        // Regular message
        result.push(message)
      }
    }
  }

  // Any remaining attachments bubble all the way to the top.
  for (let j = 0; j < pendingAttachments.length; j++) {
    result.push(pendingAttachments[j]!)
  }

  result.reverse()
  return result
}

/**
 * Appends a [id:...] message ID tag to the last text block of a user message.
 * Only mutates the API-bound copy, not the stored message.
 * This lets Claude reference message IDs when calling the snip tool.
 */
function appendMessageTagToUserMessage(message: UserMessage): UserMessage {
  if (message.isMeta) {
    return message
  }

  const tag = `\n[id:${deriveShortMessageId(message.uuid)}]`

  const content = message.message.content

  // Handle string content (most common for simple text input)
  if (typeof content === 'string') {
    return {
      ...message,
      message: {
        ...message.message,
        content: content + tag,
      },
    }
  }

  if (!Array.isArray(content) || content.length === 0) {
    return message
  }

  // Find the last text block
  let lastTextIdx = -1
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]!.type === 'text') {
      lastTextIdx = i
      break
    }
  }
  if (lastTextIdx === -1) {
    return message
  }

  const newContent = [...content]
  const textBlock = newContent[lastTextIdx] as TextBlockParam
  newContent[lastTextIdx] = {
    ...textBlock,
    text: textBlock.text + tag,
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: newContent as typeof content,
    },
  }
}

/**
 * Ensure all text content in attachment-origin messages carries the
 * <system-reminder> wrapper. This makes the prefix a reliable discriminator
 * for the post-pass smoosh (smooshSystemReminderSiblings) — no need for every
 * normalizeAttachmentForAPI case to remember to wrap.
 *
 * Idempotent: already-wrapped text is unchanged.
 */
function ensureSystemReminderWrap(msg: UserMessage): UserMessage {
  const content = msg.message.content
  if (!content) return msg
  if (typeof content === 'string') {
    if (content.startsWith('<system-reminder>')) return msg
    return {
      ...msg,
      message: { ...msg.message, content: wrapInSystemReminder(content) },
    }
  }
  let changed = false
  const newContent = content.map(b => {
    if (b.type === 'text' && !b.text.startsWith('<system-reminder>')) {
      changed = true
      return { ...b, text: wrapInSystemReminder(b.text) }
    }
    return b
  })
  return changed
    ? { ...msg, message: { ...msg.message, content: newContent } }
    : msg
}

/**
 * Strip non-text blocks from is_error tool_results — the API rejects the
 * combination with "all content must be type text if is_error is true".
 *
 * Read-side guard for transcripts persisted before smooshIntoToolResult
 * learned to filter on is_error. Without this a resumed session with one
 * of these 400s on every call and can't be recovered by /fork. Adjacent
 * text left behind by a stripped image is re-merged.
 */
function sanitizeErrorToolResultContent(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return messages.map(msg => {
    if (msg.type !== 'user') return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    let changed = false
    const newContent = content.map(b => {
      if (b.type !== 'tool_result' || !b.is_error) return b
      const trContent = b.content
      if (!Array.isArray(trContent)) return b
      if (trContent.every(c => c.type === 'text')) return b
      changed = true
      const texts = trContent.filter(c => c.type === 'text').map(c => c.text)
      const textOnly: TextBlockParam[] =
        texts.length > 0 ? [{ type: 'text', text: texts.join('\n\n') }] : []
      return { ...b, content: textOnly }
    })
    if (!changed) return msg
    return { ...msg, message: { ...msg.message, content: newContent } }
  })
}

export function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tools = [],
): (UserMessage | AssistantMessage)[] {
  // Build set of available tool names for filtering unavailable tool references
  const availableToolNames = new Set(tools.map(t => t.name))

  // First, reorder attachments to bubble up until they hit a tool result or assistant message
  // Then strip virtual messages — they're display-only (e.g. REPL inner tool
  // calls) and must never reach the API.
  const reorderedMessages = reorderAttachmentsForAPI(messages).filter(
    m => !((m.type === 'user' || m.type === 'assistant') && m.isVirtual),
  )

  // Build a map from error text → which block types to strip from the preceding user message.
  const errorToBlockTypes: Record<string, Set<string>> = {
    [getPdfTooLargeErrorMessage()]: new Set(['document']),
    [getPdfPasswordProtectedErrorMessage()]: new Set(['document']),
    [getPdfInvalidErrorMessage()]: new Set(['document']),
    [getImageTooLargeErrorMessage()]: new Set(['image']),
    [getRequestTooLargeErrorMessage()]: new Set(['document', 'image']),
  }

  // Walk the reordered messages to build a targeted strip map:
  // userMessageUUID → set of block types to strip from that message.
  const stripTargets = new Map<string, Set<string>>()
  for (let i = 0; i < reorderedMessages.length; i++) {
    const msg = reorderedMessages[i]!
    if (!isSyntheticApiErrorMessage(msg)) {
      continue
    }
    // Determine which error this is
    const errorText =
      Array.isArray(msg.message.content) &&
      msg.message.content[0]?.type === 'text'
        ? msg.message.content[0].text
        : undefined
    if (!errorText) {
      continue
    }
    const blockTypesToStrip = errorToBlockTypes[errorText]
    if (!blockTypesToStrip) {
      continue
    }
    // Walk backward to find the nearest preceding isMeta user message
    for (let j = i - 1; j >= 0; j--) {
      const candidate = reorderedMessages[j]!
      if (candidate.type === 'user' && candidate.isMeta) {
        const existing = stripTargets.get(candidate.uuid)
        if (existing) {
          for (const t of blockTypesToStrip) {
            existing.add(t)
          }
        } else {
          stripTargets.set(candidate.uuid, new Set(blockTypesToStrip))
        }
        break
      }
      // Skip over other synthetic error messages or non-meta messages
      if (isSyntheticApiErrorMessage(candidate)) {
        continue
      }
      // Stop if we hit an assistant message or non-meta user message
      break
    }
  }

  // Truncated-Read banners that are no longer in the transcript (see
  // readTruncationReminder.ts). Computed over the reordered list so the
  // attachment scan sees attachments in the same positions the loop will.
  const missingTruncationBanners =
    collectMissingReadTruncationBanners(reorderedMessages)

  const result: (UserMessage | AssistantMessage)[] = []
  reorderedMessages
    .filter(
      (
        _,
      ): _ is
        | UserMessage
        | AssistantMessage
        | AttachmentMessage
        | SystemLocalCommandMessage => {
        if (
          _.type === 'progress' ||
          (_.type === 'system' && !isSystemLocalCommandMessage(_)) ||
          isSyntheticApiErrorMessage(_)
        ) {
          return false
        }
        return true
      },
    )
    .forEach(message => {
      if (!message) return []
      switch (message.type) {
        case 'system': {
          // local_command system messages need to be included as user messages
          // so the model can reference previous command output in later turns
          const userMsg = createUserMessage({
            content: message.content as string | ContentBlockParam[],
            uuid: message.uuid,
            timestamp: message.timestamp as string,
          })
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = mergeUserMessages(lastMessage, userMsg)
            return
          }
          result.push(userMsg)
          return
        }
        case 'user': {
          // Merge consecutive user messages because Bedrock doesn't support
          // multiple user messages in a row; 1P API does and merges them
          // into a single user turn

          // When tool search is NOT enabled, strip all tool_reference blocks from
          // tool_result content, as these are only valid with the tool search beta.
          // When tool search IS enabled, strip only tool_reference blocks for
          // tools that no longer exist (e.g., MCP server was disconnected).
          let normalizedMessage = message
          if (!isSearchExtraToolsEnabledOptimistic()) {
            normalizedMessage = stripToolReferenceBlocksFromUserMessage(message)
          } else {
            normalizedMessage = stripUnavailableToolReferencesFromUserMessage(
              message,
              availableToolNames,
            )
          }

          // Strip document/image blocks from the specific meta user message that
          // preceded a PDF/image/request-too-large error, to prevent re-sending
          // the problematic content on every subsequent API call.
          const typesToStrip = stripTargets.get(normalizedMessage.uuid)
          if (typesToStrip && normalizedMessage.isMeta) {
            const content = normalizedMessage.message.content
            if (Array.isArray(content)) {
              const filtered = content.filter(
                block => !typesToStrip.has(block.type),
              )
              if (filtered.length === 0) {
                // All content blocks were stripped; skip this message entirely
                return
              }
              if (filtered.length < content.length) {
                normalizedMessage = {
                  ...normalizedMessage,
                  message: {
                    ...normalizedMessage.message,
                    content: filtered,
                  },
                }
              }
            }
          }

          // Server renders tool_reference expansion as <functions>...</functions>
          // (same tags as the system prompt's tool block). When this is at the
          // prompt tail, capybara models sample the stop sequence at ~10% (A/B:
          // 21/200 vs 0/200 on v3-prod). A sibling text block inserts a clean
          // "\n\nHuman: ..." turn boundary. Injected here (API-prep) rather than
          // stored in the message so it never renders in the REPL, and is
          // auto-skipped when strip* above removes all tool_reference content.
          // Must be a sibling, NOT inside tool_result.content — mixing text with
          // tool_reference inside the block is a server ValueError.
          // Idempotent: query.ts calls this per-tool-result; the output flows
          // back through here via claude.ts on the next API request. The first
          // pass's sibling gets a \n[id:xxx] suffix from appendMessageTag below,
          // so startsWith matches both bare and tagged forms.
          //
          // Gated OFF when tengu_toolref_defer_j8m is active — that gate
          // enables relocateToolReferenceSiblings in post-processing below,
          // which moves existing siblings to a later non-ref message instead
          // of adding one here. This injection is itself one of the patterns
          // that gets relocated, so skipping it saves a scan. When gate is
          // off, this is the fallback (same as pre-#21049 main).
          if (
            !checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
              'tengu_toolref_defer_j8m',
            )
          ) {
            const contentAfterStrip = normalizedMessage.message.content
            if (
              Array.isArray(contentAfterStrip) &&
              !contentAfterStrip.some(
                b =>
                  b.type === 'text' &&
                  b.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY),
              ) &&
              contentHasToolReference(contentAfterStrip)
            ) {
              normalizedMessage = {
                ...normalizedMessage,
                message: {
                  ...normalizedMessage.message,
                  content: [
                    ...contentAfterStrip,
                    { type: 'text', text: TOOL_REFERENCE_TURN_BOUNDARY },
                  ],
                },
              }
            }
          }

          // If the last message is also a user message, merge them
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = mergeUserMessages(
              lastMessage,
              normalizedMessage,
            )
          } else {
            // Otherwise, add the message normally
            result.push(normalizedMessage)
          }

          // A Read the token cap cut to page 1 announces itself with a
          // `read_truncation_notice` attachment — which is stripped from the
          // persisted transcript, so after --resume the model sees a partial
          // file with nothing saying so. Rebuild the banner from the durable
          // `toolUseResult.file.truncatedByTokenCap` flag. Merged into the
          // tool_result's own message so a round trip through here sees it and
          // does not add a second copy.
          const missingBanner = missingTruncationBanners.get(message.uuid)
          if (missingBanner !== undefined) {
            const bannerMessage = createUserMessage({
              content: wrapInSystemReminder(missingBanner),
              isMeta: true,
            })
            const tail = last(result)
            if (tail?.type === 'user') {
              result[result.length - 1] = mergeUserMessages(tail, bannerMessage)
            } else {
              result.push(bannerMessage)
            }
          }
          return
        }
        case 'assistant': {
          // Normalize tool inputs for API (strip fields like plan from ExitPlanModeV2)
          // When tool search is NOT enabled, we must strip tool_search-specific fields
          // like 'caller' from tool_use blocks, as these are only valid with the
          // tool search beta header
          const searchExtraToolsEnabled = isSearchExtraToolsEnabledOptimistic()
          const normalizedMessage: AssistantMessage = {
            ...message,
            message: {
              ...message.message,
              content: (Array.isArray(message.message.content)
                ? message.message.content
                : []
              ).map(block => {
                if (typeof block === 'string') return block
                if (block.type === 'tool_use') {
                  const toolUseBlk = block as ToolUseBlock
                  const tool = tools.find(t =>
                    toolMatchesName(t, toolUseBlk.name),
                  )
                  const normalizedInput = tool
                    ? normalizeToolInputForAPI(
                        tool,
                        toolUseBlk.input as Record<string, unknown>,
                      )
                    : toolUseBlk.input
                  const canonicalName = tool?.name ?? toolUseBlk.name

                  // When tool search is enabled, preserve all fields including 'caller'
                  if (searchExtraToolsEnabled) {
                    return {
                      ...block,
                      name: canonicalName,
                      input: normalizedInput,
                    }
                  }

                  // When tool search is NOT enabled, strip tool-search-only fields
                  // like 'caller', but preserve other provider metadata attached to
                  // the block (for example Gemini thought signatures on tool_use).
                  const { caller: _caller, ...toolUseRest } =
                    block as ToolUseBlock &
                      Record<string, unknown> & { caller?: unknown }
                  return {
                    ...toolUseRest,
                    type: 'tool_use' as const,
                    id: toolUseBlk.id,
                    name: canonicalName,
                    input: normalizedInput,
                  }
                }
                return block
              }),
            },
          }

          // Find a previous assistant message with the same message ID and merge.
          // Walk backwards, skipping different-ID assistants, since concurrent
          // agents (teammates) can interleave streaming content blocks from
          // multiple API responses with different message IDs.
          //
          // Do NOT skip tool_result messages — when claude.ts yields separate
          // AssistantMessages for thinking and tool_use blocks (same message.id),
          // a StreamingToolExecutor tool_result can land between them. Merging
          // across that boundary produces duplicate tool_use IDs that downstream
          // ensureToolResultPairing strips, leaving orphaned tool_results and
          // ultimately consecutive user messages → API 400 (CC-1215).
          for (let i = result.length - 1; i >= 0; i--) {
            const msg = result[i]!

            if (msg.type !== 'assistant') {
              break
            }

            if (msg.message.id === normalizedMessage.message.id) {
              result[i] = mergeAssistantMessages(msg, normalizedMessage)
              return
            }
          }

          result.push(normalizedMessage)
          return
        }
        case 'attachment': {
          const rawAttachmentMessage = normalizeAttachmentForAPI(
            message.attachment as Attachment,
          )
          const attachmentMessage = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
            'tengu_chair_sermon',
          )
            ? rawAttachmentMessage.map(ensureSystemReminderWrap)
            : rawAttachmentMessage

          // If the last message is also a user message, merge them
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = attachmentMessage.reduce(
              (p, c) => mergeUserMessagesAndToolResults(p, c),
              lastMessage,
            )
            return
          }

          result.push(...attachmentMessage)
          return
        }
      }
    })

  // Relocate text siblings off tool_reference messages — prevents the
  // anomalous two-consecutive-human-turns pattern that teaches the model
  // to emit the stop sequence after tool results. See #21049.
  // Runs after merge (siblings are in place) and before ID tagging (so
  // tags reflect final positions). When gate is OFF, this is a noop and
  // the TOOL_REFERENCE_TURN_BOUNDARY injection above serves as fallback.
  const relocated = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'tengu_toolref_defer_j8m',
  )
    ? relocateToolReferenceSiblings(result)
    : result

  // Filter orphaned thinking-only assistant messages (likely introduced by
  // compaction slicing away intervening messages between a failed streaming
  // response and its retry). Without this, consecutive assistant messages with
  // mismatched thinking block signatures cause API 400 errors.
  const withFilteredOrphans = filterOrphanedThinkingOnlyMessages(relocated)

  // Order matters: strip trailing thinking first, THEN filter whitespace-only
  // messages. The reverse order has a bug: a message like [text("\n\n"), thinking("...")]
  // survives the whitespace filter (has a non-text block), then thinking stripping
  // removes the thinking block, leaving [text("\n\n")] — which the API rejects.
  //
  // These multi-pass normalizations are inherently fragile — each pass can create
  // conditions a prior pass was meant to handle. Consider unifying into a single
  // pass that cleans content, then validates in one shot.
  const withFilteredThinking =
    filterTrailingThinkingFromLastAssistant(withFilteredOrphans)
  const withFilteredWhitespace =
    filterWhitespaceOnlyAssistantMessages(withFilteredThinking)
  const withNonEmpty = ensureNonEmptyAssistantContent(withFilteredWhitespace)

  // filterOrphanedThinkingOnlyMessages doesn't merge adjacent users (whitespace
  // filter does, but only when IT fires). Merge here so smoosh can fold the
  // SR-text sibling that hoistToolResults produces. The smoosh itself folds
  // <system-reminder>-prefixed text siblings into the adjacent tool_result.
  // Gated together: the merge exists solely to feed the smoosh; running it
  // ungated changes VCR fixture hashes for @-mention scenarios (adjacent
  // [prompt, attachment] users) without any benefit when the smoosh is off.
  const smooshed = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'tengu_chair_sermon',
  )
    ? smooshSystemReminderSiblings(mergeAdjacentUserMessages(withNonEmpty))
    : withNonEmpty

  // Unconditional — catches transcripts persisted before smooshIntoToolResult
  // learned to filter on is_error. Without this a resumed session with an
  // image-in-error tool_result 400s forever.
  const sanitized = sanitizeErrorToolResultContent(smooshed)

  // Validate all images are within API size limits before sending
  validateImagesForAPI(sanitized)

  return sanitized
}

function mergeAdjacentUserMessages(
  msgs: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  // Collect each run of consecutive user messages and merge it in ONE pass —
  // the previous fold (mergeUserMessages per pair) re-copied the accumulated
  // content every step, O(k²) in blocks for a k-message run (long sessions
  // hit this on every API request; official 2.1.216 parity).
  const out: (UserMessage | AssistantMessage)[] = []
  let run: UserMessage[] = []
  const flush = () => {
    if (run.length > 0) {
      out.push(mergeUserMessageRun(run))
      run = []
    }
  }
  for (const m of msgs) {
    if (m.type === 'user') {
      run.push(m)
    } else {
      flush()
      out.push(m)
    }
  }
  flush()
  return out
}
