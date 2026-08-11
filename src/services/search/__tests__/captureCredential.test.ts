/**
 * Capturing the credential a search source is currently using, so it can be
 * pinned.
 *
 * The refusals matter more than the successes here. `ANTHROPIC_API_KEY` is not
 * always an Anthropic key — the DeepSeek wire and the OpenCode wire both mirror
 * their own credential onto it — and capturing one of those would write another
 * provider's secret into the search store under Anthropic's name and then send
 * it to api.anthropic.com.
 *
 * Env only, no module mocks: every branch under test is a function of
 * process.env plus the mirrors' own in-memory bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { applyDeepSeekAnthropicWire } from 'src/utils/model/deepseekWire.js'
import { captureSearchCredentialFromEnvironment } from '../captureCredential.js'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_WIRE_API',
] as const

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  // Release any claim a previous test (or this process's startup) left behind.
  applyDeepSeekAnthropicWire()
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  applyDeepSeekAnthropicWire()
  for (const [key, value] of saved) {
    if (value !== undefined) process.env[key] = value
  }
})

describe('gemini', () => {
  test('captures the key and endpoint the lane is using', () => {
    process.env.GEMINI_API_KEY = 'AIza-live'
    process.env.GEMINI_BASE_URL = 'https://gemini.example/v1beta'

    expect(captureSearchCredentialFromEnvironment('gemini')).toEqual({
      credential: {
        apiKey: 'AIza-live',
        baseURL: 'https://gemini.example/v1beta',
      },
    })
  })

  test('refuses when there is only a Google login to copy', () => {
    // An OAuth token is not a credential this panel will duplicate onto disk;
    // the message has to say what would give the user a survivable one instead.
    const result = captureSearchCredentialFromEnvironment('gemini')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/GEMINI_API_KEY/)
  })
})

describe('deepseek', () => {
  test('captures the derived endpoint, not the raw base URL', () => {
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-live'

    expect(captureSearchCredentialFromEnvironment('deepseek')).toEqual({
      credential: {
        apiKey: 'sk-live',
        baseURL: 'https://api.deepseek.com/anthropic',
      },
    })
  })

  test('refuses when nothing DeepSeek-shaped is configured', () => {
    expect(captureSearchCredentialFromEnvironment('deepseek')).toHaveProperty(
      'error',
    )
  })
})

describe('anthropic', () => {
  test('captures a real key with its endpoint', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-live'
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

    expect(captureSearchCredentialFromEnvironment('anthropic')).toEqual({
      credential: {
        apiKey: 'sk-ant-live',
        baseURL: 'https://api.anthropic.com',
      },
    })
  })

  test('refuses while the DeepSeek routing owns the Anthropic keys', () => {
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-deepseek'
    applyDeepSeekAnthropicWire()

    // The keys are populated — and every one of them is DeepSeek's.
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-deepseek')
    const result = captureSearchCredentialFromEnvironment('anthropic')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/DeepSeek/)
  })

  test('refuses a mirrored key even once the routing is no longer active', () => {
    // The mirror claims ANTHROPIC_API_KEY, then an explicit wire choice turns
    // the routing off without releasing it. Only the mirror's own bookkeeping
    // can tell that this value is not the user's Anthropic key.
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-deepseek'
    applyDeepSeekAnthropicWire()
    process.env.OPENAI_WIRE_API = 'chat'

    const result = captureSearchCredentialFromEnvironment('anthropic')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(
      /another provider’s credential/,
    )
  })

  test('refuses when there is only a subscription login', () => {
    expect(captureSearchCredentialFromEnvironment('anthropic')).toHaveProperty(
      'error',
    )
  })
})

describe('codex', () => {
  test('is refused before anything is read from the environment', () => {
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

    const result = captureSearchCredentialFromEnvironment('codex')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/ChatGPT account/)
  })
})
