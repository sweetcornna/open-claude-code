/**
 * Message-shape predicates and the small query helpers built on them, plus the
 * permission-denial copy that is derived from DENIAL_WORKAROUND_GUIDANCE.
 */
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { feature } from 'bun:bundle'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type {
  AssistantMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  SystemLocalCommandMessage,
} from '../../types/message.js'
import {
  DENIAL_WORKAROUND_GUIDANCE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  SYNTHETIC_MESSAGES,
} from './constants.js'

export function AUTO_REJECT_MESSAGE(toolName: string): string {
  return `Permission to use ${toolName} has been denied. ${DENIAL_WORKAROUND_GUIDANCE}`
}
export function DONT_ASK_REJECT_MESSAGE(toolName: string): string {
  return `Permission to use ${toolName} has been denied because Claude Code is running in don't ask mode. ${DENIAL_WORKAROUND_GUIDANCE}`
}

// Prefix used by UI to detect classifier denials and render them concisely
const AUTO_MODE_REJECTION_PREFIX =
  'Permission for this action has been denied. Reason: '

/**
 * Check if a tool result message is a classifier denial.
 * Used by the UI to render a short summary instead of the full message.
 */
export function isClassifierDenial(content: string): boolean {
  return content.startsWith(AUTO_MODE_REJECTION_PREFIX)
}

/**
 * Build a rejection message for auto mode classifier denials.
 * Encourages continuing with other tasks and suggests permission rules.
 *
 * @param reason - The classifier's reason for denying the action
 */
export function buildYoloRejectionMessage(reason: string): string {
  const prefix = AUTO_MODE_REJECTION_PREFIX

  const ruleHint = feature('BASH_CLASSIFIER')
    ? `To allow this type of action in the future, the user can add a permission rule like ` +
      `Bash(prompt: <description of allowed action>) to their settings. ` +
      `At the end of your session, recommend what permission rules to add so you don't get blocked again.`
    : `To allow this type of action in the future, the user can add a Bash permission rule to their settings.`

  return (
    `${prefix}${reason}. ` +
    `If you have other tasks that don't depend on this action, continue working on those. ` +
    `${DENIAL_WORKAROUND_GUIDANCE} ` +
    ruleHint
  )
}

/**
 * Build a message for when the auto mode classifier is temporarily unavailable.
 * Tells the agent to wait and retry, and suggests working on other tasks.
 */
export function buildClassifierUnavailableMessage(
  toolName: string,
  classifierModel: string,
): string {
  return (
    `${classifierModel} is temporarily unavailable, so auto mode cannot determine the safety of ${toolName} right now. ` +
    `Wait briefly and then try this action again. ` +
    `If it keeps failing, continue with other tasks that don't require this action and come back to it later. ` +
    `Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.`
  )
}

export function isSyntheticMessage(message: Message): boolean {
  return (
    message.type !== 'progress' &&
    message.type !== 'attachment' &&
    message.type !== 'system' &&
    Array.isArray(message.message?.content) &&
    message.message?.content[0]?.type === 'text' &&
    SYNTHETIC_MESSAGES.has(
      (message.message?.content[0] as { text: string }).text,
    )
  )
}

export function getLastAssistantMessage(
  messages: Message[],
): AssistantMessage | undefined {
  // findLast exits early from the end — much faster than filter + last for
  // large message arrays (called on every REPL render via useFeedbackSurvey).
  return messages.findLast(
    (msg): msg is AssistantMessage => msg.type === 'assistant',
  )
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        return content.some(block => block.type === 'tool_use')
      }
    }
  }
  return false
}

export function isNotEmptyMessage(message: Message): boolean {
  if (
    message.type === 'progress' ||
    message.type === 'attachment' ||
    message.type === 'system'
  ) {
    return true
  }

  const msg = message.message
  if (!msg) return true

  if (typeof msg.content === 'string') {
    return msg.content.trim().length > 0
  }

  if (!msg.content || msg.content.length === 0) {
    return false
  }

  // Skip multi-block messages for now
  if (msg.content.length > 1) {
    return true
  }

  if (msg.content[0]!.type !== 'text') {
    return true
  }

  return (
    (msg.content[0] as { text: string }).text.trim().length > 0 &&
    (msg.content[0] as { text: string }).text !== NO_CONTENT_MESSAGE &&
    (msg.content[0] as { text: string }).text !== INTERRUPT_MESSAGE_FOR_TOOL_USE
  )
}

export type ToolUseRequestMessage = NormalizedAssistantMessage & {
  message: { content: [ToolUseBlock] }
}

export function isToolUseRequestMessage(
  message: Message,
): message is ToolUseRequestMessage {
  return (
    message.type === 'assistant' &&
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
    Array.isArray(message.message?.content) &&
    (message.message?.content as Array<{ type: string }>).some(
      _ => _.type === 'tool_use',
    )
  )
}

type ToolUseResultMessage = NormalizedUserMessage & {
  message: { content: [ToolResultBlockParam] }
}

export function isToolUseResultMessage(
  message: Message,
): message is ToolUseResultMessage {
  return (
    message.type === 'user' &&
    ((Array.isArray(message.message?.content) &&
      (message.message?.content as Array<{ type: string }>)[0]?.type ===
        'tool_result') ||
      Boolean(message.toolUseResult))
  )
}

export function isSystemLocalCommandMessage(
  message: Message,
): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

export function shouldShowUserMessage(
  message: NormalizedMessage,
  isTranscriptMode: boolean,
): boolean {
  if (message.type !== 'user') return true
  if (message.isMeta) {
    // Channel messages stay isMeta (for snip-tag/turn-boundary/brief-mode
    // semantics) but render in the default transcript — the keyboard user
    // should see what arrived. The <channel> tag in UserTextMessage handles
    // the actual rendering.
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      (message.origin as { kind?: string } | undefined)?.kind === 'channel'
    )
      return true
    return false
  }
  if (message.isVisibleInTranscriptOnly && !isTranscriptMode) return false
  return true
}

export function isThinkingMessage(message: Message): boolean {
  if (message.type !== 'assistant') return false
  if (!Array.isArray(message.message?.content)) return false
  return (message.message?.content as Array<{ type: string }>).every(
    block => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

/**
 * Count total calls to a specific tool in message history
 * Stops early at maxCount for efficiency
 */
export function countToolCalls(
  messages: Message[],
  toolName: string,
  maxCount?: number,
): number {
  let count = 0
  for (const msg of messages) {
    if (!msg) continue
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      const hasToolUse = (
        msg.message?.content as Array<{ type: string; name?: string }>
      ).some(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name === toolName,
      )
      if (hasToolUse) {
        count++
        if (maxCount && count >= maxCount) {
          return count
        }
      }
    }
  }
  return count
}

/**
 * Check if the most recent tool call succeeded (has result without is_error)
 * Searches backwards for efficiency.
 */
export function hasSuccessfulToolCall(
  messages: Message[],
  toolName: string,
): boolean {
  // Search backwards to find most recent tool_use for this tool
  let mostRecentToolUseId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      const toolUse = (
        msg.message?.content as Array<{
          type: string
          name?: string
          id?: string
        }>
      ).find(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name === toolName,
      )
      if (toolUse) {
        mostRecentToolUseId = toolUse.id
        break
      }
    }
  }

  if (!mostRecentToolUseId) return false

  // Find the corresponding tool_result (search backwards)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      const toolResult = (
        msg.message?.content as Array<{
          type: string
          tool_use_id?: string
          is_error?: boolean
        }>
      ).find(
        (block): block is ToolResultBlockParam =>
          block.type === 'tool_result' &&
          block.tool_use_id === mostRecentToolUseId,
      )
      if (toolResult) {
        // Success if is_error is false or undefined
        return toolResult.is_error !== true
      }
    }
  }

  // Tool called but no result yet (shouldn't happen in practice)
  return false
}
