/**
 * Defensive tool_use / tool_result pairing repair, run just before the payload
 * leaves for the API.
 */
import type {
  ContentBlock,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getStrictToolResultPairing } from '../../bootstrap/state.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { logError } from '../log.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './constants.js'
import { createUserMessage } from './constructors.js'
import { smooshSystemReminderSiblings } from './merge.js'

/**
 * Defensive validation: ensure tool_use/tool_result pairing is correct.
 *
 * Handles both directions:
 * - Forward: inserts synthetic error tool_result blocks for tool_use blocks missing results
 * - Reverse: strips orphaned tool_result blocks referencing non-existent tool_use blocks
 *
 * Logs when this activates to help identify the root cause.
 *
 * Strict mode: when getStrictToolResultPairing() is true (HFI opts in at
 * startup), any mismatch throws instead of repairing. For training-data
 * collection, a model response conditioned on synthetic placeholders is
 * tainted — fail the trajectory rather than waste labeler time on a turn
 * that will be rejected at submission anyway.
 */
export function ensureToolResultPairing(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []
  let repaired = false

  // Cross-message tool_use ID tracking. The per-message seenToolUseIds below
  // only caught duplicates within a single assistant's content array (the
  // normalizeMessagesForAPI-merged case). When two assistants with DIFFERENT
  // message.id carry the same tool_use ID — e.g. orphan handler re-pushed an
  // assistant already present in mutableMessages with a fresh message.id, or
  // normalizeMessagesForAPI's backward walk broke on an intervening user
  // message — the dup lived in separate result entries and the API rejected
  // with "tool_use ids must be unique", deadlocking the session (CC-1212).
  const allSeenToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.type !== 'assistant') {
      // A user message with tool_result blocks but NO preceding assistant
      // message in the output has orphaned tool_results. The assistant
      // lookahead below only validates assistant→user adjacency; it never
      // sees user messages at index 0 or user messages preceded by another
      // user. This happens on resume when the transcript starts mid-turn
      // (e.g. messages[0] is a tool_result whose assistant pair was dropped
      // by earlier compaction — API rejects with "messages.0.content:
      // unexpected tool_use_id").
      if (
        msg.type === 'user' &&
        Array.isArray(msg.message.content) &&
        result.at(-1)?.type !== 'assistant'
      ) {
        const stripped = msg.message.content.filter(
          block =>
            !(
              typeof block === 'object' &&
              'type' in block &&
              block.type === 'tool_result'
            ),
        )
        if (stripped.length !== msg.message.content.length) {
          repaired = true
          // If stripping emptied the message and nothing has been pushed yet,
          // keep a placeholder so the payload still starts with a user
          // message (normalizeMessagesForAPI runs before us, so messages[1]
          // is an assistant — dropping messages[0] entirely would yield a
          // payload starting with assistant, a different 400).
          const content =
            stripped.length > 0
              ? stripped
              : result.length === 0
                ? [
                    {
                      type: 'text' as const,
                      text: '[Orphaned tool result removed due to conversation resume]',
                    },
                  ]
                : null
          if (content !== null) {
            result.push({
              ...msg,
              message: { ...msg.message, content },
            })
          }
          continue
        }
      }
      result.push(msg)
      continue
    }

    // Collect server-side tool result IDs (*_tool_result blocks have tool_use_id).
    const serverResultIds = new Set<string>()
    const aMsg5 = msg as AssistantMessage
    for (const c of aMsg5.message.content as (
      | ContentBlockParam
      | ContentBlock
    )[]) {
      if (
        typeof c !== 'string' &&
        'tool_use_id' in c &&
        typeof (c as { tool_use_id: string }).tool_use_id === 'string'
      ) {
        serverResultIds.add((c as { tool_use_id: string }).tool_use_id)
      }
    }

    // Dedupe tool_use blocks by ID. Checks against the cross-message
    // allSeenToolUseIds Set so a duplicate in a LATER assistant (different
    // message.id, not merged by normalizeMessagesForAPI) is also stripped.
    // The per-message seenToolUseIds tracks only THIS assistant's surviving
    // IDs — the orphan/missing-result detection below needs a per-message
    // view, not the cumulative one.
    //
    // Also strip orphaned server-side tool use blocks (server_tool_use,
    // mcp_tool_use) whose result blocks live in the SAME assistant message.
    // If the stream was interrupted before the result arrived, the use block
    // has no matching *_tool_result and the API rejects with e.g. "advisor
    // tool use without corresponding advisor_tool_result".
    const seenToolUseIds = new Set<string>()
    const assistantContent = Array.isArray(aMsg5.message.content)
      ? aMsg5.message.content
      : []
    const finalContent = assistantContent.filter(block => {
      if (typeof block === 'string') return true
      if (block.type === 'tool_use') {
        if (allSeenToolUseIds.has((block as ToolUseBlock).id)) {
          repaired = true
          return false
        }
        allSeenToolUseIds.add((block as ToolUseBlock).id)
        seenToolUseIds.add((block as ToolUseBlock).id)
      }
      if (
        ((block.type as string) === 'server_tool_use' ||
          (block.type as string) === 'mcp_tool_use') &&
        !serverResultIds.has((block as { id: string }).id)
      ) {
        repaired = true
        return false
      }
      return true
    })

    const assistantContentChanged =
      finalContent.length !==
      (aMsg5.message.content as (ContentBlockParam | ContentBlock)[]).length

    // If stripping orphaned server tool uses empties the content array,
    // insert a placeholder so the API doesn't reject empty assistant content.
    if (finalContent.length === 0) {
      finalContent.push({
        type: 'text' as const,
        text: '[Tool use interrupted]',
        citations: [],
      })
    }

    const assistantMsg = assistantContentChanged
      ? {
          ...msg,
          message: { ...msg.message, content: finalContent },
        }
      : msg

    result.push(assistantMsg)

    // Collect tool_use IDs from this assistant message
    const toolUseIds = [...seenToolUseIds]

    // Check the next message for matching tool_results. Also track duplicate
    // tool_result blocks (same tool_use_id appearing twice) — for transcripts
    // corrupted before Fix 1 shipped, the orphan handler ran to completion
    // multiple times, producing [asst(X), user(tr_X), asst(X), user(tr_X)] which
    // normalizeMessagesForAPI merges to [asst([X,X]), user([tr_X,tr_X])]. The
    // tool_use dedup above strips the second X; without also stripping the
    // second tr_X, the API rejects with a duplicate-tool_result 400 and the
    // session stays stuck.
    const nextMsg = messages[i + 1]
    const existingToolResultIds = new Set<string>()
    let hasDuplicateToolResults = false

    if (nextMsg?.type === 'user') {
      const content = nextMsg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            const trId = (block as ToolResultBlockParam).tool_use_id
            if (existingToolResultIds.has(trId)) {
              hasDuplicateToolResults = true
            }
            existingToolResultIds.add(trId)
          }
        }
      }
    }

    // Find missing tool_result IDs (forward direction: tool_use without tool_result)
    const toolUseIdSet = new Set(toolUseIds)
    const missingIds = toolUseIds.filter(id => !existingToolResultIds.has(id))

    // Find orphaned tool_result IDs (reverse direction: tool_result without tool_use)
    const orphanedIds = [...existingToolResultIds].filter(
      id => !toolUseIdSet.has(id),
    )

    if (
      missingIds.length === 0 &&
      orphanedIds.length === 0 &&
      !hasDuplicateToolResults
    ) {
      continue
    }

    repaired = true

    // Build synthetic error tool_result blocks for missing IDs
    const syntheticBlocks: ToolResultBlockParam[] = missingIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }))

    if (nextMsg?.type === 'user') {
      // Next message is already a user message - patch it
      const nextUserMsg = nextMsg as UserMessage
      let content: (ContentBlockParam | ContentBlock)[] = Array.isArray(
        nextUserMsg.message.content,
      )
        ? (nextUserMsg.message.content as (ContentBlockParam | ContentBlock)[])
        : [
            {
              type: 'text' as const,
              text: (nextUserMsg.message.content as string | undefined) ?? '',
            },
          ]

      // Strip orphaned tool_results and dedupe duplicate tool_result IDs
      if (orphanedIds.length > 0 || hasDuplicateToolResults) {
        const orphanedSet = new Set(orphanedIds)
        const seenTrIds = new Set<string>()
        content = content.filter(block => {
          if (
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            const trId = (block as ToolResultBlockParam).tool_use_id
            if (orphanedSet.has(trId)) return false
            if (seenTrIds.has(trId)) return false
            seenTrIds.add(trId)
          }
          return true
        })
      }

      const patchedContent = [...syntheticBlocks, ...content]

      // If content is now empty after stripping orphans, skip the user message
      if (patchedContent.length > 0) {
        const patchedNext: UserMessage = {
          ...nextUserMsg,
          message: {
            ...nextUserMsg.message,
            content: patchedContent,
          },
        }
        i++
        // Prepending synthetics to existing content can produce a
        // [tool_result, text] sibling the smoosh inside normalize never saw
        // (pairing runs after normalize). Re-smoosh just this one message.
        result.push(
          checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_chair_sermon')
            ? smooshSystemReminderSiblings([patchedNext])[0]!
            : patchedNext,
        )
      } else {
        // Content is empty after stripping orphaned tool_results. We still
        // need a user message here to maintain role alternation — unless the
        // previous result entry is already a user message, in which case
        // inserting another user placeholder creates consecutive-user messages
        // that Anthropic rejects with a misleading "tool_use without
        // tool_result" 400 (CC-1215).
        i++
        if (result.at(-1)?.type === 'user') {
          continue
        }
        result.push(
          createUserMessage({
            content: NO_CONTENT_MESSAGE,
            isMeta: true,
          }),
        )
      }
    } else {
      // No user message follows - insert a synthetic user message (only if missing IDs)
      if (syntheticBlocks.length > 0) {
        result.push(
          createUserMessage({
            content: syntheticBlocks,
            isMeta: true,
          }),
        )
      }
    }
  }

  if (repaired) {
    // Capture diagnostic info to help identify root cause
    const messageTypes = messages.map((m, idx) => {
      if (m.type === 'assistant') {
        const contentArr = Array.isArray(m.message.content)
          ? m.message.content
          : []
        const toolUses = contentArr
          .filter(b => typeof b !== 'string' && b.type === 'tool_use')
          .map(b => (b as ToolUseBlock | ToolUseBlockParam).id)
        const serverToolUses = contentArr
          .filter(
            b =>
              typeof b !== 'string' &&
              ((b.type as string) === 'server_tool_use' ||
                (b.type as string) === 'mcp_tool_use'),
          )
          .map(b => (b as { id: string }).id)
        const parts = [
          `id=${m.message.id}`,
          `tool_uses=[${toolUses.join(',')}]`,
        ]
        if (serverToolUses.length > 0) {
          parts.push(`server_tool_uses=[${serverToolUses.join(',')}]`)
        }
        return `[${idx}] assistant(${parts.join(', ')})`
      }
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        const toolResults = m.message.content
          .filter(
            b =>
              typeof b === 'object' && 'type' in b && b.type === 'tool_result',
          )
          .map(b => (b as ToolResultBlockParam).tool_use_id)
        if (toolResults.length > 0) {
          return `[${idx}] user(tool_results=[${toolResults.join(',')}])`
        }
      }
      return `[${idx}] ${m.type}`
    })

    if (getStrictToolResultPairing()) {
      throw new Error(
        `ensureToolResultPairing: tool_use/tool_result pairing mismatch detected (strict mode). ` +
          `Refusing to repair — would inject synthetic placeholders into model context. ` +
          `Message structure: ${messageTypes.join('; ')}. See inc-4977.`,
      )
    }

    logEvent('tengu_tool_result_pairing_repaired', {
      messageCount: messages.length,
      repairedMessageCount: result.length,
      messageTypes: messageTypes.join(
        '; ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logError(
      new Error(
        `ensureToolResultPairing: repaired missing tool_result blocks (${messages.length} -> ${result.length} messages). Message structure: ${messageTypes.join('; ')}`,
      ),
    )
  }

  return result
}
