/**
 * Deterministic conversation fixtures for message-pipeline tests.
 *
 * Every builder takes explicit uuid / message-id / timestamp values so the
 * produced objects are byte-stable across calls. That matters for
 * characterization tests that compare two independently computed results
 * (e.g. full vs. incremental message lookups) with deep equality.
 *
 * Nothing here imports production code — these are plain object literals
 * shaped like the runtime message types, so importing this module can never
 * trigger a module-level side effect in `src/`.
 *
 * Usage:
 *   import { assistantToolUse, userToolResult } from '../../../tests/mocks/fixtures/conversation'
 */
import type { UUID } from 'crypto'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  UserMessage,
} from 'src/types/message.js'

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z'

/**
 * UUID-shaped but fully deterministic: `fixtureUuid(3)` ->
 * `00000003-0000-4000-8000-000000000000`.
 *
 * The counter lives in the FIRST group on purpose. `deriveUUID` (used by
 * `normalizeMessages` once any message splits into several blocks) keeps only
 * `uuid.slice(0, 24)` and overwrites the tail, so fixtures that differ only in
 * the last group would collapse onto one another after normalization.
 */
export function fixtureUuid(n: number): UUID {
  return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as UUID
}

type AssistantOptions = {
  /** `message.id` — messages sharing an id are treated as one streamed turn. */
  messageId: string
  uuid: UUID
  timestamp?: string
}

function baseAssistant(
  { messageId, uuid, timestamp = FIXED_TIMESTAMP }: AssistantOptions,
  content: unknown[],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'fixture-model',
      type: 'message',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content,
      usage: { input_tokens: 0, output_tokens: 0 },
      context_management: null,
    },
  } as unknown as AssistantMessage
}

/** Assistant turn carrying a single text block. */
export function assistantText(
  options: AssistantOptions,
  text: string,
): AssistantMessage {
  return baseAssistant(options, [{ type: 'text', text, citations: [] }])
}

/** Assistant turn carrying a single thinking block (no visible content). */
export function assistantThinking(
  options: AssistantOptions,
  thinking: string,
  signature = 'sig-fixture',
): AssistantMessage {
  return baseAssistant(options, [{ type: 'thinking', thinking, signature }])
}

/** Assistant turn carrying one or more `tool_use` blocks. */
export function assistantToolUse(
  options: AssistantOptions,
  toolUses: Array<{
    id: string
    name: string
    input?: Record<string, unknown>
  }>,
): AssistantMessage {
  return baseAssistant(
    options,
    toolUses.map(t => ({
      type: 'tool_use',
      id: t.id,
      name: t.name,
      input: t.input ?? {},
    })),
  )
}

/**
 * Assistant turn with a server-side tool use plus its matching result block,
 * the shape `buildMessageLookups` resolves via the block's `tool_use_id`.
 */
export function assistantServerToolUseResolved(
  options: AssistantOptions,
  serverToolUseId: string,
): AssistantMessage {
  return baseAssistant(options, [
    {
      type: 'server_tool_use',
      id: serverToolUseId,
      name: 'web_search',
      input: { query: 'fixture' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: serverToolUseId,
      content: [],
    },
  ])
}

/** Assistant turn with an *unresolved* server tool use (no result block). */
export function assistantServerToolUseOrphaned(
  options: AssistantOptions,
  serverToolUseId: string,
): AssistantMessage {
  return baseAssistant(options, [
    {
      type: 'server_tool_use',
      id: serverToolUseId,
      name: 'web_search',
      input: { query: 'fixture' },
    },
  ])
}

/** Plain user turn with a single text block. */
export function userText(uuid: UUID, text: string): UserMessage {
  return {
    type: 'user',
    uuid,
    timestamp: FIXED_TIMESTAMP,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as UserMessage
}

/** User turn carrying a single `tool_result` block. */
export function userToolResult(
  uuid: UUID,
  toolUseId: string,
  content: string,
  isError = false,
): UserMessage {
  return {
    type: 'user',
    uuid,
    timestamp: FIXED_TIMESTAMP,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  } as unknown as UserMessage
}

/** Generic tool progress tick (`data.type` is *not* `hook_progress`). */
export function progressTick(
  uuid: UUID,
  parentToolUseID: string,
  data: Record<string, unknown> = { type: 'tool_progress' },
): ProgressMessage {
  return {
    type: 'progress',
    uuid,
    timestamp: FIXED_TIMESTAMP,
    toolUseID: `${parentToolUseID}_child`,
    parentToolUseID,
    data,
  } as unknown as ProgressMessage
}

/** Progress tick that the lookups count as an *in-progress* hook. */
export function hookProgressTick(
  uuid: UUID,
  parentToolUseID: string,
  hookEvent = 'PreToolUse',
): ProgressMessage {
  return progressTick(uuid, parentToolUseID, {
    type: 'hook_progress',
    hookEvent,
  })
}

/** Hook attachment message that the lookups count as a *resolved* hook. */
export function hookSuccessAttachment(
  uuid: UUID,
  toolUseID: string,
  hookName: string,
  hookEvent = 'PreToolUse',
): AttachmentMessage {
  return {
    type: 'attachment',
    uuid,
    timestamp: FIXED_TIMESTAMP,
    attachment: {
      type: 'hook_success',
      content: `${hookName} ok`,
      hookName,
      toolUseID,
      hookEvent,
    },
  } as unknown as AttachmentMessage
}

/**
 * A growing conversation: element `i` is the message appended at step `i`.
 *
 * Deliberately avoids the three shapes where the incremental lookup updater
 * is known to diverge from a full rebuild (see the characterization test):
 * every assistant message has a unique `message.id`, no `hookName` repeats
 * for a given (toolUseID, hookEvent) pair, and the only `server_tool_use`
 * block ships with its result in the same message.
 */
export function growingConversation(): Message[] {
  const toolA = 'toolu_fixture_a'
  const toolB = 'toolu_fixture_b'
  const toolC = 'toolu_fixture_c'
  return [
    userText(fixtureUuid(1), 'first request'),
    assistantText({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'on it'),
    assistantToolUse({ messageId: 'msg_2', uuid: fixtureUuid(3) }, [
      { id: toolA, name: 'Bash', input: { command: 'ls' } },
      { id: toolB, name: 'Read', input: { file_path: '/tmp/x' } },
    ]),
    hookProgressTick(fixtureUuid(4), toolA),
    hookSuccessAttachment(fixtureUuid(5), toolA, 'guard-hook'),
    progressTick(fixtureUuid(6), toolA),
    userToolResult(fixtureUuid(7), toolA, 'file-a\nfile-b'),
    userToolResult(fixtureUuid(8), toolB, 'read failed', true),
    assistantServerToolUseResolved(
      { messageId: 'msg_3', uuid: fixtureUuid(9) },
      'srvtoolu_fixture_1',
    ),
    userText(fixtureUuid(10), 'second request'),
    assistantToolUse({ messageId: 'msg_4', uuid: fixtureUuid(11) }, [
      { id: toolC, name: 'Bash', input: { command: 'pwd' } },
    ]),
    progressTick(fixtureUuid(12), toolC),
    userToolResult(fixtureUuid(13), toolC, '/repo'),
    assistantText({ messageId: 'msg_5', uuid: fixtureUuid(14) }, 'done'),
  ]
}
