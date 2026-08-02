/**
 * Pre-computed message lookups: the full rebuild, the append-only incremental
 * updater and the structural cache key that guards them.
 */
import type {
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  NormalizedMessage,
  ProgressMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type HookAttachmentWithName,
  isHookAttachmentMessage,
} from './shared.js'

export type MessageLookups = {
  siblingToolUseIDs: Map<string, Set<string>>
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>
  inProgressHookCounts: Map<string, Map<HookEvent, number>>
  resolvedHookCounts: Map<string, Map<HookEvent, number>>
  /** Maps tool_use_id to the user message containing its tool_result */
  toolResultByToolUseID: Map<string, NormalizedMessage>
  /** Maps tool_use_id to the ToolUseBlockParam */
  toolUseByToolUseID: Map<string, ToolUseBlockParam>
  /** Total count of normalized messages (for truncation indicator text) */
  normalizedMessageCount: number
  /** Set of tool use IDs that have a corresponding tool_result */
  resolvedToolUseIDs: Set<string>
  /** Set of tool use IDs that have an errored tool_result */
  erroredToolUseIDs: Set<string>
}

/**
 * Derivation state the incremental updater needs but no caller ever reads.
 *
 * `buildMessageLookups` used to throw these away, which is why the incremental
 * path could not reproduce three of the rebuild's decisions (sibling grouping
 * across a shared message id, hook-name dedup, and re-judging a deferred
 * orphan). Keeping them in a WeakMap keyed by the lookups object means the
 * public `MessageLookups` shape is unchanged and the state dies with the
 * lookups it belongs to.
 *
 * A missing entry is a hard signal that the updater cannot trust the object it
 * was handed (e.g. `EMPTY_LOOKUPS`), so it asks for a full rebuild instead.
 */
type LookupBookkeeping = {
  /** assistant message id -> the sibling Set shared by every tool use in it */
  toolUseIDsByMessageID: Map<string | undefined, Set<string>>
  /** tool use id -> hook event -> distinct hook names (source of the counts) */
  resolvedHookNames: Map<string, Map<HookEvent, Set<string>>>
  /**
   * server/mcp tool_use blocks that were skipped because they belong to the
   * trailing assistant message and may still be in flight. Keyed by that
   * message id so they can be re-judged once it stops being the trailing one.
   */
  deferredOrphanCandidates: Map<string | undefined, string[]>
}

const lookupBookkeeping = new WeakMap<MessageLookups, LookupBookkeeping>()

/**
 * Re-judge deferred orphan candidates against the new trailing assistant
 * message. Anything that is no longer shielded by "might still be streaming"
 * and still has no result is marked errored, matching what a full rebuild
 * would decide at this point. O(deferred), not O(messages).
 */
function sweepDeferredOrphans(
  lookups: MessageLookups,
  bookkeeping: LookupBookkeeping,
  lastAssistantMsgId: string | undefined,
): void {
  for (const [messageID, ids] of bookkeeping.deferredOrphanCandidates) {
    // Still the trailing message — keep deferring, it may yet resolve.
    if (messageID === lastAssistantMsgId) continue
    for (const id of ids) {
      if (!lookups.resolvedToolUseIDs.has(id)) {
        lookups.resolvedToolUseIDs.add(id)
        lookups.erroredToolUseIDs.add(id)
      }
    }
    bookkeeping.deferredOrphanCandidates.delete(messageID)
  }
}

/**
 * Build pre-computed lookups for efficient O(1) access to message relationships.
 * Call once per render, then use the lookups for all messages.
 *
 * This avoids O(n²) behavior from calling getProgressMessagesForMessage,
 * getSiblingToolUseIDs, and hasUnresolvedHooks for each message.
 */
export function buildMessageLookups(
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): MessageLookups {
  // First pass: group assistant messages by ID and collect all tool use IDs per message
  const toolUseIDsByMessageID = new Map<string | undefined, Set<string>>()
  const toolUseIDToMessageID = new Map<string, string | undefined>()
  const toolUseByToolUseID = new Map<string, ToolUseBlockParam>()
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const aMsg = msg as AssistantMessage
      const id = aMsg.message.id
      let toolUseIDs = toolUseIDsByMessageID.get(id)
      if (!toolUseIDs) {
        toolUseIDs = new Set()
        toolUseIDsByMessageID.set(id, toolUseIDs)
      }
      if (Array.isArray(aMsg.message.content)) {
        for (const content of aMsg.message.content) {
          if (typeof content !== 'string' && content.type === 'tool_use') {
            const toolUseContent = content as ToolUseBlock
            toolUseIDs.add(toolUseContent.id)
            toolUseIDToMessageID.set(toolUseContent.id, id)
            toolUseByToolUseID.set(
              toolUseContent.id,
              content as ToolUseBlockParam,
            )
          }
        }
      }
    }
  }

  // Build sibling lookup - each tool use ID maps to all sibling tool use IDs
  const siblingToolUseIDs = new Map<string, Set<string>>()
  for (const [toolUseID, messageID] of toolUseIDToMessageID) {
    siblingToolUseIDs.set(toolUseID, toolUseIDsByMessageID.get(messageID)!)
  }

  // Single pass over normalizedMessages to build progress, hook, and tool result lookups
  const progressMessagesByToolUseID = new Map<string, ProgressMessage[]>()
  const inProgressHookCounts = new Map<string, Map<HookEvent, number>>()
  // Track unique hook names per (toolUseID, hookEvent) to match getResolvedHookCount behavior.
  // A single hook can produce multiple attachment messages (e.g., hook_success + hook_additional_context),
  // so we deduplicate by hookName.
  const resolvedHookNames = new Map<string, Map<HookEvent, Set<string>>>()
  const toolResultByToolUseID = new Map<string, NormalizedMessage>()
  // Track resolved/errored tool use IDs (replaces separate useMemos in Messages.tsx)
  const resolvedToolUseIDs = new Set<string>()
  const erroredToolUseIDs = new Set<string>()

  for (const msg of normalizedMessages) {
    if (msg.type === 'progress') {
      // Build progress messages lookup
      const toolUseID = msg.parentToolUseID as string
      const existing = progressMessagesByToolUseID.get(toolUseID)
      if (existing) {
        existing.push(msg as ProgressMessage)
      } else {
        progressMessagesByToolUseID.set(toolUseID, [msg as ProgressMessage])
      }

      // Count in-progress hooks
      const progressData = msg.data as { type: string; hookEvent: HookEvent }
      if (progressData.type === 'hook_progress') {
        const hookEvent = progressData.hookEvent
        let byHookEvent = inProgressHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          inProgressHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, (byHookEvent.get(hookEvent) ?? 0) + 1)
      }
    }

    // Build tool result lookup and resolved/errored sets
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content !== 'string' && content.type === 'tool_result') {
          const tr = content as ToolResultBlockParam
          toolResultByToolUseID.set(tr.tool_use_id, msg)
          resolvedToolUseIDs.add(tr.tool_use_id)
          if (tr.is_error) {
            erroredToolUseIDs.add(tr.tool_use_id)
          }
        }
      }
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content === 'string') continue
        // Track all server-side *_tool_result blocks (advisor, web_search,
        // code_execution, mcp, etc.) — any block with tool_use_id is a result.
        if (
          'tool_use_id' in content &&
          typeof (content as { tool_use_id: string }).tool_use_id === 'string'
        ) {
          resolvedToolUseIDs.add(
            (content as { tool_use_id: string }).tool_use_id,
          )
        }
        if ((content.type as string) === 'advisor_tool_result') {
          const result = content as {
            tool_use_id: string
            content: { type: string }
          }
          if (result.content.type === 'advisor_tool_result_error') {
            erroredToolUseIDs.add(result.tool_use_id)
          }
        }
      }
    }

    // Count resolved hooks (deduplicate by hookName)
    if (isHookAttachmentMessage(msg)) {
      const toolUseID = msg.attachment.toolUseID
      const hookEvent = msg.attachment.hookEvent
      const hookName = (msg.attachment as HookAttachmentWithName).hookName
      if (hookName !== undefined) {
        let byHookEvent = resolvedHookNames.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          resolvedHookNames.set(toolUseID, byHookEvent)
        }
        let names = byHookEvent.get(hookEvent)
        if (!names) {
          names = new Set()
          byHookEvent.set(hookEvent, names)
        }
        names.add(hookName)
      }
    }
  }

  // Convert resolved hook name sets to counts
  const resolvedHookCounts = new Map<string, Map<HookEvent, number>>()
  for (const [toolUseID, byHookEvent] of resolvedHookNames) {
    const countMap = new Map<HookEvent, number>()
    for (const [hookEvent, names] of byHookEvent) {
      countMap.set(hookEvent, names.size)
    }
    resolvedHookCounts.set(toolUseID, countMap)
  }

  // Mark orphaned server_tool_use / mcp_tool_use blocks (no matching
  // result) as errored so the UI shows them as failed instead of
  // perpetually spinning.
  const lastMsg = messages.at(-1)
  const lastAssistantMsgId =
    lastMsg?.type === 'assistant' ? lastMsg.message?.id : undefined
  const deferredOrphanCandidates = new Map<string | undefined, string[]>()
  for (const msg of normalizedMessages) {
    if (msg.type !== 'assistant') continue
    const aMsg = msg as AssistantMessage
    if (!Array.isArray(aMsg.message.content)) continue
    // Blocks from the last original message are only deferred, not cleared:
    // that message may still be in progress. Recording them lets the
    // incremental updater re-judge them later exactly as a rebuild would.
    const deferred = aMsg.message.id === lastAssistantMsgId
    for (const content of aMsg.message.content) {
      if (typeof content === 'string') continue
      if (
        (content.type as string) !== 'server_tool_use' &&
        (content.type as string) !== 'mcp_tool_use'
      ) {
        continue
      }
      const id = (content as { id: string }).id
      if (deferred) {
        const pending = deferredOrphanCandidates.get(aMsg.message.id)
        if (pending) {
          pending.push(id)
        } else {
          deferredOrphanCandidates.set(aMsg.message.id, [id])
        }
        continue
      }
      if (!resolvedToolUseIDs.has(id)) {
        resolvedToolUseIDs.add(id)
        erroredToolUseIDs.add(id)
      }
    }
  }

  const lookups: MessageLookups = {
    siblingToolUseIDs,
    progressMessagesByToolUseID,
    inProgressHookCounts,
    resolvedHookCounts,
    toolResultByToolUseID,
    toolUseByToolUseID,
    normalizedMessageCount: normalizedMessages.length,
    resolvedToolUseIDs,
    erroredToolUseIDs,
  }

  lookupBookkeeping.set(lookups, {
    toolUseIDsByMessageID,
    resolvedHookNames,
    deferredOrphanCandidates,
  })

  return lookups
}

/**
 * Incrementally update lookups by processing only newly appended messages.
 * Returns the same lookups object (mutated in place) if update succeeds,
 * or null if a full rebuild is needed (e.g., messages were removed).
 */
export function updateMessageLookupsIncremental(
  existing: MessageLookups,
  previousNormalizedCount: number,
  previousMessageCount: number,
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): MessageLookups | null {
  // Without the rebuild's derivation state we cannot reproduce its decisions,
  // so the only honest answer is "rebuild".
  const bookkeeping = lookupBookkeeping.get(existing)
  if (!bookkeeping) {
    return null
  }

  // Safety check: only handle append-only case
  if (
    normalizedMessages.length < previousNormalizedCount ||
    messages.length < previousMessageCount
  ) {
    return null
  }

  const lastMsg = messages.at(-1)
  const lastAssistantMsgId =
    lastMsg?.type === 'assistant' ? lastMsg.message?.id : undefined

  // No new messages — nothing to do, UNLESS the trailing message is a
  // progress tick. REPL.tsx replaces ephemeral progress (Bash/PowerShell/MCP)
  // in-place to bound the messages array — same length, but the trailing
  // progress is a fresh tick. Returning `existing` here would leave
  // progressMessagesByToolUseID stuck on the first tick and elapsed-time
  // displays (ShellProgressMessage) would freeze. Force a full rebuild so
  // the fresh tick propagates.
  if (
    normalizedMessages.length === previousNormalizedCount &&
    messages.length === previousMessageCount
  ) {
    const lastNormalized = normalizedMessages[normalizedMessages.length - 1]
    if (lastNormalized && lastNormalized.type === 'progress') {
      return null
    }
    sweepDeferredOrphans(existing, bookkeeping, lastAssistantMsgId)
    return existing
  }

  // Process new messages entries (pass 1: assistant tool_use blocks)
  const newMessageStart = previousMessageCount
  for (let i = newMessageStart; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant') {
      const aMsg = msg as AssistantMessage
      const id = aMsg.message.id
      // Siblings are grouped by message id, not by array entry: a streamed
      // assistant turn can arrive as several entries sharing one id, and the
      // rebuild puts all of their tool uses in one sibling set. Reusing the
      // Set stored under that id keeps earlier entries — which already point
      // at this very Set — in sync for free.
      let siblings = bookkeeping.toolUseIDsByMessageID.get(id)
      if (!siblings) {
        siblings = new Set()
        bookkeeping.toolUseIDsByMessageID.set(id, siblings)
      }
      if (Array.isArray(aMsg.message.content)) {
        for (const content of aMsg.message.content) {
          if (typeof content !== 'string' && content.type === 'tool_use') {
            const toolUseContent = content as ToolUseBlock
            existing.toolUseByToolUseID.set(
              toolUseContent.id,
              content as ToolUseBlockParam,
            )
            siblings.add(toolUseContent.id)
            existing.siblingToolUseIDs.set(toolUseContent.id, siblings)
          }
        }
      }
    }
  }

  // Process new normalizedMessages entries (pass 2: progress, hooks, tool results)
  const newNormalizedStart = previousNormalizedCount
  for (let i = newNormalizedStart; i < normalizedMessages.length; i++) {
    const msg = normalizedMessages[i]!

    if (msg.type === 'progress') {
      const toolUseID = msg.parentToolUseID as string
      const existing2 = existing.progressMessagesByToolUseID.get(toolUseID)
      if (existing2) {
        existing2.push(msg as ProgressMessage)
      } else {
        existing.progressMessagesByToolUseID.set(toolUseID, [
          msg as ProgressMessage,
        ])
      }

      const progressData = msg.data as { type: string; hookEvent: HookEvent }
      if (progressData.type === 'hook_progress') {
        const hookEvent = progressData.hookEvent
        let byHookEvent = existing.inProgressHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          existing.inProgressHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, (byHookEvent.get(hookEvent) ?? 0) + 1)
      }
    }

    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content !== 'string' && content.type === 'tool_result') {
          const tr = content as ToolResultBlockParam
          existing.toolResultByToolUseID.set(tr.tool_use_id, msg)
          existing.resolvedToolUseIDs.add(tr.tool_use_id)
          if (tr.is_error) {
            existing.erroredToolUseIDs.add(tr.tool_use_id)
          }
        }
      }
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content === 'string') continue
        if (
          'tool_use_id' in content &&
          typeof (content as { tool_use_id: string }).tool_use_id === 'string'
        ) {
          existing.resolvedToolUseIDs.add(
            (content as { tool_use_id: string }).tool_use_id,
          )
        }
        if ((content.type as string) === 'advisor_tool_result') {
          const result = content as {
            tool_use_id: string
            content: { type: string }
          }
          if (result.content.type === 'advisor_tool_result_error') {
            existing.erroredToolUseIDs.add(result.tool_use_id)
          }
        }
      }
    }

    if (isHookAttachmentMessage(msg)) {
      const toolUseID = msg.attachment.toolUseID
      const hookEvent = msg.attachment.hookEvent
      const hookName = (msg.attachment as HookAttachmentWithName).hookName
      if (hookName !== undefined) {
        // Count distinct hook names, not attachment messages: one hook can
        // emit several (hook_success + hook_additional_context), and the
        // rebuild — like getResolvedHookCount — reports it once.
        let namesByHookEvent = bookkeeping.resolvedHookNames.get(toolUseID)
        if (!namesByHookEvent) {
          namesByHookEvent = new Map()
          bookkeeping.resolvedHookNames.set(toolUseID, namesByHookEvent)
        }
        let names = namesByHookEvent.get(hookEvent)
        if (!names) {
          names = new Set()
          namesByHookEvent.set(hookEvent, names)
        }
        names.add(hookName)

        let byHookEvent = existing.resolvedHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          existing.resolvedHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, names.size)
      }
    }
  }

  existing.normalizedMessageCount = normalizedMessages.length

  // Mark orphaned server_tool_use / mcp_tool_use blocks as errored. Only the
  // new normalizedMessages are classified here — older ones were already
  // judged — but anything the trailing-message rule shielded back then is
  // re-judged by the sweep below, which is what a rebuild would do.
  for (let i = newNormalizedStart; i < normalizedMessages.length; i++) {
    const msg = normalizedMessages[i]!
    if (msg.type !== 'assistant') continue
    const aMsg = msg as AssistantMessage
    if (!Array.isArray(aMsg.message.content)) continue
    const deferred = aMsg.message.id === lastAssistantMsgId
    for (const content of aMsg.message.content) {
      if (typeof content === 'string') continue
      if (
        (content.type as string) !== 'server_tool_use' &&
        (content.type as string) !== 'mcp_tool_use'
      ) {
        continue
      }
      const id = (content as { id: string }).id
      if (deferred) {
        const pending = bookkeeping.deferredOrphanCandidates.get(
          aMsg.message.id,
        )
        if (pending) {
          pending.push(id)
        } else {
          bookkeeping.deferredOrphanCandidates.set(aMsg.message.id, [id])
        }
        continue
      }
      if (!existing.resolvedToolUseIDs.has(id)) {
        existing.resolvedToolUseIDs.add(id)
        existing.erroredToolUseIDs.add(id)
      }
    }
  }

  sweepDeferredOrphans(existing, bookkeeping, lastAssistantMsgId)

  return existing
}

/**
 * Compute a lightweight structural fingerprint for buildMessageLookups caching.
 * Only captures information that affects lookup results (types, IDs, counts),
 * not content. Returns an empty string when the arrays are structurally empty.
 *
 * O(n) but allocates only a string — much cheaper than the 8 Maps/Sets that
 * buildMessageLookups creates on every call.
 */
export function computeMessageStructureKey(
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): string {
  const parts: string[] = [
    String(normalizedMessages.length),
    '|',
    String(messages.length),
  ]
  for (const msg of messages) {
    parts.push(msg.type[0])
    if (msg.type === 'assistant') {
      const aMsg = msg as AssistantMessage
      const content = aMsg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'string' && block.type === 'tool_use') {
            parts.push('t', (block as ToolUseBlock).id)
          }
        }
      }
    } else if (msg.type === 'user') {
      const content = (msg as UserMessage).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'string' && block.type === 'tool_result') {
            parts.push('r', (block as ToolResultBlockParam).tool_use_id)
          }
        }
      }
    }
  }
  for (const msg of normalizedMessages) {
    if (msg.type === 'progress') {
      const pMsg = msg as ProgressMessage
      // Include uuid so ephemeral progress tick replacements
      // (Bash/PowerShell/MCP) invalidate the lookups cache. Without this,
      // REPL.tsx's in-place tick replacement (same parentToolUseID, same
      // length) yields an identical key, lookups cache the first tick
      // forever, and ShellProgressMessage's elapsed time freezes.
      parts.push('p', pMsg.parentToolUseID as string, pMsg.uuid)
    }
  }
  return parts.join(',')
}
