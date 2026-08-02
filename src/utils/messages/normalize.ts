/**
 * Normalization of stored messages: one content block per message for the UI,
 * the deterministic uuid derivation that keeps those splits stable, the UI
 * reordering pass and the normalization of content coming back from the API.
 */
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import isObject from 'lodash-es/isObject.js'
import { logEvent } from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type { AgentId } from 'src/types/ids.js'
import { findToolByName, type Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  MessageOrigin,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import { normalizeToolInput } from '../api.js'
import { logForDebugging } from '../debug.js'
import { safeParseJSON } from '../text/json.js'
import { logError } from '../log.js'
import { createUserMessage } from './constructors.js'
import {
  isToolUseRequestMessage,
  type ToolUseRequestMessage,
} from './predicates.js'
import { isHookAttachmentMessage } from './shared.js'

// Deterministic UUID derivation. Produces a stable UUID-shaped string from a
// parent UUID + content block index so that the same input always produces the
// same key across calls. Used by normalizeMessages and synthetic message creation.
export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const hex = index.toString(16).padStart(12, '0')
  return `${parentUUID.slice(0, 24)}${hex}` as UUID
}

// Split messages, so each content block gets its own message
export function normalizeMessages(
  messages: AssistantMessage[],
): NormalizedAssistantMessage[]
export function normalizeMessages(
  messages: UserMessage[],
): NormalizedUserMessage[]
export function normalizeMessages(
  messages: (AssistantMessage | UserMessage)[],
): (NormalizedAssistantMessage | NormalizedUserMessage)[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  // isNewChain tracks whether we need to generate new UUIDs for messages when normalizing.
  // When a message has multiple content blocks, we split it into multiple messages,
  // each with a single content block. When this happens, we need to generate new UUIDs
  // for all subsequent messages to maintain proper ordering and prevent duplicate UUIDs.
  // This flag is set to true once we encounter a message with multiple content blocks,
  // and remains true for all subsequent messages in the normalization process.
  let isNewChain = false
  return messages.flatMap(message => {
    if (!message) return []
    switch (message.type) {
      case 'assistant': {
        const aMsg = message as AssistantMessage
        const assistantContent = Array.isArray(aMsg.message.content)
          ? aMsg.message.content
          : []
        isNewChain = isNewChain || assistantContent.length > 1
        return assistantContent.map((_, index) => {
          const uuid = isNewChain
            ? deriveUUID(message.uuid, index)
            : message.uuid
          return {
            type: 'assistant' as const,
            timestamp: message.timestamp,
            message: {
              ...aMsg.message,
              content: [_],
              context_management: aMsg.message.context_management ?? null,
            },
            isMeta: message.isMeta,
            isVirtual: message.isVirtual,
            requestId: message.requestId,
            uuid,
            error: message?.error,
            isApiErrorMessage: message.isApiErrorMessage,
            advisorModel: message.advisorModel,
          } as NormalizedAssistantMessage
        })
      }
      case 'attachment':
        return [message]
      case 'progress':
        return [message]
      case 'system':
        return [message]
      case 'user': {
        const uMsg = message as UserMessage
        if (typeof uMsg.message.content === 'string') {
          const uuid = isNewChain ? deriveUUID(uMsg.uuid, 0) : uMsg.uuid
          return [
            {
              ...uMsg,
              uuid,
              message: {
                ...uMsg.message,
                content: [{ type: 'text', text: uMsg.message.content }],
              },
            } as NormalizedMessage,
          ]
        }
        isNewChain = isNewChain || (uMsg.message.content?.length ?? 0) > 1
        let imageIndex = 0
        return (uMsg.message.content ?? []).map((_, index) => {
          const isImage = _.type === 'image'
          // For image content blocks, extract just the ID for this image
          const imageId =
            isImage && uMsg.imagePasteIds
              ? (uMsg.imagePasteIds as number[])[imageIndex]
              : undefined
          if (isImage) imageIndex++
          return {
            ...createUserMessage({
              content: [_],
              toolUseResult: uMsg.toolUseResult,
              mcpMeta: uMsg.mcpMeta as {
                _meta?: Record<string, unknown>
                structuredContent?: Record<string, unknown>
              },
              isMeta: uMsg.isMeta === true ? true : undefined,
              isVisibleInTranscriptOnly:
                uMsg.isVisibleInTranscriptOnly === true ? true : undefined,
              isVirtual:
                (uMsg.isVirtual as boolean | undefined) === true
                  ? true
                  : undefined,
              timestamp: uMsg.timestamp as string | undefined,
              imagePasteIds: imageId !== undefined ? [imageId] : undefined,
              origin: uMsg.origin as MessageOrigin | undefined,
            }),
            uuid: isNewChain ? deriveUUID(uMsg.uuid, index) : uMsg.uuid,
          } as NormalizedMessage
        })
      }
      default:
        return [message]
    }
  })
}

// Re-order, to move result messages to be after their tool use messages
export function reorderMessagesInUI(
  messages: (
    | NormalizedUserMessage
    | NormalizedAssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[],
  syntheticStreamingToolUseMessages: NormalizedAssistantMessage[],
): (
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | SystemMessage
)[] {
  // Maps tool use ID to its related messages
  const toolUseGroups = new Map<
    string,
    {
      toolUse: ToolUseRequestMessage | null
      preHooks: AttachmentMessage[]
      toolResult: NormalizedUserMessage | null
      postHooks: AttachmentMessage[]
    }
  >()

  // First pass: group messages by tool use ID
  for (const message of messages) {
    // Handle tool use messages
    if (isToolUseRequestMessage(message)) {
      const toolUseID = message.message.content[0]?.id
      if (toolUseID) {
        if (!toolUseGroups.has(toolUseID)) {
          toolUseGroups.set(toolUseID, {
            toolUse: null,
            preHooks: [],
            toolResult: null,
            postHooks: [],
          })
        }
        toolUseGroups.get(toolUseID)!.toolUse = message
      }
      continue
    }

    // Handle pre-tool-use hooks
    if (
      isHookAttachmentMessage(message) &&
      message.attachment.hookEvent === 'PreToolUse'
    ) {
      const toolUseID = message.attachment.toolUseID
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.preHooks.push(message)
      continue
    }

    // Handle tool results
    if (
      message.type === 'user' &&
      Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'tool_result'
    ) {
      const toolUseID = (message.message.content[0] as ToolResultBlockParam)
        .tool_use_id
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.toolResult = message
      continue
    }

    // Handle post-tool-use hooks
    if (
      isHookAttachmentMessage(message) &&
      message.attachment.hookEvent === 'PostToolUse'
    ) {
      const toolUseID = message.attachment.toolUseID
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.postHooks.push(message)
    }
  }

  // Second pass: reconstruct the message list in the correct order
  const result: (
    | NormalizedUserMessage
    | NormalizedAssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[] = []
  const processedToolUses = new Set<string>()

  for (const message of messages) {
    // Check if this is a tool use
    if (isToolUseRequestMessage(message)) {
      const toolUseID = message.message.content[0]?.id
      if (toolUseID && !processedToolUses.has(toolUseID)) {
        processedToolUses.add(toolUseID)
        const group = toolUseGroups.get(toolUseID)
        if (group && group.toolUse) {
          // Output in order: tool use, pre hooks, tool result, post hooks
          result.push(group.toolUse)
          result.push(...group.preHooks)
          if (group.toolResult) {
            result.push(group.toolResult)
          }
          result.push(...group.postHooks)
        }
      }
      continue
    }

    // Check if this message is part of a tool use group
    if (
      isHookAttachmentMessage(message) &&
      (message.attachment.hookEvent === 'PreToolUse' ||
        message.attachment.hookEvent === 'PostToolUse')
    ) {
      // Skip - already handled in tool use groups
      continue
    }

    if (
      message.type === 'user' &&
      Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'tool_result'
    ) {
      // Skip - already handled in tool use groups
      continue
    }

    // Handle api error messages (only keep the last one)
    if (message.type === 'system' && message.subtype === 'api_error') {
      const last = result.at(-1)
      if (last?.type === 'system' && last.subtype === 'api_error') {
        result[result.length - 1] = message
      } else {
        result.push(message)
      }
      continue
    }

    // Add standalone messages
    result.push(message)
  }

  // Add synthetic streaming tool use messages
  for (const message of syntheticStreamingToolUseMessages) {
    result.push(message)
  }

  // Filter to keep only the last api error message
  const last = result.at(-1)
  return result.filter(
    _ => _.type !== 'system' || _.subtype !== 'api_error' || _ === last,
  )
}

// Sometimes the API returns empty messages (eg. "\n\n"). We need to filter these out,
// otherwise they will give an API error when we send them to the API next time we call query().
export function normalizeContentFromAPI(
  contentBlocks: BetaMessage['content'],
  tools: Tools,
  agentId?: AgentId,
): BetaMessage['content'] {
  if (!contentBlocks) {
    return []
  }
  return contentBlocks.map(contentBlock => {
    switch (contentBlock.type) {
      case 'tool_use': {
        if (
          typeof contentBlock.input !== 'string' &&
          !isObject(contentBlock.input)
        ) {
          // we stream tool use inputs as strings, but when we fall back, they're objects
          throw new Error('Tool use input must be a string or object')
        }

        // With fine-grained streaming on, we are getting a stringied JSON back from the API.
        // The API has strange behaviour, where it returns nested stringified JSONs, and so
        // we need to recursively parse these. If the top-level value returned from the API is
        // an empty string, this should become an empty object (nested values should be empty string).
        // TODO: This needs patching as recursive fields can still be stringified
        let normalizedInput: unknown
        if (typeof contentBlock.input === 'string') {
          const parsed = safeParseJSON(contentBlock.input)
          if (parsed === null && contentBlock.input.length > 0) {
            // TET/FC-v3 diagnostic: the streamed tool input JSON failed to
            // parse. We fall back to {} which means downstream validation
            // sees empty input. The raw prefix goes to debug log only — no
            // PII-tagged proto column exists for it yet.
            logEvent('tengu_tool_input_json_parse_fail', {
              toolName: sanitizeToolNameForAnalytics(contentBlock.name),
              inputLen: contentBlock.input.length,
            })
            if (process.env.USER_TYPE === 'ant') {
              logForDebugging(
                `tool input JSON parse fail: ${contentBlock.input.slice(0, 200)}`,
                { level: 'warn' },
              )
            }
          }
          normalizedInput = parsed ?? {}
        } else {
          normalizedInput = contentBlock.input
        }

        // Then apply tool-specific corrections
        if (typeof normalizedInput === 'object' && normalizedInput !== null) {
          const tool = findToolByName(tools, contentBlock.name)
          if (tool) {
            try {
              normalizedInput = normalizeToolInput(
                tool,
                normalizedInput as { [key: string]: unknown },
                agentId,
              )
            } catch (error) {
              logError(new Error('Error normalizing tool input: ' + error))
              // Keep the original input if normalization fails
            }
          }
        }

        return {
          ...contentBlock,
          input: normalizedInput,
        }
      }
      case 'text':
        if (contentBlock.text.trim().length === 0) {
          logEvent('tengu_model_whitespace_response', {
            length: contentBlock.text.length,
          })
        }
        // Return the block as-is to preserve exact content for prompt caching.
        // Empty text blocks are handled at the display layer and must not be
        // altered here.
        return contentBlock
      case 'code_execution_tool_result':
      case 'mcp_tool_use':
      case 'mcp_tool_result':
      case 'container_upload':
        // Beta-specific content blocks - pass through as-is
        return contentBlock
      case 'server_tool_use':
        if (typeof contentBlock.input === 'string') {
          return {
            ...contentBlock,
            input: (safeParseJSON(contentBlock.input) ?? {}) as {
              [key: string]: unknown
            },
          }
        }
        return contentBlock
      default:
        return contentBlock
    }
  })
}
