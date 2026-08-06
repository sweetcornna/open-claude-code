import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetPromptCacheKeySupportForTesting,
  getOpenAIPromptCacheKey,
  isOfficialOpenAIBaseURL,
  isPromptCacheKeyRejection,
  markPromptCacheKeyRejected,
  resolveOpenAIVerbosity,
  shouldSendOpenAIPromptCacheKey,
} from '../openaiShared.js'

describe('resolveOpenAIVerbosity', () => {
  afterEach(() => {
    delete process.env.OPENAI_VERBOSITY
  })

  test('defaults eligible official and ChatGPT GPT routes to low', () => {
    expect(
      resolveOpenAIVerbosity('gpt-5.6-sol', {
        baseURL: undefined,
        isChatGPTAuth: false,
      }),
    ).toBe('low')
    expect(
      resolveOpenAIVerbosity('gpt-5.6-terra', {
        baseURL: 'https://compatible.example/v1',
        isChatGPTAuth: true,
      }),
    ).toBe('low')
  })

  test('honors low, medium, and high overrides on eligible routes', () => {
    for (const value of ['low', 'medium', 'high'] as const) {
      process.env.OPENAI_VERBOSITY = value
      expect(
        resolveOpenAIVerbosity('gpt-5.6-sol', {
          baseURL: 'https://api.openai.com/v1',
          isChatGPTAuth: false,
        }),
      ).toBe(value)
    }
  })

  test('off, zero, and false omit the field', () => {
    for (const value of ['off', '0', 'false']) {
      process.env.OPENAI_VERBOSITY = value
      expect(
        resolveOpenAIVerbosity('gpt-5.6-sol', {
          baseURL: undefined,
          isChatGPTAuth: false,
        }),
      ).toBeUndefined()
    }
  })

  test('never sends verbosity to compatible endpoints or non-GPT models', () => {
    process.env.OPENAI_VERBOSITY = 'high'
    expect(
      resolveOpenAIVerbosity('gpt-5.6-sol', {
        baseURL: 'https://compatible.example/v1',
        isChatGPTAuth: false,
      }),
    ).toBe('high')
    expect(
      resolveOpenAIVerbosity('deepseek-reasoner', {
        baseURL: undefined,
        isChatGPTAuth: false,
      }),
    ).toBeUndefined()
  })

  test('omits verbosity for compatible endpoints without an override', () => {
    delete process.env.OPENAI_VERBOSITY
    expect(
      resolveOpenAIVerbosity('gpt-5.6-sol', {
        baseURL: 'https://compatible.example/v1',
        isChatGPTAuth: false,
      }),
    ).toBeUndefined()
  })
})

describe('isOfficialOpenAIBaseURL', () => {
  test('treats the SDK default endpoint as official OpenAI', () => {
    expect(isOfficialOpenAIBaseURL(undefined)).toBe(true)
    expect(isOfficialOpenAIBaseURL('')).toBe(true)
  })

  test('accepts global and regional official OpenAI endpoints', () => {
    expect(isOfficialOpenAIBaseURL('https://api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIBaseURL('https://eu.api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIBaseURL('https://api.openai.com:443/v1')).toBe(true)
  })

  test('rejects OpenAI-compatible and spoofed endpoints', () => {
    expect(isOfficialOpenAIBaseURL('https://api.deepseek.com/v1')).toBe(false)
    expect(isOfficialOpenAIBaseURL('http://api.openai.com/v1')).toBe(false)
    expect(isOfficialOpenAIBaseURL('https://api.openai.com.evil.test/v1')).toBe(
      false,
    )
    expect(isOfficialOpenAIBaseURL('https://api.openai.com:8443/v1')).toBe(
      false,
    )
    expect(isOfficialOpenAIBaseURL('not-a-url')).toBe(false)
  })
})

describe('getOpenAIPromptCacheKey', () => {
  test('returns a session key for the SDK default and official endpoint', () => {
    expect(getOpenAIPromptCacheKey(undefined, 'session-1')).toBe(
      'occ:session-1',
    )
    expect(
      getOpenAIPromptCacheKey('https://api.openai.com/v1', 'session-2'),
    ).toBe('occ:session-2')
  })

  test('compatible endpoints get a key too, until one rejects it', () => {
    expect(
      getOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'session-1'),
    ).toBe('occ:session-1')

    markPromptCacheKeyRejected()
    try {
      expect(
        getOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'session-1'),
      ).toBeUndefined()
      // OpenAI's own endpoint documents the field — one strict gateway must
      // not switch it off there.
      expect(
        getOpenAIPromptCacheKey('https://api.openai.com/v1', 'session-1'),
      ).toBe('occ:session-1')
    } finally {
      _resetPromptCacheKeySupportForTesting()
    }
  })
})

describe('shouldSendOpenAIPromptCacheKey', () => {
  afterEach(() => {
    delete process.env.OPENAI_PROMPT_CACHE_KEY
  })

  test('Chat Completions sends the key by default, on any base URL', () => {
    // It used to be official-OpenAI-only, which left the single largest cache
    // lever opt-in for the population that needs it most: OpenAI behind a chat
    // gateway. Endpoints that cannot take the field say so, once.
    expect(shouldSendOpenAIPromptCacheKey(undefined, 'chat')).toBe(true)
    expect(
      shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'chat'),
    ).toBe(true)
    // No protocol given behaves like chat.
    expect(shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1')).toBe(
      true,
    )
  })

  test('a rejection suppresses the key for compatible endpoints only', () => {
    markPromptCacheKeyRejected()
    try {
      expect(
        shouldSendOpenAIPromptCacheKey('https://gateway.internal/v1', 'chat'),
      ).toBe(false)
      expect(
        shouldSendOpenAIPromptCacheKey('https://api.openai.com/v1', 'chat'),
      ).toBe(true)
      // /responses implements the field by definition — a chat-line rejection
      // says nothing about it.
      expect(
        shouldSendOpenAIPromptCacheKey(
          'https://gateway.internal/v1',
          'responses',
        ),
      ).toBe(true)
      // The explicit override still wins over the latch.
      process.env.OPENAI_PROMPT_CACHE_KEY = '1'
      expect(
        shouldSendOpenAIPromptCacheKey('https://gateway.internal/v1', 'chat'),
      ).toBe(true)
    } finally {
      _resetPromptCacheKeySupportForTesting()
    }
  })

  test('classifies only genuine prompt_cache_key rejections', () => {
    expect(
      isPromptCacheKeyRejection(
        new Error("400 Unknown parameter: 'prompt_cache_key'."),
      ),
    ).toBe(true)
    expect(
      isPromptCacheKeyRejection(
        new Error('Extra inputs are not permitted: prompt_cache_key'),
      ),
    ).toBe(true)
    // An unrelated 400 must still fail the turn.
    expect(
      isPromptCacheKeyRejection(new Error("400 Unknown parameter: 'tools'.")),
    ).toBe(false)
    expect(isPromptCacheKeyRejection(new Error('rate limited'))).toBe(false)
  })

  test('the Responses protocol always gets a key, on any base URL', () => {
    // Measured against a live gateway (5 turns, identical prefix): omitting
    // the key dropped the cumulative hit rate from 75.8% to 18.3%, per-turn
    // 95/0/0/0/0. Serving /responses means implementing OpenAI's Responses
    // schema, where prompt_cache_key is a documented standard field.
    expect(
      shouldSendOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'responses',
      ),
    ).toBe(true)
    expect(
      getOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'sess',
        'responses',
      ),
    ).toBe('occ:sess')
  })

  test('OPENAI_PROMPT_CACHE_KEY=1 opts a gateway in', () => {
    // The common "OpenAI behind LiteLLM/one-api/OpenRouter" setup: the gateway
    // forwards the key, and without it a multi-turn session is free to land on
    // a different cache node each turn.
    process.env.OPENAI_PROMPT_CACHE_KEY = '1'
    expect(shouldSendOpenAIPromptCacheKey('https://gateway.internal/v1')).toBe(
      true,
    )
    expect(getOpenAIPromptCacheKey('https://gateway.internal/v1', 'sess')).toBe(
      'occ:sess',
    )
  })

  test('OPENAI_PROMPT_CACHE_KEY=0 forces it off, including on /responses', () => {
    // Escape hatch for a gateway that passes unknown keys through to an
    // upstream that rejects them.
    process.env.OPENAI_PROMPT_CACHE_KEY = '0'
    expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(false)
    expect(
      shouldSendOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'responses',
      ),
    ).toBe(false)
    expect(getOpenAIPromptCacheKey(undefined, 'sess')).toBeUndefined()
  })

  test('an unparseable value falls back to the default decision', () => {
    process.env.OPENAI_PROMPT_CACHE_KEY = 'maybe'
    expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(true)
    expect(shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1')).toBe(
      true,
    )
  })

  test('accepts the same spellings as isEnvTruthy/isEnvDefinedFalsy', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      process.env.OPENAI_PROMPT_CACHE_KEY = value
      expect(shouldSendOpenAIPromptCacheKey('https://compat.example/v1')).toBe(
        true,
      )
    }
    for (const value of ['0', 'false', 'NO', ' off ']) {
      process.env.OPENAI_PROMPT_CACHE_KEY = value
      expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(false)
    }
  })
})
