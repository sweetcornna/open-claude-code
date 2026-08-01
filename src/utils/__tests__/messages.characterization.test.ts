/**
 * Characterization tests for `src/utils/messages.ts`.
 *
 * This module is ~6k lines and is scheduled to be split into smaller modules.
 * These tests pin down the *observable* behaviour that must survive the split:
 * the public export surface, the shape `normalizeMessagesForAPI` hands to the
 * API, the repair rules in `ensureToolResultPairing`, and — most importantly —
 * the equivalence between `buildMessageLookups` (full rebuild) and
 * `updateMessageLookupsIncremental` (append-only fast path).
 *
 * They describe what the code does today, not what it ought to do. Where the
 * two lookup paths already disagree, the disagreement is pinned explicitly and
 * labelled, so a later refactor has to make a conscious decision about it
 * instead of silently changing behaviour.
 *
 * No `mock.module` calls: `messages.ts` is importable as-is (see the existing
 * `messages.test.ts`), and mocking anything here would leak into every other
 * test file in the process.
 */
import { describe, expect, test } from 'bun:test'
import {
  getStrictToolResultPairing,
  setStrictToolResultPairing,
} from 'src/bootstrap/state.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import {
  assistantServerToolUseOrphaned,
  assistantText,
  assistantThinking,
  assistantToolUse,
  fixtureUuid,
  growingConversation,
  hookSuccessAttachment,
  progressTick,
  userText,
  userToolResult,
} from '../../../tests/mocks/fixtures/conversation.js'
import * as messagesModule from '../messages.js'
import {
  buildMessageLookups,
  computeMessageStructureKey,
  ensureToolResultPairing,
  filterOrphanedThinkingOnlyMessages,
  type MessageLookups,
  mergeUserMessages,
  normalizeMessages,
  normalizeMessagesForAPI,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  updateMessageLookupsIncremental,
} from '../messages.js'

// ─── 1. Export surface ───────────────────────────────────────────────────

/**
 * Generated from `Object.keys(await import('src/utils/messages.ts')).sort()`.
 * Type-only exports are absent by construction (they have no runtime binding).
 *
 * Splitting `messages.ts` into modules must keep this list identical — the
 * barrel that replaces it is only a safe drop-in if every name still resolves.
 * Adding a name is a deliberate act: extend the list in the same commit.
 */
const EXPECTED_RUNTIME_EXPORTS = [
  'AUTO_REJECT_MESSAGE',
  'CANCEL_MESSAGE',
  'DENIAL_WORKAROUND_GUIDANCE',
  'DONT_ASK_REJECT_MESSAGE',
  'EMPTY_LOOKUPS',
  'EMPTY_STRING_SET',
  'INTERRUPT_MESSAGE',
  'INTERRUPT_MESSAGE_FOR_TOOL_USE',
  'NO_RESPONSE_REQUESTED',
  'PLAN_PHASE4_CONTROL',
  'PLAN_REJECTION_PREFIX',
  'REJECT_MESSAGE',
  'REJECT_MESSAGE_WITH_REASON_PREFIX',
  'SUBAGENT_REJECT_MESSAGE',
  'SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX',
  'SYNTHETIC_MESSAGES',
  'SYNTHETIC_MODEL',
  'SYNTHETIC_TOOL_RESULT_PLACEHOLDER',
  'buildClassifierUnavailableMessage',
  'buildMessageLookups',
  'buildSubagentLookups',
  'buildYoloRejectionMessage',
  'computeMessageStructureKey',
  'countToolCalls',
  'createAgentsKilledMessage',
  'createApiMetricsMessage',
  'createAssistantAPIErrorMessage',
  'createAssistantMessage',
  'createAwaySummaryMessage',
  'createBridgeStatusMessage',
  'createCommandInputMessage',
  'createCompactBoundaryMessage',
  'createMemorySavedMessage',
  'createMicrocompactBoundaryMessage',
  'createModelSwitchBreadcrumbs',
  'createPermissionRetryMessage',
  'createProgressMessage',
  'createScheduledTaskFireMessage',
  'createStopHookSummaryMessage',
  'createSyntheticUserCaveatMessage',
  'createSystemAPIErrorMessage',
  'createSystemMessage',
  'createToolResultStopMessage',
  'createToolUseSummaryMessage',
  'createTurnDurationMessage',
  'createUserInterruptionMessage',
  'createUserMessage',
  'deriveShortMessageId',
  'deriveUUID',
  'ensureToolResultPairing',
  'extractTag',
  'extractTextContent',
  'filterOrphanedThinkingOnlyMessages',
  'filterUnresolvedToolUses',
  'filterWhitespaceOnlyAssistantMessages',
  'findLastCompactBoundaryIndex',
  'formatCommandInputTags',
  'getAssistantMessageText',
  'getContentText',
  'getLastAssistantMessage',
  'getMessagesAfterCompactBoundary',
  'getProgressMessagesFromLookup',
  'getSiblingToolUseIDs',
  'getSiblingToolUseIDsFromLookup',
  'getToolResultIDs',
  'getToolUseID',
  'getToolUseIDs',
  'getUserMessageText',
  'handleMessageFromStream',
  'hasSuccessfulToolCall',
  'hasToolCallsInLastAssistantTurn',
  'hasUnresolvedHooks',
  'hasUnresolvedHooksFromLookup',
  'isClassifierDenial',
  'isCompactBoundaryMessage',
  'isEmptyMessageText',
  'isNotEmptyMessage',
  'isSyntheticMessage',
  'isSystemLocalCommandMessage',
  'isThinkingMessage',
  'isToolUseRequestMessage',
  'isToolUseResultMessage',
  'mergeAssistantMessages',
  'mergeUserContentBlocks',
  'mergeUserMessages',
  'mergeUserMessagesAndToolResults',
  'normalizeAttachmentForAPI',
  'normalizeContentFromAPI',
  'normalizeMessages',
  'normalizeMessagesForAPI',
  'prepareUserContent',
  'reorderAttachmentsForAPI',
  'reorderMessagesInUI',
  'shouldShowUserMessage',
  'stripAdvisorBlocks',
  'stripCallerFieldFromAssistantMessage',
  'stripPromptXMLTags',
  'stripSignatureBlocks',
  'stripToolReferenceBlocksFromUserMessage',
  'textForResubmit',
  'updateMessageLookupsIncremental',
  'withMemoryCorrectionHint',
  'wrapCommandText',
  'wrapInSystemReminder',
  'wrapMessagesInSystemReminder',
]

describe('messages module export surface', () => {
  test('exposes exactly the recorded set of runtime exports', () => {
    expect(Object.keys(messagesModule).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS)
  })

  test('every recorded export is defined', () => {
    const bag = messagesModule as unknown as Record<string, unknown>
    const undefinedExports = EXPECTED_RUNTIME_EXPORTS.filter(
      name => bag[name] === undefined,
    )
    expect(undefinedExports).toEqual([])
  })
})

// ─── 2. Golden behaviour ─────────────────────────────────────────────────

describe('normalizeMessagesForAPI', () => {
  function toolConversation(): Message[] {
    return [
      userText(fixtureUuid(1), 'hello'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_1', 'a\nb'),
      assistantText({ messageId: 'msg_2', uuid: fixtureUuid(4) }, 'all done'),
    ]
  }

  test('passes a well-formed user/assistant/tool conversation through unchanged in shape', () => {
    const result = normalizeMessagesForAPI(toolConversation())

    expect(result.map(m => m.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(result.map(m => m.uuid)).toEqual([
      fixtureUuid(1),
      fixtureUuid(2),
      fixtureUuid(3),
      fixtureUuid(4),
    ])
    expect(
      result.map(m =>
        (m.message.content as Array<{ type: string }>).map(b => b.type),
      ),
    ).toEqual([['text'], ['tool_use'], ['tool_result'], ['text']])
  })

  test('keeps the tool_use block id/name/input intact', () => {
    const result = normalizeMessagesForAPI(toolConversation())
    const toolUse = (
      result[1]!.message.content as unknown as Array<Record<string, unknown>>
    )[0]!

    expect(toolUse).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'ls' },
    })
  })

  test('drops progress messages and keeps the tool_result paired with its tool_use', () => {
    const withProgress: Message[] = [
      ...toolConversation().slice(0, 2),
      progressTick(fixtureUuid(90), 'toolu_1'),
      ...toolConversation().slice(2),
    ]

    const result = normalizeMessagesForAPI(withProgress)

    expect(result.map(m => m.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
  })

  test('merges consecutive user messages into one turn, separating text at the seam', () => {
    const result = normalizeMessagesForAPI([
      userText(fixtureUuid(1), 'first'),
      userText(fixtureUuid(2), 'second'),
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(3) }, 'ack'),
    ])

    expect(result).toHaveLength(2)
    expect(result[0]!.message.content).toEqual([
      { type: 'text', text: 'first\n' },
      { type: 'text', text: 'second' },
    ])
  })

  test('strips messages flagged isVirtual before they reach the API', () => {
    const virtual = {
      ...userText(fixtureUuid(5), 'display only'),
      isVirtual: true,
    } as UserMessage

    const result = normalizeMessagesForAPI([
      userText(fixtureUuid(1), 'hello'),
      virtual,
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'ack'),
    ])

    expect(result.map(m => m.uuid)).toEqual([fixtureUuid(1), fixtureUuid(2)])
  })

  test('merges two assistant messages that share a message id', () => {
    const result = normalizeMessagesForAPI([
      userText(fixtureUuid(1), 'go'),
      assistantThinking({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'hmm'),
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(3) }, 'answer'),
    ])

    expect(result).toHaveLength(2)
    expect(
      (result[1]!.message.content as Array<{ type: string }>).map(b => b.type),
    ).toEqual(['thinking', 'text'])
  })
})

describe('mergeUserMessages', () => {
  test('joins two text-only user messages with a newline on the left side', () => {
    const merged = mergeUserMessages(
      userText(fixtureUuid(1), 'first'),
      userText(fixtureUuid(2), 'second'),
    )

    expect(merged.message.content).toEqual([
      { type: 'text', text: 'first\n' },
      { type: 'text', text: 'second' },
    ])
  })

  test('keeps the left message uuid when the left message is not meta', () => {
    const merged = mergeUserMessages(
      userText(fixtureUuid(1), 'first'),
      userText(fixtureUuid(2), 'second'),
    )

    expect(merged.uuid).toBe(fixtureUuid(1))
  })

  test('adopts the right message uuid when the left message is meta', () => {
    const meta = {
      ...userText(fixtureUuid(1), 'meta'),
      isMeta: true,
    } as UserMessage
    const merged = mergeUserMessages(meta, userText(fixtureUuid(2), 'real'))

    expect(merged.uuid).toBe(fixtureUuid(2))
  })

  test('hoists tool_result blocks ahead of text blocks', () => {
    const merged = mergeUserMessages(
      userText(fixtureUuid(1), 'text first'),
      userToolResult(fixtureUuid(2), 'toolu_1', 'result'),
    )

    expect(
      (merged.message.content as Array<{ type: string }>).map(b => b.type),
    ).toEqual(['tool_result', 'text'])
  })

  test('does not insert a seam newline when the left side ends in a tool_result', () => {
    const merged = mergeUserMessages(
      userToolResult(fixtureUuid(1), 'toolu_1', 'result'),
      userText(fixtureUuid(2), 'follow up'),
    )

    expect(merged.message.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
      { type: 'text', text: 'follow up' },
    ])
  })
})

describe('filterOrphanedThinkingOnlyMessages', () => {
  test('drops a thinking-only assistant whose message id has no other content', () => {
    const messages = [
      assistantThinking({ messageId: 'msg_a', uuid: fixtureUuid(1) }, 'orphan'),
      userText(fixtureUuid(2), 'hi'),
    ] as (UserMessage | AssistantMessage)[]

    expect(
      filterOrphanedThinkingOnlyMessages(messages).map(m => m.uuid),
    ).toEqual([fixtureUuid(2)])
  })

  test('keeps a thinking-only assistant that will merge with a sibling of the same id', () => {
    const messages = [
      assistantThinking({ messageId: 'msg_b', uuid: fixtureUuid(1) }, 'paired'),
      assistantText({ messageId: 'msg_b', uuid: fixtureUuid(2) }, 'visible'),
    ] as (UserMessage | AssistantMessage)[]

    expect(
      filterOrphanedThinkingOnlyMessages(messages).map(m => m.uuid),
    ).toEqual([fixtureUuid(1), fixtureUuid(2)])
  })

  test('never drops non-assistant messages', () => {
    const messages = [
      userText(fixtureUuid(1), 'a'),
      userToolResult(fixtureUuid(2), 'toolu_1', 'b'),
    ] as (UserMessage | AssistantMessage)[]

    expect(
      filterOrphanedThinkingOnlyMessages(messages).map(m => m.uuid),
    ).toEqual([fixtureUuid(1), fixtureUuid(2)])
  })
})

describe('ensureToolResultPairing', () => {
  test('leaves an already-paired conversation untouched', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_1', 'ok'),
    ] as (UserMessage | AssistantMessage)[]

    expect(ensureToolResultPairing(messages)).toEqual(messages)
  })

  test('appends a synthetic error tool_result for a tool_use with no result', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_missing', name: 'Bash' },
      ]),
    ] as (UserMessage | AssistantMessage)[]

    const result = ensureToolResultPairing(messages)

    expect(result).toHaveLength(3)
    expect(result[2]!.type).toBe('user')
    expect(result[2]!.isMeta).toBe(true)
    expect(result[2]!.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_missing',
        content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
        is_error: true,
      },
    ])
  })

  test('replaces a leading orphaned tool_result with a placeholder text block', () => {
    const messages = [
      userToolResult(fixtureUuid(1), 'toolu_gone', 'stale'),
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'hi'),
    ] as (UserMessage | AssistantMessage)[]

    const result = ensureToolResultPairing(messages)

    expect(result).toHaveLength(2)
    expect(result[0]!.message.content).toEqual([
      {
        type: 'text',
        text: '[Orphaned tool result removed due to conversation resume]',
      },
    ])
  })

  test('strips a tool_result whose id does not match the preceding tool_use', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_real', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_other', 'stale'),
    ] as (UserMessage | AssistantMessage)[]

    const result = ensureToolResultPairing(messages)
    const trailing = result.at(-1)!

    expect(
      (
        trailing.message.content as unknown as Array<Record<string, unknown>>
      ).map(b => b.tool_use_id),
    ).toEqual(['toolu_real'])
  })

  test('drops a duplicate tool_use id carried by a later assistant message', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_dup', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_dup', 'ok'),
      assistantToolUse({ messageId: 'msg_2', uuid: fixtureUuid(4) }, [
        { id: 'toolu_dup', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(5), 'toolu_dup', 'ok again'),
    ] as (UserMessage | AssistantMessage)[]

    const result = ensureToolResultPairing(messages)
    const toolUseIds = result.flatMap(m =>
      m.type === 'assistant'
        ? (m.message.content as unknown as Array<Record<string, unknown>>)
            .filter(b => b.type === 'tool_use')
            .map(b => b.id)
        : [],
    )

    expect(toolUseIds).toEqual(['toolu_dup'])
  })

  test('strips a server_tool_use whose result block never arrived', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantServerToolUseOrphaned(
        { messageId: 'msg_1', uuid: fixtureUuid(2) },
        'srvtoolu_orphan',
      ),
    ] as (UserMessage | AssistantMessage)[]

    const result = ensureToolResultPairing(messages)

    expect(result[1]!.message.content).toEqual([
      { type: 'text', text: '[Tool use interrupted]', citations: [] },
    ])
  })

  test('throws instead of repairing when strict tool result pairing is on', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_missing', name: 'Bash' },
      ]),
    ] as (UserMessage | AssistantMessage)[]

    // Strict mode is process-global module state, not a parameter. Flip it for
    // exactly one call and restore it in `finally` so no other test file can
    // observe the change.
    const previous = getStrictToolResultPairing()
    try {
      setStrictToolResultPairing(true)
      expect(() => ensureToolResultPairing(messages)).toThrow(
        /pairing mismatch detected \(strict mode\)/,
      )
    } finally {
      setStrictToolResultPairing(previous)
    }

    expect(getStrictToolResultPairing()).toBe(previous)
  })

  test('does not throw in strict mode when nothing needs repairing', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_1', 'ok'),
    ] as (UserMessage | AssistantMessage)[]

    const previous = getStrictToolResultPairing()
    try {
      setStrictToolResultPairing(true)
      expect(ensureToolResultPairing(messages)).toEqual(messages)
    } finally {
      setStrictToolResultPairing(previous)
    }
  })
})

// ─── 3. Lookup equivalence property (the safety net) ─────────────────────

type ReplayResult = {
  /** Lookups produced by the incremental path (with fallbacks when it bails). */
  incremental: MessageLookups
  /** Lookups produced by a fresh full rebuild over the same final input. */
  fresh: MessageLookups
  /** Steps at which the incremental updater asked for a full rebuild. */
  rebuildSteps: number[]
}

/**
 * Append `messages` one at a time, maintaining lookups the way the REPL does:
 * try `updateMessageLookupsIncremental` first, fall back to a full rebuild when
 * it returns null. `onStep` runs after every append with both views.
 */
function replayIncrementally(
  messages: Message[],
  onStep?: (
    step: number,
    incremental: MessageLookups,
    fresh: MessageLookups,
  ) => void,
): ReplayResult {
  const accumulated: Message[] = []
  const rebuildSteps: number[] = []
  let lookups: MessageLookups | null = null
  let previousNormalizedCount = 0
  let previousMessageCount = 0

  messages.forEach((message, step) => {
    accumulated.push(message)
    const normalized = normalizeMessages(accumulated)
    const fresh = buildMessageLookups(normalized, accumulated)

    const updated = lookups
      ? updateMessageLookupsIncremental(
          lookups,
          previousNormalizedCount,
          previousMessageCount,
          normalized,
          accumulated,
        )
      : null

    if (updated) {
      lookups = updated
    } else {
      if (lookups) rebuildSteps.push(step)
      lookups = buildMessageLookups(normalized, accumulated)
    }

    previousNormalizedCount = normalized.length
    previousMessageCount = accumulated.length
    onStep?.(step, lookups, fresh)
  })

  const finalNormalized = normalizeMessages(accumulated)
  return {
    incremental: lookups!,
    fresh: buildMessageLookups(finalNormalized, accumulated),
    rebuildSteps,
  }
}

describe('buildMessageLookups / updateMessageLookupsIncremental equivalence', () => {
  test('incremental state matches a full rebuild at every append step', () => {
    const conversation = growingConversation()
    let stepsChecked = 0

    const { rebuildSteps } = replayIncrementally(
      conversation,
      (step, incremental, fresh) => {
        stepsChecked++
        expect({ step, lookups: incremental }).toEqual({
          step,
          lookups: fresh,
        })
      },
    )

    expect(stepsChecked).toBe(conversation.length)
    // The whole point of the property: the fast path never bailed out, so the
    // equality above really did compare incremental state against a rebuild.
    expect(rebuildSteps).toEqual([])
  })

  test('each individual lookup table matches after the full replay', () => {
    const { incremental, fresh } = replayIncrementally(growingConversation())

    expect(incremental.siblingToolUseIDs).toEqual(fresh.siblingToolUseIDs)
    expect(incremental.progressMessagesByToolUseID).toEqual(
      fresh.progressMessagesByToolUseID,
    )
    expect(incremental.inProgressHookCounts).toEqual(fresh.inProgressHookCounts)
    expect(incremental.resolvedHookCounts).toEqual(fresh.resolvedHookCounts)
    expect(incremental.toolResultByToolUseID).toEqual(
      fresh.toolResultByToolUseID,
    )
    expect(incremental.toolUseByToolUseID).toEqual(fresh.toolUseByToolUseID)
    expect(incremental.normalizedMessageCount).toBe(
      fresh.normalizedMessageCount,
    )
    expect(incremental.resolvedToolUseIDs).toEqual(fresh.resolvedToolUseIDs)
    expect(incremental.erroredToolUseIDs).toEqual(fresh.erroredToolUseIDs)
  })

  test('the replayed conversation actually populates every lookup table', () => {
    const { fresh } = replayIncrementally(growingConversation())

    // Guards against the equivalence test passing vacuously on empty maps.
    expect(fresh.siblingToolUseIDs.size).toBeGreaterThan(0)
    expect(fresh.progressMessagesByToolUseID.size).toBeGreaterThan(0)
    expect(fresh.inProgressHookCounts.size).toBeGreaterThan(0)
    expect(fresh.resolvedHookCounts.size).toBeGreaterThan(0)
    expect(fresh.toolResultByToolUseID.size).toBeGreaterThan(0)
    expect(fresh.toolUseByToolUseID.size).toBeGreaterThan(0)
    expect(fresh.resolvedToolUseIDs.size).toBeGreaterThan(0)
    expect(fresh.erroredToolUseIDs.size).toBeGreaterThan(0)
  })

  test('pins the lookup values the replayed conversation produces', () => {
    const { fresh } = replayIncrementally(growingConversation())

    expect(
      [...fresh.siblingToolUseIDs].map(([id, siblings]) => [
        id,
        [...siblings].sort(),
      ]),
    ).toEqual([
      ['toolu_fixture_a', ['toolu_fixture_a', 'toolu_fixture_b']],
      ['toolu_fixture_b', ['toolu_fixture_a', 'toolu_fixture_b']],
      ['toolu_fixture_c', ['toolu_fixture_c']],
    ])
    expect(
      [...fresh.progressMessagesByToolUseID].map(([id, ticks]) => [
        id,
        ticks.length,
      ]),
    ).toEqual([
      ['toolu_fixture_a', 2],
      ['toolu_fixture_c', 1],
    ])
    expect(
      [...fresh.inProgressHookCounts].map(([id, m]) => [id, [...m]]),
    ).toEqual([['toolu_fixture_a', [['PreToolUse', 1]]]])
    expect(
      [...fresh.resolvedHookCounts].map(([id, m]) => [id, [...m]]),
    ).toEqual([['toolu_fixture_a', [['PreToolUse', 1]]]])
    expect([...fresh.resolvedToolUseIDs].sort()).toEqual([
      'srvtoolu_fixture_1',
      'toolu_fixture_a',
      'toolu_fixture_b',
      'toolu_fixture_c',
    ])
    expect([...fresh.erroredToolUseIDs]).toEqual(['toolu_fixture_b'])
  })

  test('returns null when the message arrays shrank', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'ack'),
    ]
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)

    expect(
      updateMessageLookupsIncremental(lookups, 99, 99, normalized, messages),
    ).toBeNull()
  })

  test('returns the same object when nothing was appended', () => {
    const messages = [
      userText(fixtureUuid(1), 'go'),
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'ack'),
    ]
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)

    expect(
      updateMessageLookupsIncremental(
        lookups,
        normalized.length,
        messages.length,
        normalized,
        messages,
      ),
    ).toBe(lookups)
  })

  test('forces a rebuild when the trailing message is a progress tick replaced in place', () => {
    const messages: Message[] = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      progressTick(fixtureUuid(3), 'toolu_1'),
    ]
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)

    // REPL replaces the ephemeral tick in place: same lengths, fresh tick.
    const replaced = [...messages]
    replaced[2] = progressTick(fixtureUuid(4), 'toolu_1')
    const replacedNormalized = normalizeMessages(replaced)

    expect(
      updateMessageLookupsIncremental(
        lookups,
        normalized.length,
        messages.length,
        replacedNormalized,
        replaced,
      ),
    ).toBeNull()
  })
})

// ─── 4. Known divergences between the two lookup paths ───────────────────

/**
 * These pin behaviour that is currently INCONSISTENT between the full rebuild
 * and the incremental updater. They are recorded, not endorsed. A refactor that
 * makes the two agree should update these tests deliberately, in a commit that
 * says so — the failure is the signal, not the bug.
 */
describe('lookup path divergences (recorded, not endorsed)', () => {
  test('siblings: the full rebuild groups by message id, the incremental path only within one message', () => {
    const { fresh, incremental } = replayIncrementally([
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_shared', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      assistantToolUse({ messageId: 'msg_shared', uuid: fixtureUuid(3) }, [
        { id: 'toolu_2', name: 'Read' },
      ]),
      userText(fixtureUuid(4), 'ok'),
    ])

    expect([...fresh.siblingToolUseIDs.get('toolu_1')!].sort()).toEqual([
      'toolu_1',
      'toolu_2',
    ])
    expect([...incremental.siblingToolUseIDs.get('toolu_1')!]).toEqual([
      'toolu_1',
    ])
  })

  test('resolved hooks: the full rebuild dedupes by hook name, the incremental path counts attachments', () => {
    const { fresh, incremental } = replayIncrementally([
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      hookSuccessAttachment(fixtureUuid(3), 'toolu_1', 'same-hook'),
      hookSuccessAttachment(fixtureUuid(4), 'toolu_1', 'same-hook'),
      userToolResult(fixtureUuid(5), 'toolu_1', 'ok'),
    ])

    expect(fresh.resolvedHookCounts.get('toolu_1')!.get('PreToolUse')).toBe(1)
    expect(
      incremental.resolvedHookCounts.get('toolu_1')!.get('PreToolUse'),
    ).toBe(2)
  })

  test('orphaned server tool uses: only the full rebuild re-scans older messages', () => {
    const { fresh, incremental } = replayIncrementally([
      userText(fixtureUuid(1), 'go'),
      assistantServerToolUseOrphaned(
        { messageId: 'msg_1', uuid: fixtureUuid(2) },
        'srvtoolu_orphan',
      ),
      userText(fixtureUuid(3), 'next'),
      assistantText({ messageId: 'msg_2', uuid: fixtureUuid(4) }, 'done'),
    ])

    expect([...fresh.erroredToolUseIDs]).toEqual(['srvtoolu_orphan'])
    expect([...incremental.erroredToolUseIDs]).toEqual([])
  })
})

// ─── 5. Structure key (the cache key guarding the lookups) ───────────────

describe('computeMessageStructureKey', () => {
  test('encodes lengths, message types, tool_use ids and tool_result ids', () => {
    const messages: Message[] = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_1', 'ok'),
    ]

    expect(
      computeMessageStructureKey(normalizeMessages(messages), messages),
    ).toBe('3,|,3,u,a,t,toolu_1,u,r,toolu_1')
  })

  test('returns the empty-shape key for empty inputs', () => {
    expect(computeMessageStructureKey([], [])).toBe('0,|,0')
  })

  test('changes when an ephemeral progress tick is replaced in place', () => {
    const base: Message[] = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      progressTick(fixtureUuid(3), 'toolu_1'),
    ]
    const replaced = [...base]
    replaced[2] = progressTick(fixtureUuid(4), 'toolu_1')

    expect(computeMessageStructureKey(normalizeMessages(base), base)).not.toBe(
      computeMessageStructureKey(normalizeMessages(replaced), replaced),
    )
  })
})
