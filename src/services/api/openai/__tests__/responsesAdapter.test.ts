import { afterEach, describe, expect, test } from 'bun:test'
import {
  REASONING_ENCRYPTED_CONTENT_INCLUDE,
  _resetReasoningSummarySupportForTesting,
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createOpenAIResponsesStream,
  extractReasoningItem,
  extractUsage,
  resolveResponsesEndpoint,
} from '../responsesAdapter.js'
import { OPENAI_REASONING_ITEMS_FIELD } from '@ant/model-provider'
import {
  _resetPromptCacheKeySupportForTesting,
  formatOpenAIPromptCacheKey,
  getOpenAIPromptCacheKey,
} from '../openaiShared.js'
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

    expect(request.reasoning).toEqual({ effort: 'max', summary: 'auto' })
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

    expect(request.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
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

describe('reasoning summaries (thinking visibility)', () => {
  const saved = process.env.OPENAI_REASONING_SUMMARY

  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_REASONING_SUMMARY
    else process.env.OPENAI_REASONING_SUMMARY = saved
    _resetReasoningSummarySupportForTesting()
  })

  test('opts in by default — without it the stream carries no reasoning text', () => {
    delete process.env.OPENAI_REASONING_SUMMARY
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'high',
    })
    expect(request.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  test('honours an explicit detail level', () => {
    process.env.OPENAI_REASONING_SUMMARY = 'detailed'
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'high',
    })
    expect(request.reasoning).toEqual({ effort: 'high', summary: 'detailed' })
  })

  test('OPENAI_REASONING_SUMMARY=off suppresses the field', () => {
    process.env.OPENAI_REASONING_SUMMARY = 'off'
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'high',
    })
    expect(request.reasoning).toEqual({ effort: 'high' })
  })

  test('never asks for a summary when no reasoning effort is set', () => {
    delete process.env.OPENAI_REASONING_SUMMARY
    const request = buildResponsesRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: undefined,
    })
    expect(request.reasoning).toBeUndefined()
  })

  test('an endpoint that rejects summary degrades instead of failing the turn', async () => {
    delete process.env.OPENAI_REASONING_SUMMARY
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const bodies: string[] = []
    const fetchOverride = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      // Keyed on the body, not the call count: a strict endpoint rejects the
      // field every time it is sent. No retry ladder can talk it round — only
      // dropping the field can, which is what this path exists to do.
      if (JSON.parse(body).reasoning?.summary) {
        return new Response(
          JSON.stringify({
            error: { message: "Unknown parameter: 'reasoning.summary'." },
          }),
          { status: 400 },
        )
      }
      return new Response('data: [DONE]\n\n', { status: 200 })
    }) as unknown as typeof fetch

    await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
        reasoningEffort: 'high',
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })

    // The rejected probe and the downgraded request share one retry budget.
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0]!).reasoning).toEqual({
      effort: 'high',
      summary: 'auto',
    })
    // Retried without the field, and the rest of the body is untouched.
    expect(JSON.parse(bodies[1]!).reasoning).toEqual({ effort: 'high' })
    expect(JSON.parse(bodies[1]!).model).toBe('gpt-5.6-sol')

    // Latched: later requests in the session stop paying the failed probe.
    const next = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi again' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'high',
    })
    expect(next.reasoning).toEqual({ effort: 'high' })
  })

  test('summary degradation keeps one network retry budget', async () => {
    delete process.env.OPENAI_REASONING_SUMMARY
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

    const bodies: string[] = []
    const fetchOverride = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      return new Response(
        JSON.stringify({
          error: {
            message: JSON.parse(body).reasoning?.summary
              ? "Unknown parameter: 'reasoning.summary'."
              : 'backend unavailable',
          },
        }),
        { status: JSON.parse(body).reasoning?.summary ? 400 : 503 },
      )
    }) as unknown as typeof fetch

    await expect(
      createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
          reasoningEffort: 'high',
        }),
        signal: new AbortController().signal,
        fetchOverride,
      }),
    ).rejects.toThrow(/backend unavailable/)

    expect(bodies).toHaveLength(4)
    expect(JSON.parse(bodies[0]!).reasoning.summary).toBe('auto')
    for (const body of bodies.slice(1)) {
      expect(JSON.parse(body).reasoning).toEqual({ effort: 'high' })
    }
  })

  test('an unrelated 400 does not retry', async () => {
    delete process.env.OPENAI_REASONING_SUMMARY
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { message: 'Unknown parameter: tools[0].' } }),
        { status: 400 },
      )
    }) as unknown as typeof fetch

    await expect(
      createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
          reasoningEffort: 'high',
        }),
        signal: new AbortController().signal,
        fetchOverride,
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
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

  test('canonicalizes a complete resource URL and preserves its query', () => {
    expect(
      resolveResponsesEndpoint(
        'https://example.com/Tenant/v1/responses/?api-version=AbC#wrong',
      ),
    ).toBe('https://example.com/Tenant/v1/responses?api-version=AbC')
  })
})

describe('createOpenAIResponsesStream', () => {
  const savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_PROMPT_CACHE_KEY: process.env.OPENAI_PROMPT_CACHE_KEY,
    CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES,
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    _resetPromptCacheKeySupportForTesting()
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

  test('a compatible endpoint drops a rejected cache key within one retry budget', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_BASE_URL = 'https://gateway.internal/v1'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const bodies: Record<string, unknown>[] = []
    const fetchOverride = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >
      bodies.push(body)
      if ('prompt_cache_key' in body) {
        return new Response(
          JSON.stringify({
            error: { message: "Unknown parameter: 'prompt_cache_key'." },
          }),
          { status: 400 },
        )
      }
      return new Response('data: [DONE]\n\n', { status: 200 })
    }) as unknown as typeof fetch

    await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: formatOpenAIPromptCacheKey('responses-session'),
      }),
      signal: new AbortController().signal,
      fetchOverride,
    })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.prompt_cache_key).toBe('occ:responses-session')
    expect('prompt_cache_key' in bodies[1]!).toBe(false)
    expect(
      getOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'next-session',
        'responses',
      ),
    ).toBeUndefined()
  })

  test('cache-key degradation keeps one network retry budget', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_BASE_URL = 'https://gateway.internal/v1'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const bodies: Record<string, unknown>[] = []
    const fetchOverride = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >
      bodies.push(body)
      return new Response(
        JSON.stringify({
          error: {
            message:
              'prompt_cache_key' in body
                ? "Unknown parameter: 'prompt_cache_key'."
                : 'backend unavailable',
          },
        }),
        { status: 'prompt_cache_key' in body ? 400 : 503 },
      )
    }) as unknown as typeof fetch

    await expect(
      createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
          promptCacheKey: formatOpenAIPromptCacheKey('responses-session'),
        }),
        signal: new AbortController().signal,
        fetchOverride,
      }),
    ).rejects.toThrow(/backend unavailable/)

    expect(bodies).toHaveLength(4)
    expect(bodies[0]!.prompt_cache_key).toBe('occ:responses-session')
    for (const body of bodies.slice(1)) {
      expect('prompt_cache_key' in body).toBe(false)
    }
  })

  test('an explicit cache-key override keeps it on and does not retry 400', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.OPENAI_BASE_URL = 'https://gateway.internal/v1'
    process.env.OPENAI_PROMPT_CACHE_KEY = '1'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        JSON.stringify({
          error: { message: "Unknown parameter: 'prompt_cache_key'." },
        }),
        { status: 400 },
      )
    }) as unknown as typeof fetch

    await expect(
      createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
          promptCacheKey: formatOpenAIPromptCacheKey('forced-session'),
        }),
        signal: new AbortController().signal,
        fetchOverride,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/prompt_cache_key/)

    expect(calls).toBe(1)
    expect(
      getOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'next-session',
        'responses',
      ),
    ).toBe('occ:next-session')
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

  // The `credential` seam was added for WebSearch's pinned `codex` source. This
  // same function also carries ordinary inference, so the two cases below are
  // the guard on that: a recorded request with the parameter omitted, and the
  // parameter's effect when it is not.
  describe('the optional credential', () => {
    /** Everything the adapter hands to fetch, in full. */
    type Recorded = {
      url: string
      initKeys: string[]
      method: unknown
      headers: unknown
      body: unknown
    }

    function recorder(): { calls: Recorded[]; fetchOverride: typeof fetch } {
      const calls: Recorded[] = []
      const fetchOverride = (async (url: unknown, init?: RequestInit) => {
        calls.push({
          url: String(url),
          initKeys: Object.keys(init ?? {}).sort(),
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        })
        return new Response('data: [DONE]\n\n', { status: 200 })
      }) as unknown as typeof fetch
      return { calls, fetchOverride }
    }

    const REQUEST = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: undefined,
    })

    // The remaining fetch-init keys come from getProxyFetchOptions, which reads
    // the ambient proxy/mTLS environment. Cleared so the recorded shape below
    // is the same on a developer machine behind a corporate proxy as in CI —
    // otherwise this assertion would be about the machine, not the code.
    const TRANSPORT_ENV = [
      'https_proxy',
      'HTTPS_PROXY',
      'http_proxy',
      'HTTP_PROXY',
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY',
      'NODE_EXTRA_CA_CERTS',
    ] as const

    test('omitted, the request is the recorded pre-seam one, byte for byte', async () => {
      // Recorded from the env-only implementation and left literal on purpose:
      // the main loop passes no credential, so anything that shifts here — a
      // header, the URL derivation, the serialized body, even an extra key in
      // the fetch init — is a change to ordinary inference, not to search.
      const savedTransport = TRANSPORT_ENV.map(
        key => [key, process.env[key]] as const,
      )
      for (const key of TRANSPORT_ENV) delete process.env[key]
      process.env.OPENAI_API_KEY = 'sk-main-loop'
      process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'
      const { calls, fetchOverride } = recorder()

      try {
        await createOpenAIResponsesStream({
          request: REQUEST,
          signal: new AbortController().signal,
          fetchOverride,
        })
      } finally {
        for (const [key, value] of savedTransport) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }

      expect(calls).toEqual([
        {
          url: 'https://gateway.example/v1/responses',
          initKeys: ['body', 'headers', 'method', 'signal'],
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-main-loop',
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(REQUEST),
        },
      ])
    })

    test('supplied, it replaces the key and the endpoint together', async () => {
      process.env.OPENAI_API_KEY = 'sk-session'
      process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'
      const { calls, fetchOverride } = recorder()

      await createOpenAIResponsesStream({
        request: REQUEST,
        signal: new AbortController().signal,
        fetchOverride,
        credential: {
          apiKey: 'sk-pinned',
          baseURL: 'https://api.openai.com/v1',
        },
      })

      expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses')
      expect(calls[0]?.headers).toMatchObject({
        Authorization: 'Bearer sk-pinned',
      })
    })

    test('an endpoint-less credential goes to OpenAI, never to OPENAI_BASE_URL', async () => {
      // The leak this shape exists to prevent: falling back to the env base URL
      // for the endpoint half would post the caller's OpenAI key to whichever
      // third-party gateway the session happens to be configured for.
      process.env.OPENAI_API_KEY = 'sk-session'
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
      const { calls, fetchOverride } = recorder()

      await createOpenAIResponsesStream({
        request: REQUEST,
        signal: new AbortController().signal,
        fetchOverride,
        credential: { apiKey: 'sk-pinned' },
      })

      expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses')
      expect(calls[0]?.url).not.toContain('deepseek')
    })

    test('a credential is enough on its own — OPENAI_API_KEY need not exist', async () => {
      // The post-`/logout` state the pin exists for.
      delete process.env.OPENAI_API_KEY
      delete process.env.OPENAI_BASE_URL
      const { calls, fetchOverride } = recorder()

      await createOpenAIResponsesStream({
        request: REQUEST,
        signal: new AbortController().signal,
        fetchOverride,
        credential: { apiKey: 'sk-pinned' },
      })

      expect(calls[0]?.headers).toMatchObject({
        Authorization: 'Bearer sk-pinned',
      })
    })
  })

  test('parses CRLF frames and dispatches the final frame at EOF', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    const bytes = new TextEncoder().encode(
      'data: {"type":"first","text":"hé"}\r\n\r\n' +
        'data: {"type":"response.completed","text":"尾"}',
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
      { type: 'response.completed', text: '尾' },
    ])
  })

  for (const [label, firstResponse] of [
    ['empty', ''],
    ['metadata-only', 'data: {"type":"response.created"}\n\n'],
  ] as const) {
    test(`retries a clean ${label} EOF before a terminal event`, async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key'
      process.env.CLAUDE_CODE_MAX_RETRIES = '1'
      let calls = 0
      const fetchOverride = (async () => {
        calls++
        return new Response(
          calls === 1
            ? firstResponse
            : 'data: {"type":"ready"}\n\ndata: [DONE]\n\n',
        )
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
  }

  test('throws without retry when clean EOF follows committed output', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '1'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"visible"}\n\n',
      )
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

    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: 'visible' },
    ])
    expect(calls).toBe(1)
    expect((caught as Error).message).toBe(
      'Responses API stream ended before a terminal event',
    )
    expect(caught).toMatchObject({ retryable: true, replayable: false })
  })

  test('retries when the stream stalls before its first event', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '1'
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

  test('retries an idle timeout after metadata but before output', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    'data: {"type":"response.created"}',
                    'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}',
                    'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"ENC"}}',
                    'data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}',
                    'data: {"type":"response.reasoning_summary_text.delta","delta":""}',
                  ].join('\n\n') + '\n\n',
                ),
              )
            },
          }),
        )
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

  test('retries the reported upstream stream_read_error before output', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '1'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        calls === 1
          ? [
              'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}',
              'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1"}}',
              'data: {"type":"response.failed","response":{"error":{"type":"upstream_error","code":"stream_read_error","message":"stream_read_error"}}}',
            ].join('\n\n') + '\n\n'
          : 'data: {"type":"ready"}\n\ndata: [DONE]\n\n',
      )
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

  for (const [label, firstResponse] of [
    [
      'standard event:error',
      'event: error\ndata: {"code":"UNAVAILABLE","message":"backend unavailable"}\n\n',
    ],
    [
      'top-level data.error',
      'data: {"error":{"type":"internal_error","message":"backend failed"}}\n\n',
    ],
    [
      'response.error envelope',
      'data: {"type":"response.error","response":{"error":{"status":"DEADLINE_EXCEEDED","message":"deadline"}}}\n\n',
    ],
  ] as const) {
    test(`retries ${label} before output`, async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key'
      process.env.CLAUDE_CODE_MAX_RETRIES = '1'
      let calls = 0
      const fetchOverride = (async () => {
        calls++
        return new Response(
          calls === 1
            ? firstResponse
            : 'data: {"type":"ready"}\n\ndata: [DONE]\n\n',
        )
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
  }

  test('does not retry permanent model errors', async () => {
    // CLAUDE_CODE_MAX_RETRIES=2 means the initial attempt plus two retries.
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        'data: {"type":"response.failed","response":{"error":{"code":"model_not_found","message":"model does not exist"}}}\n\n',
      )
    }) as unknown as typeof fetch

    await expect(
      createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'missing-model',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
        }),
        signal: new AbortController().signal,
        fetchOverride,
      }),
    ).rejects.toThrow(/model does not exist/)
    expect(calls).toBe(1)
  })

  for (const [label, committedEvent] of [
    ['text output', { type: 'response.output_text.delta', delta: 'x' }],
    ['refusal output', { type: 'response.refusal.delta', delta: 'no' }],
    [
      'thinking output',
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
    ],
    [
      'function call identity',
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'Bash' },
      },
    ],
    [
      'function call arguments',
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"path":"/tmp"}',
      },
    ],
  ] as const) {
    test(`throws without retry when the stream stalls after ${label}`, async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key'
      process.env.CLAUDE_CODE_MAX_RETRIES = '1'
      process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
      let calls = 0
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(committedEvent)}\n\n`,
            ),
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

      expect(events).toEqual([committedEvent])
      expect(calls).toBe(1)
      expect((caught as Error).message).toBe(
        'Responses API stream idle timeout after 30ms',
      )
      expect(caught).toMatchObject({ retryable: true, replayable: false })
    })
  }

  test('marks an SSE API error after committed output as non-retryable', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"visible"}',
          'data: {"type":"response.failed","response":{"error":{"type":"server_error","message":"upstream failed"}}}',
        ].join('\n\n') + '\n\n',
      )
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

    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: 'visible' },
    ])
    expect(calls).toBe(1)
    expect(caught).toMatchObject({ retryable: true, replayable: false })
  })

  // ── discardsPartialOutput ────────────────────────────────────────────────
  //
  // A reader that buffers the whole response and hands it over in one piece
  // (sideQuery, the WebSearch codex adapter) can afford to replay a stream that
  // died after producing text: the partial output never left the adapter's own
  // buffer. The main loop cannot — its deltas are already on the terminal, in
  // ACP `agent_message_chunk` notifications and on `--include-partial-messages`
  // stdout, none of which can be taken back. Every case below is asserted from
  // both sides so the two policies stay visibly paired.

  /** The upstream-gateway failure from the bug report, verbatim. */
  const UPSTREAM_FAILURE =
    'data: {"type":"response.failed","response":{"error":{"type":"upstream_error","code":"stream_read_error","message":"stream_read_error"}}}\n\n'
  const PARTIAL_TEXT =
    'data: {"type":"response.output_text.delta","delta":"half an ans"}\n\n'
  const COMPLETE_RESPONSE =
    'data: {"type":"response.output_text.delta","delta":"the whole answer"}\n\n' +
    'data: {"type":"response.completed","response":{}}\n\n'
  const COMPLETE_EVENTS = [
    { type: 'response.output_text.delta', delta: 'the whole answer' },
    { type: 'response.completed', response: {} },
  ]

  function respondPerCall(bodies: (calls: number) => BodyInit): {
    fetchOverride: typeof fetch
    getCalls: () => number
  } {
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(bodies(calls))
    }) as unknown as typeof fetch
    return { fetchOverride, getCalls: () => calls }
  }

  async function drain(
    fetchOverride: typeof fetch,
    discardsPartialOutput: boolean,
  ): Promise<{ events: Record<string, unknown>[]; caught: unknown }> {
    const events: Record<string, unknown>[] = []
    let caught: unknown
    try {
      // A buffered reader reads past the first token inside the retry ladder,
      // so a permanent failure surfaces from the creation call rather than from
      // iteration. Both shapes have to land in `caught`.
      const stream = await createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          toolChoice: undefined,
        }),
        signal: new AbortController().signal,
        fetchOverride,
        discardsPartialOutput,
      })
      for await (const event of stream) events.push(event)
    } catch (error) {
      caught = error
    }
    return { events, caught }
  }

  test('a buffered reader replays a text-only failure and delivers the answer exactly once', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const { fetchOverride, getCalls } = respondPerCall(calls =>
      calls === 1 ? PARTIAL_TEXT + UPSTREAM_FAILURE : COMPLETE_RESPONSE,
    )

    const { events, caught } = await drain(fetchOverride, true)

    expect(caught).toBeUndefined()
    expect(getCalls()).toBe(2)
    // The whole point: the abandoned attempt's text never reached the reader,
    // so the answer is delivered once rather than twice.
    expect(events).toEqual(COMPLETE_EVENTS)
    expect(JSON.stringify(events)).not.toContain('half an ans')
  })

  test('a rendering reader keeps a text-only failure permanent — its deltas are already out', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const { fetchOverride, getCalls } = respondPerCall(calls =>
      calls === 1 ? PARTIAL_TEXT + UPSTREAM_FAILURE : COMPLETE_RESPONSE,
    )

    const { events, caught } = await drain(fetchOverride, false)

    expect(getCalls()).toBe(1)
    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: 'half an ans' },
    ])
    expect(caught).toMatchObject({ retryable: true, replayable: false })
  })

  for (const [label, committedEvent] of [
    [
      'function call identity',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"Bash"}}\n\n',
    ],
    [
      'function call arguments',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"command\\":\\"rm -rf /tmp/x\\"}"}\n\n',
    ],
  ] as const) {
    test(`a committed ${label} stays permanent even for a buffered reader`, async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key'
      process.env.CLAUDE_CODE_MAX_RETRIES = '2'
      const { fetchOverride, getCalls } = respondPerCall(calls =>
        calls === 1 ? committedEvent + UPSTREAM_FAILURE : COMPLETE_RESPONSE,
      )

      const { events, caught } = await drain(fetchOverride, true)

      // Replaying could announce the same tool call twice. No reader is
      // allowed to opt out of that.
      expect(getCalls()).toBe(1)
      expect(events).toHaveLength(1)
      expect(caught).toMatchObject({ retryable: true, replayable: false })
    })
  }

  test('text before a committed function call does not reopen the window', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const { fetchOverride, getCalls } = respondPerCall(calls =>
      calls === 1
        ? PARTIAL_TEXT +
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"Bash"}}\n\n' +
          UPSTREAM_FAILURE
        : COMPLETE_RESPONSE,
    )

    const { caught } = await drain(fetchOverride, true)

    expect(getCalls()).toBe(1)
    expect(caught).toMatchObject({ retryable: true, replayable: false })
  })

  test('a buffered reader replays a transport read error after text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      if (calls > 1) return new Response(COMPLETE_RESPONSE)
      // `error()` resets the queue, so enqueue-then-error in `start` would
      // drop the text and test nothing. Erroring from a later `pull` makes the
      // reader see the delta first and only then the transport failure — the
      // shape the bug report describes.
      let sentText = false
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sentText) {
              controller.error(new Error('terminated'))
              return
            }
            sentText = true
            controller.enqueue(new TextEncoder().encode(PARTIAL_TEXT))
          },
        }),
      )
    }) as unknown as typeof fetch

    const { events, caught } = await drain(fetchOverride, true)

    expect(caught).toBeUndefined()
    expect(calls).toBe(2)
    expect(events).toEqual(COMPLETE_EVENTS)
  })

  test('a rendering reader keeps a transport read error after text permanent', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      let sentText = false
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sentText) {
              controller.error(new Error('terminated'))
              return
            }
            sentText = true
            controller.enqueue(new TextEncoder().encode(PARTIAL_TEXT))
          },
        }),
      )
    }) as unknown as typeof fetch

    const { events, caught } = await drain(fetchOverride, false)

    expect(calls).toBe(1)
    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: 'half an ans' },
    ])
    expect(caught).toMatchObject({ retryable: true, replayable: false })
  })

  test('a buffered reader replays an idle timeout after text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      if (calls > 1) return new Response(COMPLETE_RESPONSE)
      // Fresh stalled body per call: reusing one would make a retry read from
      // an already-locked reader and hide the retry it is meant to prove.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(PARTIAL_TEXT))
          },
        }),
      )
    }) as unknown as typeof fetch

    const { events, caught } = await drain(fetchOverride, true)

    expect(caught).toBeUndefined()
    expect(calls).toBe(2)
    expect(events).toEqual(COMPLETE_EVENTS)
  })

  test('a buffered reader replays a clean EOF after text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const { fetchOverride, getCalls } = respondPerCall(calls =>
      calls === 1 ? PARTIAL_TEXT : COMPLETE_RESPONSE,
    )

    const { events, caught } = await drain(fetchOverride, true)

    expect(caught).toBeUndefined()
    expect(getCalls()).toBe(2)
    expect(events).toEqual(COMPLETE_EVENTS)
  })

  test('a buffered reader replays invalid SSE JSON after text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const { fetchOverride, getCalls } = respondPerCall(calls =>
      calls === 1 ? PARTIAL_TEXT + 'data: {not json\n\n' : COMPLETE_RESPONSE,
    )

    const { events, caught } = await drain(fetchOverride, true)

    expect(caught).toBeUndefined()
    expect(getCalls()).toBe(2)
    expect(events).toEqual(COMPLETE_EVENTS)
  })

  test('permanent stream errors stay off the ladder for every reader', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const { fetchOverride, getCalls } = respondPerCall(
      () =>
        PARTIAL_TEXT +
        'data: {"type":"response.failed","response":{"error":{"code":"model_not_found","message":"model does not exist"}}}\n\n',
    )

    const { caught } = await drain(fetchOverride, true)

    expect(getCalls()).toBe(1)
    expect((caught as Error).message).toMatch(/model does not exist/)
  })

  test('a 400 does not retry for a buffered reader', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'bad tool schema' },
        }),
        { status: 400 },
      )
    }) as unknown as typeof fetch

    const { caught } = await drain(fetchOverride, true)
    expect((caught as Error).message).toMatch(/bad tool schema/)
    expect(calls).toBe(1)
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

  test('completed maps to end_turn', async () => {
    const out = await collectEvents([
      { type: 'response.completed', response: { status: 'completed' } },
    ])
    const messageDelta = out.find(event => event.type === 'message_delta')
    expect(messageDelta?.delta).toEqual({
      stop_reason: 'end_turn',
      stop_sequence: null,
    })
  })

  test('max_output_tokens incomplete maps to max_tokens', async () => {
    const out = await collectEvents([
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      },
    ])
    const messageDelta = out.find(event => event.type === 'message_delta')
    expect(messageDelta?.delta).toEqual({
      stop_reason: 'max_tokens',
      stop_sequence: null,
      incomplete_reason: 'max_output_tokens',
    })
  })

  test('content_filter with refusal uses refusal without looking token-limited', async () => {
    const out = await collectEvents([
      { type: 'response.refusal.delta', delta: 'Blocked.' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        },
      },
    ])
    const messageDelta = out.find(event => event.type === 'message_delta')
    expect(messageDelta?.delta).toEqual({
      stop_reason: 'refusal',
      stop_sequence: null,
      incomplete_reason: 'content_filter',
    })
    expect(
      (messageDelta?.delta as Record<string, unknown>)?.stop_reason,
    ).not.toBe('max_tokens')
  })

  test('content_filter without refusal preserves the provider reason', async () => {
    const out = await collectEvents([
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        },
      },
    ])
    const messageDelta = out.find(event => event.type === 'message_delta')
    expect(messageDelta?.delta).toEqual({
      stop_reason: 'content_filter',
      stop_sequence: null,
      incomplete_reason: 'content_filter',
    })
  })

  test('unknown incomplete reason is an explicit non-retryable error', async () => {
    let error: unknown
    try {
      await collectEvents([
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'provider_shutdown' },
          },
        },
      ])
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ retryable: false })
    expect((error as Error).message).toContain('provider_shutdown')
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

  test('drops an id-only item — under store:false the id resolves to nothing', () => {
    // Replaying `{type:'reasoning', id:'rs_1'}` names an item the server never
    // stored. OpenAI answers 400 "Item with id 'rs_1' not found", and since the
    // item stays on the assistant message it does so on every later turn too.
    expect(extractReasoningItem({ type: 'reasoning', id: 'rs_1' })).toBeNull()
  })

  test('defaults a missing summary to an empty array', () => {
    expect(
      extractReasoningItem({
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'ENC',
      }),
    ).toEqual({
      id: 'rs_1',
      encrypted_content: 'ENC',
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
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1' },
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: { type: 'reasoning', id: 'rs_2', encrypted_content: 'ENC2' },
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

/**
 * Tool-call reconstruction, measured against how OpenAI's own Responses client
 * does it. Codex never reads `response.function_call_arguments.delta` at all
 * (its only appearance in the repo is a test fixture); it rebuilds every
 * FunctionCall from the completed item in `response.output_item.done`
 * (codex-rs/codex-api/src/sse/responses.rs:334-341, and the non-optional
 * `arguments: String` / `call_id: String` fields at
 * codex-rs/protocol/src/models.rs:875-894). occ keeps streaming the deltas so a
 * rendering caller sees arguments as they arrive, but must not depend on them.
 */
describe('Responses tool-call reconstruction', () => {
  const toolInput = (out: Record<string, unknown>[]) =>
    out
      .filter(
        e =>
          e.type === 'content_block_delta' &&
          (e.delta as Record<string, unknown>)?.type === 'input_json_delta',
      )
      .map(e => (e.delta as Record<string, unknown>).partial_json)
      .join('')

  const toolStart = (out: Record<string, unknown>[]) =>
    out.find(
      e =>
        e.type === 'content_block_start' &&
        (e.content_block as Record<string, unknown>)?.type === 'tool_use',
    )?.content_block as Record<string, unknown> | undefined

  test('falls back to the completed item when no argument deltas arrived', async () => {
    const out = await collectEvents([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'Bash' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'Bash',
          arguments: '{"command":"ls"}',
        },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    // Without the fallback the executor receives input '' for a call the model
    // made correctly, and schema validation rejects it.
    expect(toolInput(out)).toBe('{"command":"ls"}')
  })

  test('does not duplicate arguments that already streamed as deltas', async () => {
    const out = await collectEvents([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'Bash' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"command":"ls"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          arguments: '{"command":"ls"}',
        },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(toolInput(out)).toBe('{"command":"ls"}')
  })

  test('correlates argument deltas by item_id when output_index is absent', async () => {
    const out = await collectEvents([
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'Bash',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"command":"ls"}',
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    // Keyed on output_index alone these deltas landed on the `-1` default,
    // missed the block, and were dropped — an empty tool call, silently.
    expect(toolInput(out)).toBe('{"command":"ls"}')
  })

  test('correlates argument deltas by call_id when output_index is absent', async () => {
    const out = await collectEvents([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call_1', name: 'Bash' },
      },
      {
        type: 'response.function_call_arguments.delta',
        call_id: 'call_1',
        delta: '{"command":"ls"}',
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(toolInput(out)).toBe('{"command":"ls"}')
  })

  test('reconstructs a call announced only by output_item.done', async () => {
    const out = await collectEvents([
      { type: 'response.output_text.delta', delta: 'running it' },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          call_id: 'call_9',
          name: 'Bash',
          arguments: '{"command":"pwd"}',
        },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(toolStart(out)).toEqual({
      type: 'tool_use',
      id: 'call_9',
      name: 'Bash',
      input: {},
    })
    expect(toolInput(out)).toBe('{"command":"pwd"}')
    // The preceding text block has to be closed before the tool block opens.
    const order = out.map(e => e.type)
    expect(order.indexOf('content_block_stop')).toBeLessThan(
      order.indexOf(
        'content_block_start',
        order.indexOf('content_block_start') + 1,
      ),
    )
  })

  test('emits exactly one tool block when added and done both carry the call', async () => {
    const out = await collectEvents([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'Bash' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'Bash',
          arguments: '{}',
        },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    const toolStarts = out.filter(
      e =>
        e.type === 'content_block_start' &&
        (e.content_block as Record<string, unknown>)?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
  })

  test('keeps parallel tool calls on their own blocks', async () => {
    const out = await collectEvents([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_a',
          call_id: 'call_a',
          name: 'Bash',
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_b',
          call_id: 'call_b',
          name: 'Read',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_b',
        delta: '{"b":1}',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_a',
        delta: '{"a":1}',
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    const byIndex = new Map<number, string>()
    for (const event of out) {
      if (
        event.type === 'content_block_delta' &&
        (event.delta as Record<string, unknown>)?.type === 'input_json_delta'
      ) {
        const index = event.index as number
        byIndex.set(
          index,
          (byIndex.get(index) ?? '') +
            String((event.delta as Record<string, unknown>).partial_json),
        )
      }
    }
    expect([...byIndex.values()].sort()).toEqual(['{"a":1}', '{"b":1}'])
  })
})

/**
 * A reasoning summary is delivered as several parts, each its own paragraph
 * with its own header, separated by `response.reasoning_summary_part.added`
 * and a bumped `summary_index` — and by no whitespace of its own. Codex breaks
 * the section on that event (codex-rs/tui/src/chatwidget/protocol.rs:88 →
 * `on_reasoning_section_break`, codex-rs/tui/src/chatwidget/streaming.rs:290).
 */
describe('Responses reasoning summary parts', () => {
  const thinking = (out: Record<string, unknown>[]) =>
    out
      .filter(
        e =>
          e.type === 'content_block_delta' &&
          (e.delta as Record<string, unknown>)?.type === 'thinking_delta',
      )
      .map(e => (e.delta as Record<string, unknown>).thinking)
      .join('')

  test('separates parts announced by reasoning_summary_part.added', async () => {
    const out = await collectEvents([
      {
        type: 'response.reasoning_summary_text.delta',
        delta: '**Reading files**',
      },
      { type: 'response.reasoning_summary_part.added', summary_index: 1 },
      { type: 'response.reasoning_summary_text.delta', delta: '**Editing**' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(thinking(out)).toBe('**Reading files**\n\n**Editing**')
  })

  test('separates parts signalled only by a bumped summary_index', async () => {
    const out = await collectEvents([
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        delta: 'first',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 1,
        delta: 'second',
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(thinking(out)).toBe('first\n\nsecond')
  })

  test('breaks once when both signals arrive for the same seam', async () => {
    const out = await collectEvents([
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        delta: 'first',
      },
      { type: 'response.reasoning_summary_part.added', summary_index: 1 },
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 1,
        delta: 'second',
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(thinking(out)).toBe('first\n\nsecond')
  })

  test('never leads a thinking block with a blank line', async () => {
    const out = await collectEvents([
      { type: 'response.reasoning_summary_part.added', summary_index: 0 },
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        delta: 'only part',
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(thinking(out)).toBe('only part')
  })

  test('keeps deltas of one part contiguous', async () => {
    const out = await collectEvents([
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        delta: 'a',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        delta: 'b',
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(thinking(out)).toBe('ab')
  })
})

describe('mid-stream rate limits state their wait in prose', () => {
  const savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_PROMPT_CACHE_KEY: process.env.OPENAI_PROMPT_CACHE_KEY,
    CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function failedFrame(message: string): string {
    return `data: ${JSON.stringify({
      type: 'response.failed',
      response: {
        error: {
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          message,
        },
      },
    })}\n\n`
  }

  test('preserves a long wait parsed from a mid-stream error', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '0'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(
        failedFrame('Rate limit reached. Please try again in 3600s.'),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const error = await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
      }),
      signal: new AbortController().signal,
      fetchOverride,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect((error as { retryAfterMs?: number })?.retryAfterMs).toBe(3_600_000)
    expect(calls).toBe(1)
  })

  test('a short wait stays on the ladder', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CODE_MAX_RETRIES = '0'
    let calls = 0
    const fetchOverride = (async () => {
      calls++
      return new Response(failedFrame('Please try again in 1.5s.'), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const error = await createOpenAIResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: undefined,
      }),
      signal: new AbortController().signal,
      fetchOverride,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect((error as { retryAfterMs?: number })?.retryAfterMs).toBe(1500)
    // The injected fetch is the only transport these cases ever reach; a real
    // request would have needed a credential none of them supply.
    expect(calls).toBe(1)
  })
})
