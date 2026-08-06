import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

// Only the credential-file probes are mocked — they are the side-effecting
// dependencies (OAuth stores on disk). `isOfficialOpenAIBaseURL` is a pure
// function and runs for real, since it is the half under test.
//
// Complete-surface shared mocks, never a hand-rolled `mock.module`: Bun's
// module registry is process-global and last-write-wins, and chatgptAuth.ts is
// mocked by the WebSearch adapter suites too. A partial surface here made those
// files fail to load with "Export named 'getValidChatGPTAuth' not found".
import * as realChatGPTAuth from 'src/services/api/openai/chatgptAuth.js'
import * as realGeminiOAuth from 'src/services/api/gemini/oauthToken.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'

const chatGPTAuthMock = makeSharedModuleMock(
  'src/services/api/openai/chatgptAuth.js',
  realChatGPTAuth,
).setup()
makeSharedModuleMock(
  'src/services/api/gemini/oauthToken.js',
  realGeminiOAuth,
).setup({ hasGeminiOAuthCredentialsSync: () => false })

let chatGPTAuthOnDisk = false
chatGPTAuthMock.set({ hasStoredChatGPTAuthSync: () => chatGPTAuthOnDisk })

const { hasCodexSearchCredentials } = await import('../sourceCredentials')

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  chatGPTAuthOnDisk = false
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

// Hand every export back to the real module for whatever runs next in this
// process.
afterAll(() => {
  chatGPTAuthMock.reset()
})

describe('hasCodexSearchCredentials', () => {
  test('is false with no credentials at all', () => {
    expect(hasCodexSearchCredentials()).toBe(false)
  })

  test('a ChatGPT login counts regardless of the base URL', () => {
    chatGPTAuthOnDisk = true
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    // The OAuth route authenticates against OpenAI's own backend by
    // construction, so OPENAI_BASE_URL is irrelevant to it.
    expect(hasCodexSearchCredentials()).toBe(true)
  })

  test('an API key with no base URL counts — the SDK default is OpenAI', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(hasCodexSearchCredentials()).toBe(true)
  })

  test('an API key against the official endpoint counts', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    expect(hasCodexSearchCredentials()).toBe(true)
  })

  test.each([
    ['DeepSeek', 'https://api.deepseek.com'],
    ['GLM', 'https://open.bigmodel.cn/api/paas/v4'],
    ['Moonshot', 'https://api.moonshot.cn/v1'],
    ['a LiteLLM gateway', 'https://litellm.internal.example/v1'],
    ['a local vLLM', 'http://localhost:8000/v1'],
  ])('an API key pointed at %s does NOT light the source', (_label, baseUrl) => {
    // The key here belongs to THAT vendor, and none of them run OpenAI's
    // server-side web_search. Lighting the lane made it the session's primary
    // source and returned zero results on every query, silently.
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = baseUrl
    expect(hasCodexSearchCredentials()).toBe(false)
  })

  test('a base URL with no key is not enough on its own', () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    expect(hasCodexSearchCredentials()).toBe(false)
  })

  test('a malformed base URL is treated as not-OpenAI', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = 'not a url'
    expect(hasCodexSearchCredentials()).toBe(false)
  })
})
