/**
 * Scan-based tool_use / tool_result id helpers. These walk the message array on
 * every call; the O(1) equivalents live in lookups.ts / lookupAccessors.ts.
 */
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedMessage,
} from '../../types/message.js'
import { count } from '../collections/array.js'
import {
  type HookAttachmentWithName,
  isHookAttachmentMessage,
} from './shared.js'

function getInProgressHookCount(
  messages: NormalizedMessage[],
  toolUseID: string,
  hookEvent: HookEvent,
): number {
  return count(
    messages,
    _ =>
      _.type === 'progress' &&
      (_.data as { type: string; hookEvent: HookEvent }).type ===
        'hook_progress' &&
      (_.data as { type: string; hookEvent: HookEvent }).hookEvent ===
        hookEvent &&
      _.parentToolUseID === toolUseID,
  )
}

function getResolvedHookCount(
  messages: NormalizedMessage[],
  toolUseID: string,
  hookEvent: HookEvent,
): number {
  // Count unique hook names, since a single hook can produce multiple
  // attachment messages (e.g., hook_success + hook_additional_context)
  const uniqueHookNames = new Set(
    messages
      .filter(
        (_): _ is AttachmentMessage<HookAttachmentWithName> =>
          isHookAttachmentMessage(_) &&
          _.attachment.toolUseID === toolUseID &&
          _.attachment.hookEvent === hookEvent,
      )
      .map(_ => _.attachment.hookName),
  )
  return uniqueHookNames.size
}

export function hasUnresolvedHooks(
  messages: NormalizedMessage[],
  toolUseID: string,
  hookEvent: HookEvent,
) {
  const inProgressHookCount = getInProgressHookCount(
    messages,
    toolUseID,
    hookEvent,
  )
  const resolvedHookCount = getResolvedHookCount(messages, toolUseID, hookEvent)

  if (inProgressHookCount > resolvedHookCount) {
    return true
  }

  return false
}

export function getToolResultIDs(normalizedMessages: NormalizedMessage[]): {
  [toolUseID: string]: boolean
} {
  return Object.fromEntries(
    normalizedMessages.flatMap(_ =>
      _.type === 'user' &&
      Array.isArray(_.message?.content) &&
      (_.message?.content as Array<{ type: string }>)[0]?.type === 'tool_result'
        ? [
            [
              (
                (
                  _.message?.content as Array<{ type: string }>
                )[0] as ToolResultBlockParam
              ).tool_use_id,
              (
                (
                  _.message?.content as Array<{ type: string }>
                )[0] as ToolResultBlockParam
              ).is_error ?? false,
            ],
          ]
        : ([] as [string, boolean][]),
    ),
  )
}

export function getSiblingToolUseIDs(
  message: NormalizedMessage,
  messages: Message[],
): Set<string> {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) {
    return new Set()
  }

  const unnormalizedMessage = messages.find(
    (_): _ is AssistantMessage =>
      _.type === 'assistant' &&
      Array.isArray(_.message?.content) &&
      (_.message?.content as Array<{ type: string; id?: string }>).some(
        block => block.type === 'tool_use' && block.id === toolUseID,
      ),
  )
  if (!unnormalizedMessage) {
    return new Set()
  }

  const messageID = unnormalizedMessage.message.id
  const siblingMessages = messages.filter(
    (_): _ is AssistantMessage =>
      _.type === 'assistant' && _.message?.id === messageID,
  )

  return new Set(
    siblingMessages.flatMap(_ =>
      Array.isArray(_.message?.content)
        ? (_.message?.content as Array<{ type: string; id?: string }>)
            .filter(_ => _.type === 'tool_use')
            .map(_ => _.id!)
        : [],
    ),
  )
}

export function getToolUseIDs(
  normalizedMessages: NormalizedMessage[],
): Set<string> {
  return new Set(
    normalizedMessages
      .filter(
        (_): _ is NormalizedAssistantMessage<BetaToolUseBlock> =>
          _.type === 'assistant' &&
          Array.isArray(_.message?.content) &&
          (_.message?.content as Array<{ type: string }>)[0]?.type ===
            'tool_use',
      )
      .map(_ => (_.message?.content as Array<BetaToolUseBlock>)[0].id),
  )
}

export function getToolUseID(message: NormalizedMessage): string | null {
  switch (message.type) {
    case 'attachment':
      if (isHookAttachmentMessage(message)) {
        return message.attachment.toolUseID ?? null
      }
      return null
    case 'assistant': {
      const aContent = Array.isArray(message.message?.content)
        ? message.message?.content
        : []
      const firstBlock = aContent![0]
      if (
        !firstBlock ||
        typeof firstBlock === 'string' ||
        firstBlock.type !== 'tool_use'
      ) {
        return null
      }
      return (firstBlock as ToolUseBlock).id
    }
    case 'user': {
      if (message.sourceToolUseID) {
        return message.sourceToolUseID as string
      }
      const uContent = Array.isArray(message.message?.content)
        ? message.message?.content
        : []
      const firstUBlock = uContent![0]
      if (
        !firstUBlock ||
        typeof firstUBlock === 'string' ||
        firstUBlock.type !== 'tool_result'
      ) {
        return null
      }
      return (firstUBlock as ToolResultBlockParam).tool_use_id
    }
    case 'progress':
      return message.toolUseID as string
    case 'system':
      return (message.subtype as string) === 'informational'
        ? ((message.toolUseID as string) ?? null)
        : null
    default:
      return null
  }
}
