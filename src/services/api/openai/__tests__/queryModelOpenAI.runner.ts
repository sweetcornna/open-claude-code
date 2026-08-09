/**
 * Tests for queryModelOpenAI in index.ts.
 *
 * Focused on stream assembly invariants: final stop reasons and usage must be
 * retained, message_stop must produce exactly one AssistantMessage, and EOF
 * before message_stop must surface as an API error instead of accepting partial
 * output as a completed turn.
 *
 * Strategy: mock getOpenAIClient + adaptOpenAIStreamToAnthropic so we can
 * feed pre-built Anthropic events directly into queryModelOpenAI and inspect
 * what it emits — without any real HTTP calls.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as realModelProvider from '@ant/model-provider'
import type { SystemPrompt } from '@ant/model-provider'
import * as realMessages from '../../../../utils/messages.js'
import { makeSharedModuleMock } from '../../../../../tests/mocks/sharedModuleMock'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../types/message.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal message_start event */
function makeMessageStart(
  overrides: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  } as any
}

/** Build a content_block_start event for the given block type */
function makeContentBlockStart(
  index: number,
  type: 'text' | 'tool_use' | 'thinking',
  extra: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  const block =
    type === 'text'
      ? { type: 'text', text: '' }
      : type === 'tool_use'
        ? { type: 'tool_use', id: 'toolu_test', name: 'bash', input: {} }
        : { type: 'thinking', thinking: '', signature: '' }
  return {
    type: 'content_block_start',
    index,
    content_block: { ...block, ...extra },
  } as any
}

/** Build a text_delta content_block_delta event */
function makeTextDelta(index: number, text: string): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } as any
}

/** Build an input_json_delta content_block_delta event */
function makeInputJsonDelta(
  index: number,
  json: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: json },
  } as any
}

/** Build a thinking_delta content_block_delta event */
function makeThinkingDelta(
  index: number,
  thinking: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  } as any
}

/** Build a content_block_stop event */
function makeContentBlockStop(index: number): BetaRawMessageStreamEvent {
  return { type: 'content_block_stop', index } as any
}

/** Build a message_delta event with stop_reason and output_tokens */
function makeMessageDelta(
  stopReason: string,
  outputTokens: number,
): BetaRawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } as any
}

/** Build a message_stop event */
function makeMessageStop(): BetaRawMessageStreamEvent {
  return { type: 'message_stop' } as any
}

/** Async generator from a fixed array of events */
async function* eventStream(events: BetaRawMessageStreamEvent[]) {
  for (const e of events) yield e
}

/** Collect all outputs from queryModelOpenAI into typed buckets */
async function runQueryModel(
  events: BetaRawMessageStreamEvent[],
  envOverrides: Record<string, string | undefined> = {},
  tools: any[] = [],
) {
  // Wire events into the mocked stream adapter
  _nextEvents = events
  // Save + apply env overrides
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  try {
    // We inline mock.module inside the try block.
    // Bun resolves mock.module at the call site synchronously (hoisted),
    // so we register once per test file, then re-import each time.
    const { queryModelOpenAI } = await import('../index.js')

    const assistantMessages: AssistantMessage[] = []
    const streamEvents: StreamEvent[] = []
    const otherOutputs: any[] = []

    const minimalOptions: any = {
      model: 'test-model',
      tools,
      agents: [],
      querySource: 'main_loop',
      getToolPermissionContext: async () => ({
        alwaysAllow: [],
        alwaysDeny: [],
        needsPermission: [],
        mode: 'default',
        isBypassingPermissions: false,
      }),
    }

    for await (const item of queryModelOpenAI(
      [],
      { type: 'text', text: '' } as any,
      tools as any,
      new AbortController().signal,
      minimalOptions,
    )) {
      if (item.type === 'assistant') {
        assistantMessages.push(item as AssistantMessage)
      } else if (item.type === 'stream_event') {
        streamEvents.push(item as StreamEvent)
      } else {
        otherOutputs.push(item)
      }
    }

    return { assistantMessages, streamEvents, otherOutputs }
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ─── mock setup ──────────────────────────────────────────────────────────────

// We mock at module level. Bun's mock.module replaces the module for the
// entire file, so we configure the stream per-test via a shared variable.
let _nextEvents: BetaRawMessageStreamEvent[] = []

/** Captured arguments from the last chat.completions.create() call */
let _lastCreateArgs: Record<string, any> | null = null

// Complete-surface mock: every export delegates to the real module unless
// overridden below. A hand-written partial surface is what kept this file from
// ever loading — each missing export (asSystemPrompt, readReasoningItems, …)
// failed the whole module graph. See CLAUDE.md "跨文件 mock 污染".
const sharedMock = makeSharedModuleMock<typeof realModelProvider>(
  '@ant/model-provider',
  realModelProvider,
).setup({
  // Re-exported through src/utils/session/systemPromptType.ts, which
  // openai/index.ts imports. Omitting it made the whole module graph fail to
  // load — the reason this file's assertions had never actually run.
  asSystemPrompt: (value: readonly string[]) =>
    value as unknown as SystemPrompt,
  resolveOpenAIModel: (m: string) => m,
  adaptOpenAIStreamToAnthropic: (_stream: any, _model: string) =>
    eventStream(_nextEvents),
  anthropicMessagesToOpenAI: (messages: any[]) =>
    messages.map(msg => ({
      role: msg.message?.role ?? 'user',
      content: msg.message?.content ?? '',
    })),
  anthropicToolsToOpenAI: (tools: any[]) =>
    tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    })),
  anthropicToolChoiceToOpenAI: () => undefined,
  normalizeOpenAIUsage: (params: {
    totalInputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }) => {
    const cacheRead = Math.min(
      Math.max(0, params.cacheReadTokens ?? 0),
      Math.max(0, params.totalInputTokens),
    )
    const remaining = Math.max(0, params.totalInputTokens - cacheRead)
    const cacheCreation = Math.min(
      Math.max(0, params.cacheWriteTokens ?? 0),
      remaining,
    )
    return {
      input_tokens: Math.max(0, remaining - cacheCreation),
      output_tokens: Math.max(0, params.outputTokens),
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    }
  },
})

mock.module('../../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
    fallback,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_CACHED_WITH_REFRESH: (_key: string, fallback: unknown) =>
    fallback,
}))

// Force Chat Completions path so stream/client mocks apply (not Responses).
// Avoid partial mocks of bootstrap/state and envUtils — incomplete surfaces
// break transitive named imports when this file is run alone.
mock.module('../chatgptAuth.js', () => ({
  isChatGPTAuthEnabled: () => false,
  getValidChatGPTAuth: async () => null,
}))

mock.module('bun:bundle', () => ({
  feature: () => false,
}))

mock.module('../client.js', () => ({
  getOpenAIClient: () => ({
    chat: {
      completions: {
        create: async (args: Record<string, any>) => {
          _lastCreateArgs = args
          return { [Symbol.asyncIterator]: async function* () {} }
        },
      },
    },
  }),
}))

mock.module('../streamAdapter.js', () => ({
  adaptOpenAIStreamToAnthropic: (_stream: any, _model: string) =>
    eventStream(_nextEvents),
}))

mock.module('../modelMapping.js', () => ({
  resolveOpenAIModel: (m: string) => m,
}))

mock.module('../convertMessages.js', () => ({
  anthropicMessagesToOpenAI: () => [],
}))

mock.module('../convertTools.js', () => ({
  anthropicToolsToOpenAI: () => [],
  anthropicToolChoiceToOpenAI: () => undefined,
}))

mock.module('../../../../utils/session/context.js', () => ({
  MODEL_CONTEXT_WINDOW_DEFAULT: 200_000,
  COMPACT_MAX_OUTPUT_TOKENS: 20_000,
  CAPPED_DEFAULT_MAX_TOKENS: 8_000,
  ESCALATED_MAX_TOKENS: 64_000,
  is1mContextDisabled: () => false,
  has1mContext: () => false,
  modelSupports1M: () => false,
  getModelMaxOutputTokens: () => ({ upperLimit: 8192, default: 8192 }),
  getContextWindowForModel: () => 200_000,
  getSonnet1mExpTreatmentEnabled: () => false,
  calculateContextPercentages: () => ({
    usedPercent: 0,
    remainingPercent: 100,
  }),
  getMaxThinkingTokensForModel: () => 0,
}))

const messagesMock = makeSharedModuleMock(
  '../../../../utils/messages.js',
  realMessages,
).setup({
  normalizeMessagesForAPI: (msgs: any) => msgs,
  normalizeContentFromAPI: (blocks: any[]) => blocks,
  createUserMessage: (opts: any) => ({
    type: 'user',
    message: { role: 'user', content: opts.content },
    uuid: '00000000-0000-0000-0000-000000000001',
    timestamp: new Date().toISOString(),
    isMeta: opts.isMeta,
  }),
  createAssistantAPIErrorMessage: (opts: any) => ({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: opts.content }],
      apiError: opts.apiError,
    },
    uuid: '00000000-0000-0000-0000-000000000002',
    timestamp: new Date().toISOString(),
  }),
})

mock.module('../../../../utils/telemetry/api.js', () => ({
  toolToAPISchema: async (t: any) => t,
}))

mock.module('../../../../cost-tracker.js', () => ({
  addToTotalSessionCost: () => {},
}))

mock.module('../../../../utils/model/modelCost.js', () => ({
  COST_TIER_3_15: {},
  COST_TIER_15_75: {},
  COST_TIER_5_25: {},
  COST_TIER_30_150: {},
  COST_HAIKU_35: {},
  COST_HAIKU_45: {},
  getOpus46CostTier: () => ({}),
  MODEL_COSTS: {},
  getModelCosts: () => ({}),
  calculateUSDCost: () => 0,
  calculateCostFromTokens: () => 0,
  formatModelPricing: () => '',
  getModelPricingString: () => undefined,
}))

mock.module('src/services/langfuse/tracing.ts', () => ({
  createTrace: () => null,
  recordLLMObservation: () => {},
  recordToolObservation: () => {},
  createToolBatchSpan: () => null,
  endToolBatchSpan: () => {},
  createSubagentTrace: () => null,
  createChildSpan: () => null,
  endTrace: () => {},
}))

mock.module('../../../../services/langfuse/convert.js', () => ({
  convertMessagesToLangfuse: () => [],
  convertOutputToLangfuse: () => ({}),
  convertToolsToLangfuse: () => [],
}))

mock.module('../../../../utils/telemetry/debug.js', () => ({
  logForDebugging: () => {},
  logAntError: () => {},
  isDebugMode: () => false,
  isDebugToStdErr: () => false,
  getDebugFilePath: () => null,
  getDebugLogPath: () => '',
  getDebugFilter: () => null,
  getMinDebugLogLevel: () => 'debug',
  enableDebugLogging: () => false,
  setHasFormattedOutput: () => {},
  getHasFormattedOutput: () => false,
  flushDebugLogs: async () => {},
}))

// ─── tests ───────────────────────────────────────────────────────────────────

describe('queryModelOpenAI — stop_reason propagation', () => {
  test('assembled AssistantMessage has stop_reason end_turn (not null)', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'Hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 10),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('end_turn')
  })

  test('assembled AssistantMessage has stop_reason tool_use', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'tool_use'),
      makeInputJsonDelta(0, '{"cmd":"ls"}'),
      makeContentBlockStop(0),
      makeMessageDelta('tool_use', 20),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('tool_use')
  })

  test('assembled AssistantMessage has stop_reason max_tokens', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'truncated'),
      makeContentBlockStop(0),
      makeMessageDelta('max_tokens', 8192),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // Two assistant-typed items: the content message + the max_output_tokens error signal.
    // The error signal is emitted as a synthetic assistant message by createAssistantAPIErrorMessage.
    expect(assistantMessages).toHaveLength(2)
    const contentMsg = assistantMessages[0]!
    expect(contentMsg.message.stop_reason).toBe('max_tokens')
    // Second item is the error signal (has apiError set)
    const errorMsg = assistantMessages[1] as any
    expect(errorMsg.apiError).toBe('max_output_tokens')
  })

  test('reports a premature close when message_stop is missing', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'partial'),
      makeContentBlockStop(0),
    ]

    const { assistantMessages, streamEvents } = await runQueryModel(_nextEvents)

    expect(
      streamEvents.some(
        item =>
          (item.event as { type?: string }).type === 'content_block_delta',
      ),
    ).toBe(true)
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toMatchObject({
      isApiErrorMessage: true,
      error: 'server_error',
    })
  })
})

describe('queryModelOpenAI — usage accumulation', () => {
  test('usage in assembled message reflects all four fields from message_delta', async () => {
    // message_start has all fields=0 (trailing-chunk pattern: usage not yet available).
    // message_delta carries the real values after stream ends.
    // The spread in the message_delta handler must override all zeros from message_start,
    // including cache_read_input_tokens which was previously missing from message_delta.
    _nextEvents = [
      makeMessageStart({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'response'),
      makeContentBlockStop(0),
      // message_delta carries all four Anthropic usage fields (as emitted by the fixed streamAdapter)
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 30011,
          output_tokens: 190,
          cache_read_input_tokens: 19904,
          cache_creation_input_tokens: 0,
        },
      } as any,
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    const usage = assistantMessages[0]!.message.usage as any
    expect(usage.input_tokens).toBe(30011)
    expect(usage.output_tokens).toBe(190)
    // cache_read_input_tokens from message_delta overrides the 0 from message_start
    expect(usage.cache_read_input_tokens).toBe(19904)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('usage is zero when no usage events arrive (prevents false autocompact)', async () => {
    // If usage stays 0, tokenCountWithEstimation will undercount — so at least
    // verify the field exists and is numeric (to detect regressions).
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 0),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    const usage = assistantMessages[0]!.message.usage as any
    expect(typeof usage.input_tokens).toBe('number')
    expect(typeof usage.output_tokens).toBe('number')
  })
})

describe('queryModelOpenAI — no duplicate AssistantMessage (partialMessage reset)', () => {
  test('yields exactly one AssistantMessage per message_stop when content is present', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'only once'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // Before the fix, partialMessage was not reset to null, so the safety
    // fallback at the end of the loop would yield a second message with the
    // same message.id — causing mergeAssistantMessages to concatenate content.
    expect(assistantMessages).toHaveLength(1)
  })

  test('thinking + text response yields exactly one AssistantMessage', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'thinking'),
      makeThinkingDelta(0, 'let me think'),
      makeContentBlockStop(0),
      makeContentBlockStart(1, 'text'),
      makeTextDelta(1, 'answer'),
      makeContentBlockStop(1),
      makeMessageDelta('end_turn', 30),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })

  test('does not assemble a partial message after abrupt EOF', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'abrupt end'),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toMatchObject({
      isApiErrorMessage: true,
      error: 'server_error',
    })
  })
})

describe('queryModelOpenAI — stream_events forwarded', () => {
  test('every adapted event is also yielded as stream_event for real-time display', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { streamEvents } = await runQueryModel(_nextEvents)

    const eventTypes = streamEvents.map(e => (e as any).event?.type)
    expect(eventTypes).toContain('message_start')
    expect(eventTypes).toContain('content_block_start')
    expect(eventTypes).toContain('content_block_delta')
    expect(eventTypes).toContain('content_block_stop')
    expect(eventTypes).toContain('message_delta')
    expect(eventTypes).toContain('message_stop')
  })
})

describe('queryModelOpenAI — max_tokens forwarded to request', () => {
  test('official OpenAI requests include max_tokens and a session cache key', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    await runQueryModel(_nextEvents)

    expect(_lastCreateArgs).not.toBeNull()
    expect(_lastCreateArgs!.max_tokens).toBe(8192)
    expect(_lastCreateArgs!.prompt_cache_key).toStartWith('occ:')
  })

  test('compatible providers also receive the cache key by default', async () => {
    // Deliberate: shouldSendOpenAIPromptCacheKey sends it everywhere now.
    // Restricting it to OpenAI's own endpoint left users behind a chat gateway
    // (LiteLLM, one-api, OpenRouter) at a measured 18.3% cache hit rate versus
    // 75.8% with the key — the largest single lever on this path, and it was
    // opt-in behind an env var for exactly the population that needed it.
    // Endpoints that reject the field say so once and are never asked again.
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    await runQueryModel(_nextEvents, {
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    })

    expect(_lastCreateArgs).not.toBeNull()
    expect(_lastCreateArgs!.prompt_cache_key).toStartWith('occ:')
  })

  test('OPENAI_PROMPT_CACHE_KEY=0 forces the cache key off', async () => {
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    await runQueryModel(_nextEvents, {
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_PROMPT_CACHE_KEY: '0',
    })

    expect(_lastCreateArgs).not.toBeNull()
    expect('prompt_cache_key' in _lastCreateArgs!).toBe(false)
  })
})

function makeApiTool(name: string, isMcp = false) {
  return {
    name,
    isMcp,
    input_schema: { type: 'object', properties: {} },
    prompt: async () => `${name} prompt`,
  }
}

function capturedToolNames(): string[] {
  const capturedTools = (_lastCreateArgs?.tools ?? []) as {
    function?: { name?: string }
  }[]
  return capturedTools.flatMap(tool =>
    tool.function?.name ? [tool.function.name] : [],
  )
}

describe('queryModelOpenAI — deferred MCP tool visibility', () => {
  const searchTool = makeApiTool('SearchExtraTools')
  const executeTool = makeApiTool('ExecuteExtraTool')
  const firstMcpTool = makeApiTool('mcp__wechat__send_message', true)

  test('defers MCP schemas when both gateway endpoints are available', async () => {
    await runQueryModel([makeMessageStart(), makeMessageStop()], {}, [
      searchTool,
      executeTool,
      firstMcpTool,
    ])

    expect(capturedToolNames()).toEqual([
      'SearchExtraTools',
      'ExecuteExtraTool',
    ])
    expect(JSON.stringify(_lastCreateArgs!.messages)).toContain(
      '<available-deferred-tools>\\nmcp__wechat__send_message\\n</available-deferred-tools>',
    )
  })

  test('drops SearchExtraTools and sends MCP schemas when ExecuteExtraTool is missing', async () => {
    await runQueryModel([makeMessageStart(), makeMessageStop()], {}, [
      searchTool,
      firstMcpTool,
    ])

    expect(capturedToolNames()).toEqual(['mcp__wechat__send_message'])
    expect(JSON.stringify(_lastCreateArgs!.messages)).not.toContain(
      '<available-deferred-tools>',
    )
  })

  test('sends MCP schemas directly when SearchExtraTools is missing', async () => {
    await runQueryModel([makeMessageStart(), makeMessageStop()], {}, [
      executeTool,
      firstMcpTool,
    ])

    expect(capturedToolNames()).toEqual([
      'ExecuteExtraTool',
      'mcp__wechat__send_message',
    ])
    expect(JSON.stringify(_lastCreateArgs!.messages)).not.toContain(
      '<available-deferred-tools>',
    )
  })

  test('re-evaluates the gateway and sends refreshed MCP schemas on the next request', async () => {
    await runQueryModel([makeMessageStart(), makeMessageStop()], {}, [
      searchTool,
      executeTool,
      firstMcpTool,
    ])
    expect(capturedToolNames()).toEqual([
      'SearchExtraTools',
      'ExecuteExtraTool',
    ])

    const refreshedMcpTool = makeApiTool('mcp__github__create_issue', true)
    await runQueryModel([makeMessageStart(), makeMessageStop()], {}, [
      searchTool,
      firstMcpTool,
      refreshedMcpTool,
    ])

    expect(capturedToolNames()).toEqual([
      'mcp__wechat__send_message',
      'mcp__github__create_issue',
    ])
  })
})

// Overrides are installed at load (the module under test is imported below and
// needs them active), so scope them by resetting at the end instead of moving
// them into beforeAll. Without this they stay installed for every later file
// in the shard — mock.module is process-global.
afterAll(() => {
  messagesMock.reset()
  sharedMock.reset()
})
