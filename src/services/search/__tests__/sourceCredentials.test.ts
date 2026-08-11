import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { occConfigDir } from 'src/config/paths.js'

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

const {
  hasCodexSearchCredentials,
  hasDeepSeekSearchCredentials,
  hasGeminiSearchCredentials,
} = await import('../sourceCredentials')
const { pinSearchCredential, reloadPinnedSearchCredentials } = await import(
  '../searchCredentialStore.js'
)

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
] as const
const saved: Record<string, string | undefined> = {}

// A temporary config root for the whole file, so the developer's own pinned
// credentials can never light a source these tests expect to be dark.
const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-search-credentials-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
})

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  chatGPTAuthOnDisk = false
  rmSync(join(tempDir, 'search-credentials.json'), { force: true })
  reloadPinnedSearchCredentials()
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
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
  rmSync(tempDir, { recursive: true, force: true })
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

describe('a pinned credential lights a source with no provider env at all', () => {
  test('gemini', async () => {
    // The Google login probe is mocked to "not connected" and GEMINI_API_KEY is
    // unset, so the only thing that can answer here is the pin — which is the
    // state a user is left in the moment /logout runs.
    expect(hasGeminiSearchCredentials()).toBe(false)

    await pinSearchCredential('gemini', { apiKey: 'AIza-pinned' })

    expect(hasGeminiSearchCredentials()).toBe(true)
  })

  test('deepseek, carrying its own endpoint', async () => {
    expect(hasDeepSeekSearchCredentials()).toBe(false)

    await pinSearchCredential('deepseek', {
      apiKey: 'sk-pinned',
      baseURL: 'https://api.deepseek.com',
    })

    expect(hasDeepSeekSearchCredentials()).toBe(true)
  })

  test('codex is not among them — its lane could not send the key', async () => {
    // Kept as a test rather than left implicit: a pin that lights this row
    // without the request layer reading it is the silent-empty-lane failure,
    // and the store is the only place that can refuse it.
    await expect(
      pinSearchCredential('codex', { apiKey: 'sk-pinned' }),
    ).rejects.toThrow()
    expect(hasCodexSearchCredentials()).toBe(false)
  })
})
