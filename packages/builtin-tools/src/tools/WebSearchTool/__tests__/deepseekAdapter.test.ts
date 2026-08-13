import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { registerAPIRetryHost } from '@open-claude-code/tool-runtime/apiRetry.js'
import { retryOpenAIRequest } from 'src/services/api/openai/retry.js'
import {
  DeepSeekDirectSearchAdapter,
  probeDeepSeekSearchSupport,
  resetDeepSeekSearchProbe,
  resolveDeepSeekSearchModel,
} from '../adapters/deepseekAdapter'
import {
  isSourceAvailable,
  resetSourceAvailability,
} from '../adapters/searchSources'

const ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
] as const

const saved = new Map<string, string | undefined>()

type StubReply = {
  status?: number
  body?: unknown
  text?: string
}

/** A fetch that records the one request it is given and replays a canned reply. */
function stubFetch(reply: StubReply): typeof fetch & {
  calls: Array<{ url: string; body: Record<string, unknown> }>
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body,
      text: async () => reply.text ?? JSON.stringify(reply.body ?? ''),
    } as unknown as Response
  }) as unknown as typeof fetch & { calls: typeof calls }
  impl.calls = calls
  return impl
}

function stubFetchSequence(replies: StubReply[]): ReturnType<typeof stubFetch> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const impl = (async (url: string, init?: RequestInit) => {
    const reply = replies[calls.length] ?? replies.at(-1) ?? {}
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body,
      text: async () => reply.text ?? JSON.stringify(reply.body ?? ''),
    } as unknown as Response
  }) as ReturnType<typeof stubFetch>
  impl.calls = calls
  return impl
}

/** The success shape DeepSeek really returns (captured from api.deepseek.com). */
function searchReply(urls: string[]): unknown {
  return {
    content: [
      {
        type: 'server_tool_use',
        id: 'x',
        name: 'web_search',
        input: { query: 'q' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'x',
        content: urls.map(url => ({
          type: 'web_search_result',
          title: `title for ${url}`,
          url,
          page_age: null,
          encrypted_content: 'opaque',
        })),
      },
      { type: 'text', text: 'here you go' },
    ],
  }
}

beforeEach(() => {
  registerAPIRetryHost({
    retry: (operation, options) =>
      retryOpenAIRequest(operation, {
        ...options,
        delay: async () => {},
      }),
  })
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetDeepSeekSearchProbe()
  resetSourceAvailability()
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
  process.env.OPENAI_API_KEY = 'sk-test'
})

afterEach(() => {
  registerAPIRetryHost(null)
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetDeepSeekSearchProbe()
  resetSourceAvailability()
})

describe('resolveDeepSeekSearchModel', () => {
  test('prefers a tier model the user actually named', () => {
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    expect(resolveDeepSeekSearchModel()).toBe('deepseek-v4-flash')
  })

  test('the mirrored Anthropic tier key wins, since it is what the session uses', () => {
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-chat'
    expect(resolveDeepSeekSearchModel()).toBe('deepseek-chat')
  })
})

describe('DeepSeekDirectSearchAdapter', () => {
  test('posts to the /anthropic Messages route with the server tool declared', async () => {
    const fetchOverride = stubFetch({
      body: searchReply(['https://a.example/1']),
    })
    await new DeepSeekDirectSearchAdapter({ fetchOverride }).search('q', {})

    const call = fetchOverride.calls[0]
    expect(call?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(call?.body.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
    ])
  })

  test('a base URL carrying query parameters still gets a well-formed path', async () => {
    // The adapter consumes `endpoint.messagesURL` rather than concatenating
    // `${baseURL}/v1/messages`: on a base with a query the concatenation put the
    // whole path INSIDE the query value and the request went to the wrong route.
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1?tenant=x'
    const fetchOverride = stubFetch({
      body: searchReply(['https://a.example/1']),
    })

    await new DeepSeekDirectSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.deepseek.com/anthropic/v1/messages?tenant=x',
    )
  })

  test('maps web_search_result blocks into results', async () => {
    const fetchOverride = stubFetch({
      body: searchReply(['https://a.example/1', 'https://b.example/2']),
    })

    const results = await new DeepSeekDirectSearchAdapter({
      fetchOverride,
    }).search('q', {})

    expect(results.map(r => r.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ])
  })

  test('an in-array tool error is not mistaken for a result', async () => {
    // DeepSeek reports a failed search as an ITEM inside the content array
    // rather than replacing the array with an error object. Read as a result it
    // became a `{title: undefined, url: undefined}` row the model cannot follow.
    const fetchOverride = stubFetch({
      body: {
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'x',
            content: [
              {
                type: 'web_search_tool_result_error',
                error_code: 'invalid_tool_input',
              },
            ],
          },
        ],
      },
    })

    await expect(
      new DeepSeekDirectSearchAdapter({ fetchOverride }).search('q', {}),
    ).rejects.toThrow(/invalid_tool_input/)
  })

  test('a partial failure still returns the hits that came back', async () => {
    const fetchOverride = stubFetch({
      body: {
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'x',
            content: [
              {
                type: 'web_search_tool_result_error',
                error_code: 'too_many_requests',
              },
              {
                type: 'web_search_result',
                title: 't',
                url: 'https://a.example/1',
              },
            ],
          },
        ],
      },
    })

    const results = await new DeepSeekDirectSearchAdapter({
      fetchOverride,
    }).search('q', {})
    expect(results.map(r => r.url)).toEqual(['https://a.example/1'])
  })

  test('retries a transient API failure before returning results', async () => {
    const fetchOverride = stubFetchSequence([
      { status: 503, text: 'upstream unavailable' },
      { body: searchReply(['https://a.example/1']) },
    ])

    const results = await new DeepSeekDirectSearchAdapter({
      fetchOverride,
    }).search('q', {})

    expect(fetchOverride.calls).toHaveLength(2)
    expect(results.map(result => result.url)).toEqual(['https://a.example/1'])
  })

  test('a rejected tool schema is phrased so the health wrapper retires the lane', async () => {
    const fetchOverride = stubFetch({
      status: 400,
      text: 'Unsupported tool type: web_search_20250305',
    })

    await expect(
      new DeepSeekDirectSearchAdapter({ fetchOverride }).search('q', {}),
    ).rejects.toThrow(/does not support web_search/)
    expect(fetchOverride.calls).toHaveLength(1)
  })

  test('enforces the domain filter client-side', async () => {
    const fetchOverride = stubFetch({
      body: searchReply(['https://keep.example/1', 'https://drop.example/2']),
    })

    const results = await new DeepSeekDirectSearchAdapter({
      fetchOverride,
    }).search('q', { allowedDomains: ['keep.example'] })

    expect(results.map(r => r.url)).toEqual(['https://keep.example/1'])
  })
})

describe('probeDeepSeekSearchSupport', () => {
  test('a 200 means the endpoint serves the tool', async () => {
    const fetchOverride = stubFetch({ body: { content: [] } })
    expect(await probeDeepSeekSearchSupport({ fetchOverride })).toEqual({
      status: 'supported',
    })
  })

  test('probes without composing an answer', async () => {
    const fetchOverride = stubFetch({ body: { content: [] } })
    await probeDeepSeekSearchSupport({ fetchOverride })
    expect(fetchOverride.calls[0]?.body.max_tokens).toBe(16)
  })

  test('a rejected tool retires the source for the session', async () => {
    const fetchOverride = stubFetch({
      status: 400,
      text: 'unsupported tool: web_search',
    })

    const verdict = await probeDeepSeekSearchSupport({ fetchOverride })
    expect(verdict.status).toBe('unsupported')
    expect(isSourceAvailable('deepseek')).toBe(false)
  })

  test('a transient failure is NOT allowed to retire the source', async () => {
    // 401/429/5xx say nothing about whether the deployment serves web_search.
    // Retiring on one would take the lane away for the rest of the session over
    // an expired key or a rate limit.
    for (const status of [401, 429, 500]) {
      resetDeepSeekSearchProbe()
      resetSourceAvailability()
      const verdict = await probeDeepSeekSearchSupport({
        fetchOverride: stubFetch({ status, text: 'nope' }),
      })
      expect(verdict.status).toBe('unreachable')
      expect(isSourceAvailable('deepseek')).toBe(true)
    }
  })

  test('a transient verdict is not cached, a capability verdict is', async () => {
    const flaky = stubFetch({ status: 503, text: 'upstream down' })
    await probeDeepSeekSearchSupport({ fetchOverride: flaky })

    const good = stubFetch({ body: { content: [] } })
    expect(
      (await probeDeepSeekSearchSupport({ fetchOverride: good })).status,
    ).toBe('supported')
    expect(good.calls).toHaveLength(1)

    // Cached now: a second ask must not hit the network again.
    const unused = stubFetch({ status: 500, text: 'should not be called' })
    expect(
      (await probeDeepSeekSearchSupport({ fetchOverride: unused })).status,
    ).toBe('supported')
    expect(unused.calls).toHaveLength(0)
  })

  test('a cached "unsupported" survives resetSourceAvailability', async () => {
    // resetSourceAvailability() runs after a login so a source retired earlier
    // can come back. A DeepSeek endpoint that already answered "no" has not
    // changed its mind, and the row must not silently un-grey.
    await probeDeepSeekSearchSupport({
      fetchOverride: stubFetch({
        status: 400,
        text: 'unsupported tool: web_search',
      }),
    })
    resetSourceAvailability()
    expect(isSourceAvailable('deepseek')).toBe(true)

    await probeDeepSeekSearchSupport({
      fetchOverride: stubFetch({ status: 500, text: 'not called' }),
    })
    expect(isSourceAvailable('deepseek')).toBe(false)
  })

  test('no DeepSeek configuration means no probe and no network', async () => {
    delete process.env.OPENAI_BASE_URL
    const fetchOverride = stubFetch({ body: {} })

    expect(await probeDeepSeekSearchSupport({ fetchOverride })).toEqual({
      status: 'unconfigured',
    })
    expect(fetchOverride.calls).toHaveLength(0)
  })

  test('the documented kill switch takes the source out entirely', async () => {
    process.env.CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE = '0'
    const fetchOverride = stubFetch({ body: {} })

    expect(await probeDeepSeekSearchSupport({ fetchOverride })).toEqual({
      status: 'unconfigured',
    })
    expect(fetchOverride.calls).toHaveLength(0)
  })
})
