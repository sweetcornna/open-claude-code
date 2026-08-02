import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../tests/mocks/log'
import { debugMock } from '../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import type { Message } from '../types/message.js'
import { fixtureUuid } from '../../tests/mocks/fixtures/conversation.js'
import type { QueryDeps } from '../query/deps.js'
import type { CompactionResult } from '../services/compact/compact.js'

/**
 * Drives the real `queryLoop` through the predictive-autocompact branch
 * (query.ts, "Predictive autocompact") with every I/O dependency faked, and
 * pins down what that branch does with the compaction it just paid for.
 *
 * The window is shrunk via CLAUDE_CODE_AUTO_COMPACT_WINDOW so the thresholds
 * are reachable with a small fixture:
 *
 *   effectiveWindow      = 100_000 - 20_000 = 80_000
 *   predictiveThreshold  = 80_000 - (20_000 + 15_000) = 45_000
 *   autoCompactThreshold = 80_000 - 13_000 = 67_000
 *   blockingLimit        = 80_000 - 3_000  = 77_000
 *
 * A history reporting 50_000 input tokens therefore sits above the predictive
 * threshold but below both the proactive threshold and the blocking limit —
 * exactly the window where only the predictive branch fires.
 */

const ANCHOR_TOKENS = 50_000

const savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const key of [
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
  ]) {
    savedEnv[key] = process.env[key]
  }
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type Uuid = ReturnType<typeof fixtureUuid>

const U1 = fixtureUuid(1)
const A1 = fixtureUuid(2)
const REPLY = fixtureUuid(3)
const BOUNDARY_UUID = fixtureUuid(4)
const SUMMARY_UUID = fixtureUuid(5)

function userMessage(uuid: Uuid, text: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  } as unknown as Message
}

/** An assistant record carrying API-reported usage, the estimation anchor. */
function assistantWithUsage(uuid: Uuid, inputTokens: number): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: `req_${uuid}`,
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  } as unknown as Message
}

/** A terminal assistant reply: no tool_use, so the loop finishes the turn. */
function assistantReply(uuid: Uuid, text: string): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: `req_${uuid}`,
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  } as unknown as Message
}

function compactionResult(): CompactionResult {
  return {
    boundaryMarker: {
      type: 'system',
      uuid: BOUNDARY_UUID,
      timestamp: '2026-01-01T00:00:00.000Z',
      subtype: 'compact_boundary',
      content: '',
      isMeta: true,
      compactMetadata: { trigger: 'auto', preTokens: ANCHOR_TOKENS },
    } as unknown as CompactionResult['boundaryMarker'],
    summaryMessages: [
      userMessage(SUMMARY_UUID, 'summary of the conversation so far'),
    ] as unknown as CompactionResult['summaryMessages'],
    attachments: [],
    hookResults: [],
    messagesToKeep: [],
    preCompactTokenCount: ANCHOR_TOKENS,
    postCompactTokenCount: 500,
  }
}

function makeToolUseContext() {
  return {
    agentId: undefined,
    abortController: new AbortController(),
    readFileState: {},
    contentReplacementState: undefined,
    queryTracking: undefined,
    langfuseTrace: undefined,
    messages: [],
    setMessages: () => {},
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Set(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      },
      mcp: { clients: [], tools: [], commands: [], resources: {} },
    }),
    setAppState: () => {},
    options: {
      tools: [],
      mainLoopModel: 'claude-sonnet-4-5',
      maxThinkingTokens: 0,
      isNonInteractiveSession: true,
      debug: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
  } as never
}

type AutocompactCall = {
  index: number
  messageCount: number
  tracking: { consecutiveFailures?: number; compacted?: boolean } | undefined
}

/**
 * Runs one `query()` turn where the proactive autocompact declines and the
 * predictive one compacts. Returns everything an assertion might want:
 * the yielded stream, the calls the loop made, and the messages handed to
 * the API.
 */
async function runTurn(opts: {
  predictiveCompacts: boolean
  /** Failure count the proactive pass reports back, if any. */
  proactiveFailures?: number
}) {
  const { query } = await import('../query.js')

  const calls: AutocompactCall[] = []
  const sentToApi: Message[][] = []
  let uuidCounter = 0

  const deps: QueryDeps = {
    callModel: ((params: { messages?: unknown[] }) => {
      sentToApi.push([...((params.messages ?? []) as Message[])])
      return (async function* () {
        yield assistantReply(REPLY, 'done')
      })()
    }) as unknown as QueryDeps['callModel'],
    microcompact: (async (messages: Message[]) => ({
      messages,
      compactionInfo: undefined,
      clearedToolUseIds: [],
    })) as unknown as QueryDeps['microcompact'],
    autocompact: (async (
      messages: Message[],
      _ctx: unknown,
      _params: unknown,
      _source: unknown,
      tracking: AutocompactCall['tracking'],
    ) => {
      const index = calls.length
      calls.push({ index, messageCount: messages.length, tracking })
      // index 0 = the proactive pass, index 1 = the predictive pass.
      if (index === 1 && opts.predictiveCompacts) {
        return { wasCompacted: true, compactionResult: compactionResult() }
      }
      if (index === 0 && opts.proactiveFailures !== undefined) {
        return {
          wasCompacted: false,
          consecutiveFailures: opts.proactiveFailures,
        }
      }
      return { wasCompacted: false }
    }) as unknown as QueryDeps['autocompact'],
    uuid: () => `uuid-${++uuidCounter}`,
  }

  const messages: Message[] = [
    userMessage(U1, 'hello'),
    assistantWithUsage(A1, ANCHOR_TOKENS),
  ]

  const yielded: Message[] = []
  const generator = query({
    messages,
    systemPrompt: ['you are a test'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({
      behavior: 'allow',
      updatedInput: {},
    })) as never,
    toolUseContext: makeToolUseContext(),
    querySource: 'repl_main_thread' as never,
    deps,
  })

  let result = await generator.next()
  while (!result.done) {
    yielded.push(result.value as Message)
    result = await generator.next()
  }

  return { yielded, calls, sentToApi, terminal: result.value, messages }
}

describe('queryLoop predictive autocompact', () => {
  test('reaches the predictive pass when only that threshold is crossed', async () => {
    const { calls } = await runTurn({ predictiveCompacts: false })
    // Two autocompact calls: the proactive pass then the predictive one.
    expect(calls).toHaveLength(2)
  })

  test('uses the compacted history for the API request', async () => {
    const { sentToApi } = await runTurn({ predictiveCompacts: true })
    expect(sentToApi).toHaveLength(1)
    const sent = sentToApi[0]!
    expect(sent.some(m => m.uuid === BOUNDARY_UUID)).toBe(true)
    expect(sent.some(m => m.uuid === SUMMARY_UUID)).toBe(true)
    // The pre-compact history must be gone from the request.
    expect(sent.some(m => m.uuid === A1)).toBe(false)
  })

  test('yields the post-compact messages so the caller can persist them', async () => {
    const { yielded } = await runTurn({ predictiveCompacts: true })
    // QueryEngine builds mutableMessages purely by pushing yielded messages,
    // and mutableMessages is what seeds the next query() call and the
    // transcript. A compaction the loop never yields is discarded the moment
    // the turn ends, so the next user turn starts from the full history again
    // and the memory the compaction was supposed to release is never
    // released.
    expect(yielded.some(m => m.uuid === BOUNDARY_UUID)).toBe(true)
    expect(yielded.some(m => m.uuid === SUMMARY_UUID)).toBe(true)
  })

  test('carries a failed compaction count into the predictive pass', async () => {
    // Without this the circuit breaker in autoCompactIfNeeded never sees the
    // failures and a session that cannot be compacted retries every turn.
    const { calls } = await runTurn({
      predictiveCompacts: false,
      proactiveFailures: 2,
    })
    expect(calls[0]!.tracking).toBeUndefined()
    expect(calls[1]!.tracking?.consecutiveFailures).toBe(2)
  })

  test('does not yield compaction messages when nothing compacted', async () => {
    const { yielded } = await runTurn({ predictiveCompacts: false })
    expect(yielded.some(m => m.uuid === BOUNDARY_UUID)).toBe(false)
    expect(yielded.some(m => m.uuid === SUMMARY_UUID)).toBe(false)
  })
})
