import { afterEach, describe, expect, test } from 'bun:test'
import {
  getOpenAIPromptCacheKey,
  isOfficialOpenAIBaseURL,
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

  test('returns undefined for compatible endpoints', () => {
    expect(
      getOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'session-1'),
    ).toBeUndefined()
  })
})

describe('shouldSendOpenAIPromptCacheKey', () => {
  afterEach(() => {
    delete process.env.OPENAI_PROMPT_CACHE_KEY
  })

  test('Chat Completions defaults to official OpenAI endpoints only', () => {
    // The OpenAI-compatible *chat* ecosystem (GLM/Kimi/DeepSeek/Cerebras) is
    // where strict servers 400 on unknown top-level keys.
    expect(shouldSendOpenAIPromptCacheKey(undefined, 'chat')).toBe(true)
    expect(
      shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'chat'),
    ).toBe(false)
    // No protocol given behaves like chat.
    expect(shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1')).toBe(
      false,
    )
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

  test('an unparseable value falls back to the base-URL decision', () => {
    process.env.OPENAI_PROMPT_CACHE_KEY = 'maybe'
    expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(true)
    expect(shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1')).toBe(
      false,
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
