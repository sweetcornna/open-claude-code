import { afterEach, describe, expect, test } from 'bun:test'
import {
  REASONING_ENCRYPTED_CONTENT_INCLUDE,
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createOpenAIResponsesStream,
  extractReasoningItem,
  extractUsage,
  resolveResponsesEndpoint,
} from '../responsesAdapter.js'
import { OPENAI_REASONING_ITEMS_FIELD } from '@ant/model-provider'
import { formatOpenAIPromptCacheKey } from '../openaiShared.js'
import { calculateCacheHitRate } from '../../../../utils/telemetry/cacheWarning.js'

describe('buildResponsesRequest', () => {
  const promptCacheKey = formatOpenAIPromptCacheKey('session-abc-123')

  test('includes max reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'max',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'max' })
  })

  test('includes reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'xhigh',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('includes text verbosity when provided', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      verbosity: 'low',
    })

    expect(request.text).toEqual({ verbosity: 'low' })
  })

  test('omits text when verbosity is not provided', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
    }) as Record<string, unknown>

    expect('text' in request).toBe(false)
  })

  test('passes server-side built-in tools through verbatim', () => {
    // WebSearch's codex source asks for the built-in web_search tool this way;
    // it carries no `function` descriptor and must not be dropped.
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'web_search' }],
      toolChoice: undefined,
    })

    expect(request.tools).toEqual([{ type: 'web_search' }])
  })

  test('still converts function tools alongside built-ins', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        { type: 'web_search' },
        {
          type: 'function',
          function: { name: 'lookup', description: 'd', parameters: {} },
        },
      ],
      toolChoice: undefined,
    })

    expect(request.tools).toEqual([
      { type: 'web_search' },
      {
        type: 'function',
        name: 'lookup',
        description: 'd',
        parameters: {},
        strict: false,
      },
    ])
  })

  test('does not include max_output_tokens unless explicitly passed (ChatGPT route)', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    }) as Record<string, unknown>

    expect('max_output_tokens' in request).toBe(false)
  })

  test('includes max_output_tokens when passed (generic route)', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      maxOutputTokens: 64000,
    })

    expect(request.max_output_tokens).toBe(64000)
  })

  test('omits prompt_cache_key when not passed (compatible providers)', () => {
    const request = buildResponsesRequest({
      model: 'qwen3-coder',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
    }) as Record<string, unknown>

    expect('prompt_cache_key' in request).toBe(false)
  })

  test('includes stable prompt_cache_key for session-sticky cache routing', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    })

    expect(request.prompt_cache_key).toBe('occ:session-abc-123')
  })

  test('prompt_cache_key is stable across turns (not derived from messages)', () => {
    const key = formatOpenAIPromptCacheKey('same-session')
    const turn1 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'first' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })
    const turn2 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })

    expect(turn1.prompt_cache_key).toBe(turn2.prompt_cache_key)
    expect(turn1.prompt_cache_key).toBe('occ:same-session')
  })
})

describe('extractUsage (OpenAI Responses → Anthropic usage)', () => {
  test('subtracts cached_tokens so hit rate uses OpenAI total as denominator', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 20_000 },
      },
    })

    expect(usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
    })

    // Was 40% under the double-count bug; correct is 66.7%.
    const hitRate = calculateCacheHitRate(usage)
    expect(hitRate).toBeCloseTo((20_000 / 30_000) * 100, 5)
  })

  test('full cache hit can report 100% (not capped at 50%)', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30_000 },
      },
    })

    expect(usage.input_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(30_000)
    expect(calculateCacheHitRate(usage)).toBe(100)
  })

  test('maps cache_write_tokens to cache_creation without double-counting total', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 10_000,
        output_tokens: 10,
        input_tokens_details: {
          cached_tokens: 6_000,
          cache_write_tokens: 2_000,
        },
      },
    })

    expect(usage).toEqual({
      input_tokens: 2_000,
      output_tokens: 10,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 6_000,
    })
    // segments sum to OpenAI total
    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(10_000)
    expect(calculateCacheHitRate(usage)).toBeCloseTo(60, 5)
  })

  test('clamps overlapping write/read that exceed total input', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 5_000,
        output_tokens: 0,
        input_tokens_details: {
          cached_tokens: 4_000,
          cache_write_tokens: 4_000,
        },
      },
    })

    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(5_000)
    expect(usage.cache_read_input_tokens).toBe(4_000)
    expect(usage.cache_creation_input_tokens).toBe(1_000)
    expect(usage.input_tokens).toBe(0)
  })
})

describe('resolveResponsesEndpoint', () => {
  test('defaults to the official OpenAI endpoint', () => {
    expect(resolveResponsesEndpoint(undefined)).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(resolveResponsesEndpoint('')).toBe(
      'https://api.openai.com/v1/responses',
    )
  })

  test('appends /responses to the configured base, stripping trailing slashes', () => {
    expect(resolveResponsesEndpoint('http://localhost:11434/v1')).toBe(
      'http://localhost:11434/v1/responses',
    )
    expect(resolveResponsesEndpoint('https://example.com/v1/')).toBe(
      'https://example.com/v1/responses',
    )
  })
})

describe('createOpenAIResponsesStream', () => {
  const savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_REQUEST_MAX_RETRIES: process.env.OPENAI_REQUEST_MAX_RETRIES,
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('rejects without OPENAI_API_KEY', async () => {
    delete process.env.OPENAI_API_KEY
    await expect(
      createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('OPENAI_API_KEY is required')
  })

  test('POSTs to <base>/responses with bearer auth and no ChatGPT headers', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    const fetchOverride = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response('data: [DONE]\n\n', { status: 200 })
    }) as unknown as typeof fetch

    await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })

    expect(capturedUrl).toBe('http://localhost:11434/v1/responses')
    expect(capturedHeaders.Authorization).toBe('Bearer sk-test-key')
    expect('ChatGPT-Account-Id' in capturedHeaders).toBe(false)
    expect('originator' in capturedHeaders).toBe(false)
    expect('OpenAI-Beta' in capturedHeaders).toBe(false)
  })

  test('parses CRLF frames and dispatches the final frame at EOF', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    const bytes = new TextEncoder().encode(
      'data: {"type":"first","text":"hé"}\r\n\r\n' +
        'data: {"type":"second","text":"尾"}',
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One-byte chunks cover CRLF and UTF-8 code points split across reads.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const fetchOverride = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch

    const stream = await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })
    const events: Record<string, unknown>[] = []
    for await (const event of stream) events.push(event)

    expect(events).toEqual([
      { type: 'first', text: 'hé' },
      { type: 'second', text: '尾' },
    ])
  })

  test('retries when the stream stalls before its first event', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_REQUEST_MAX_RETRIES = '1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      if (calls === 1) {
        return new Response(new ReadableStream<Uint8Array>())
      }
      return new Response('data: {"type":"ready"}\n\ndata: [DONE]\n\n')
    }) as unknown as typeof fetch

    const stream = await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })
    const events: Record<string, unknown>[] = []
    for await (const event of stream) events.push(event)

    expect(calls).toBe(2)
    expect(events).toEqual([{ type: 'ready' }])
  })

  test('throws without retry when the stream stalls after yielding', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_REQUEST_MAX_RETRIES = '1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
    let calls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"first"}\n\n'),
        )
      },
    })
    const fetchOverride = (async () => {
      calls++
      return new Response(body)
    }) as unknown as typeof fetch

    const stream = await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })
    const events: Record<string, unknown>[] = []
    let caught: unknown
    try {
      for await (const event of stream) events.push(event)
    } catch (error) {
      caught = error
    }

    expect(events).toEqual([{ type: 'first' }])
    expect(calls).toBe(1)
    expect((caught as Error).message).toBe(
      'Responses API stream idle timeout after 30ms',
    )
  })
})

async function collectEvents(
  events: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  async function* source() {
    for (const event of events) yield event
  }
  const out: Record<string, unknown>[] = []
  for await (const event of adaptResponsesStreamToAnthropic(
    source(),
    'gpt-5.5',
  )) {
    out.push(event as unknown as Record<string, unknown>)
  }
  return out
}

describe('adaptResponsesStreamToAnthropic event coverage', () => {
  test('reasoning_summary_text.delta maps to a thinking block', async () => {
    const out = await collectEvents([
      { type: 'response.reasoning_summary_text.delta', delta: 'because' },
      { type: 'response.output_text.delta', delta: 'answer' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    const starts = out.filter(e => e.type === 'content_block_start')
    expect((starts[0]?.content_block as Record<string, unknown>)?.type).toBe(
      'thinking',
    )
    expect((starts[1]?.content_block as Record<string, unknown>)?.type).toBe(
      'text',
    )
    const thinkingDelta = out.find(
      e =>
        e.type === 'content_block_delta' &&
        (e.delta as Record<string, unknown>)?.type === 'thinking_delta',
    )
    expect((thinkingDelta?.delta as Record<string, unknown>)?.thinking).toBe(
      'because',
    )
  })

  test('refusal.delta is surfaced as visible text', async () => {
    const out = await collectEvents([
      { type: 'response.refusal.delta', delta: 'I cannot help with that.' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    const textDelta = out.find(
      e =>
        e.type === 'content_block_delta' &&
        (e.delta as Record<string, unknown>)?.type === 'text_delta',
    )
    expect((textDelta?.delta as Record<string, unknown>)?.text).toBe(
      'I cannot help with that.',
    )
  })
})

// ── reasoning replay: the Codex/`store:false` fidelity contract ────────────
//
// Reasoning models served over /responses with `store: false` keep no
// server-side state, so turn N's reasoning is gone unless turn N+1 replays
// it. Measured cache-neutral against a live endpoint (see
// OPENAI_REASONING_ITEMS_FIELD); what it buys is the model keeping its chain
// of thought across tool-call turns instead of re-deriving it each time.

describe('Responses reasoning replay', () => {
  const cacheKey = formatOpenAIPromptCacheKey('codex-session')

  function requestWithMessages(messages: unknown[]) {
    return buildResponsesRequest({
      model: 'gpt-5.5-codex',
      messages,
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'medium',
      promptCacheKey: cacheKey,
    })
  }

  test('asks for encrypted reasoning content whenever reasoning is requested', () => {
    // Without this include the server returns reasoning items with no
    // payload, so there is nothing to replay at all.
    const request = requestWithMessages([{ role: 'user', content: 'hi' }])
    expect(request.include).toEqual([REASONING_ENCRYPTED_CONTENT_INCLUDE])
  })

  test('omits include when no reasoning is requested', () => {
    const request = buildResponsesRequest({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: cacheKey,
    })
    expect('include' in request).toBe(false)
  })

  test('replays reasoning items ahead of the turn they belong to', () => {
    const request = requestWithMessages([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'working on it',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '{}' },
          },
        ],
        [OPENAI_REASONING_ITEMS_FIELD]: [
          { id: 'rs_1', encrypted_content: 'ENC', summary: [] },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ])

    expect(request.input.map(item => item.type ?? item.role)).toEqual([
      'user',
      'reasoning',
      'message',
      'function_call',
      'function_call_output',
    ])
    expect(request.input[1]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'ENC',
      summary: [],
    })
  })

  test('replays reasoning for a turn that produced only tool calls', () => {
    // A tool-only turn is exactly where the reasoning matters most: it is the
    // only record of why the model made that call.
    const request = requestWithMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '{}' },
          },
        ],
        [OPENAI_REASONING_ITEMS_FIELD]: [{ id: 'rs_1', summary: [] }],
      },
    ])

    expect(request.input.map(item => item.type ?? item.role)).toEqual([
      'user',
      'reasoning',
      'function_call',
    ])
  })

  test('assistant text replays as an output_text message item', () => {
    // The bare {role, content} form normalizes to input_text — it would tell
    // the model its own previous answer was user input.
    const request = requestWithMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])

    expect(request.input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'a' }],
    })
  })

  test('messages without reasoning items are unchanged', () => {
    const request = requestWithMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    expect(request.input.some(item => item.type === 'reasoning')).toBe(false)
  })

  test('a turn carrying several reasoning items replays them in order', () => {
    const request = requestWithMessages([
      {
        role: 'assistant',
        content: 'x',
        [OPENAI_REASONING_ITEMS_FIELD]: [
          { id: 'rs_1', summary: [] },
          { id: 'rs_2', summary: [] },
        ],
      },
    ])
    expect(
      request.input
        .filter(item => item.type === 'reasoning')
        .map(item => item.id),
    ).toEqual(['rs_1', 'rs_2'])
  })
})

describe('extractReasoningItem', () => {
  test('keeps the id, encrypted content and summary verbatim', () => {
    expect(
      extractReasoningItem({
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'ENC',
        summary: [{ type: 'summary_text', text: 'why' }],
      }),
    ).toEqual({
      id: 'rs_1',
      encrypted_content: 'ENC',
      summary: [{ type: 'summary_text', text: 'why' }],
    })
  })

  test('ignores non-reasoning items', () => {
    expect(extractReasoningItem({ type: 'function_call', id: 'x' })).toBeNull()
    expect(extractReasoningItem(undefined)).toBeNull()
  })

  test('drops a hollow item carrying no recoverable reasoning', () => {
    // Neither an id nor encrypted content: echoing it back adds a token the
    // model cannot use.
    expect(extractReasoningItem({ type: 'reasoning', summary: [] })).toBeNull()
  })

  test('defaults a missing summary to an empty array', () => {
    expect(extractReasoningItem({ type: 'reasoning', id: 'rs_1' })).toEqual({
      id: 'rs_1',
      summary: [],
    })
  })
})

describe('adaptResponsesStreamToAnthropic reasoning capture', () => {
  async function collectReasoning(events: Record<string, unknown>[]) {
    const captured: unknown[] = []
    const stream = (async function* () {
      for (const event of events) yield event
    })()
    for await (const _ of adaptResponsesStreamToAnthropic(stream, 'gpt-5.5', {
      onReasoningItem: item => captured.push(item),
    })) {
      // drain
    }
    return captured
  }

  test('captures reasoning items from output_item.done', async () => {
    const captured = await collectReasoning([
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
      },
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(captured).toEqual([
      { id: 'rs_1', encrypted_content: 'ENC', summary: [] },
    ])
  })

  test('captures multiple reasoning items in output order', async () => {
    const captured = await collectReasoning([
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: { type: 'reasoning', id: 'rs_2' },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(captured.map(item => (item as { id: string }).id)).toEqual([
      'rs_1',
      'rs_2',
    ])
  })

  test('still closes tool blocks when the same event carries no reasoning', async () => {
    // output_item.done does double duty; the reasoning hook must not swallow it.
    const events: Record<string, unknown>[] = []
    const stream = (async function* () {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'Bash' },
      }
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1' },
      }
      yield { type: 'response.completed', response: { status: 'completed' } }
    })()
    for await (const event of adaptResponsesStreamToAnthropic(
      stream,
      'gpt-5.5',
    )) {
      events.push(event as unknown as Record<string, unknown>)
    }
    expect(events.some(e => e.type === 'content_block_stop')).toBe(true)
  })
})
