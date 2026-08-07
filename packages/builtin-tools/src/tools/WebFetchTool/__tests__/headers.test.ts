import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'
import { setupSettingsMock } from '../../../../../../tests/mocks/settings.js'
import { setupHttpMock } from '../../../../../../tests/mocks/http.js'

type MockAxiosResponse = {
  data: ArrayBuffer
  headers: Record<string, unknown>
  status: number
  statusText: string
}

type MockAxiosError = Error & {
  isAxiosError: true
  code?: string
  response?: {
    headers: Record<string, unknown>
    status: number
  }
}

let getMock: (url: string) => Promise<MockAxiosResponse>
let postMock: (
  url: string,
  data: unknown,
  config: Record<string, unknown>,
) => Promise<unknown>

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = (url: string) => getMock(url)
axiosHandle.stubs.post = (
  url: string,
  data: unknown,
  config: Record<string, unknown>,
) => postMock(url, data, config)
axiosHandle.stubs.isAxiosError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { isAxiosError?: unknown }).isAxiosError === true

mock.module('@open-claude-code/tool-runtime/analytics.js', () => ({
  logEvent: () => {},
}))

mock.module('src/services/api/claude.js', () => ({
  queryHaiku: async () => ({ message: { content: [] } }),
}))

const httpMock = setupHttpMock({
  getWebFetchUserAgent: () => 'TestAgent/1.0',
})
afterAll(() => httpMock.reset())

mock.module('src/utils/telemetry/log.ts', logMock)

mock.module('src/utils/mcp/mcpOutputStorage.js', () => ({
  isBinaryContentType: (contentType: string) =>
    !contentType.toLowerCase().startsWith('text/'),
  persistBinaryContent: async () => ({
    filepath: '/tmp/webfetch-test.bin',
    size: 0,
  }),
}))

const settingsMock = setupSettingsMock({
  getInitialSettings: () => ({}),
  getSettings_DEPRECATED: () => ({ skipWebFetchPreflight: true }),
})
afterAll(() => settingsMock.reset())

beforeEach(() => {
  getMock = async () => ({
    data: new TextEncoder().encode('hello').buffer,
    headers: { 'content-type': 'text/plain' },
    status: 200,
    statusText: 'OK',
  })
  postMock = async () => ({
    data: { raw_content: 'hello from tavily' },
    headers: {},
    status: 200,
    statusText: 'OK',
  })
})

beforeAll(() => {
  axiosHandle.useStubs = true
})

afterAll(() => {
  axiosHandle.useStubs = false
})

describe('WebFetch response headers', () => {
  test('reads redirect Location from AxiosHeaders-style get()', async () => {
    getMock = async () => {
      const error = new Error('redirect') as MockAxiosError
      error.isAxiosError = true
      error.response = {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location' ? '/next' : undefined,
        },
        status: 302,
      }
      throw error
    }

    const { getWithPermittedRedirects } = await import('../utils')
    const result = await getWithPermittedRedirects(
      'https://example.com/old',
      new AbortController().signal,
      () => false,
    )

    expect(result).toEqual({
      type: 'redirect',
      originalUrl: 'https://example.com/old',
      redirectUrl: 'https://example.com/next',
      statusCode: 302,
    })
  })

  test('reads proxy block markers from normalized headers', async () => {
    getMock = async () => {
      const error = new Error('blocked') as MockAxiosError
      error.isAxiosError = true
      error.response = {
        headers: { 'x-proxy-error': 'blocked-by-allowlist' },
        status: 403,
      }
      throw error
    }

    const { getWithPermittedRedirects } = await import('../utils')

    await expect(
      getWithPermittedRedirects(
        'https://blocked.example/path',
        new AbortController().signal,
        () => false,
      ),
    ).rejects.toThrow('EGRESS_BLOCKED')
  })

  test('normalizes array content-type before cache and parsing', async () => {
    getMock = async () => ({
      data: new TextEncoder().encode('plain body').buffer,
      headers: { 'content-type': ['text/plain', 'charset=utf-8'] },
      status: 200,
      statusText: 'OK',
    })

    const { clearWebFetchCache, getURLMarkdownContent } = await import(
      '../utils'
    )
    clearWebFetchCache()

    const result = await getURLMarkdownContent(
      'https://example.com/plain.txt',
      new AbortController(),
    )

    expect('type' in result).toBe(false)
    if ('type' in result) {
      throw new Error('unexpected redirect result')
    }
    expect(result.content).toBe('plain body')
    expect(result.contentType).toBe('text/plain, charset=utf-8')
  })
})

describe('Tavily response limits', () => {
  test('configures Axios to cap the decompressed response body', async () => {
    let capturedConfig: Record<string, unknown> | undefined
    postMock = async (_url, _data, config) => {
      capturedConfig = config
      return {
        data: { raw_content: 'bounded' },
        headers: {},
        status: 200,
        statusText: 'OK',
      }
    }
    const { clearWebFetchCache, fetchContentWithTavily } = await import(
      '../utils'
    )
    clearWebFetchCache()

    await fetchContentWithTavily(
      'https://example.com/tavily-limit',
      new AbortController(),
    )

    expect(capturedConfig?.maxContentLength).toBe(10 * 1024 * 1024)
    expect(capturedConfig?.decompress).toBe(true)
  })

  test('rejects oversized raw_content with response_too_large and does not cache it', async () => {
    let calls = 0
    postMock = async () => {
      calls++
      return {
        data: {
          raw_content: calls === 1 ? 'x'.repeat(10 * 1024 * 1024 + 1) : 'small',
        },
        headers: {},
        status: 200,
        statusText: 'OK',
      }
    }
    const { clearWebFetchCache, fetchContentWithTavily } = await import(
      '../utils'
    )
    clearWebFetchCache()
    const url = 'https://example.com/tavily-oversized'

    await expect(
      fetchContentWithTavily(url, new AbortController()),
    ).rejects.toThrow(/response_too_large/)
    const retry = await fetchContentWithTavily(url, new AbortController())

    expect(calls).toBe(2)
    expect('type' in retry).toBe(false)
    if (!('type' in retry)) expect(retry.content).toBe('small')
  })

  test('normalizes Axios maxContentLength failures to response_too_large', async () => {
    postMock = async () => {
      const error = new Error(
        'maxContentLength size of 10485760 exceeded',
      ) as MockAxiosError
      error.isAxiosError = true
      error.code = 'ERR_BAD_RESPONSE'
      throw error
    }
    const { clearWebFetchCache, fetchContentWithTavily } = await import(
      '../utils'
    )
    clearWebFetchCache()

    await expect(
      fetchContentWithTavily(
        'https://example.com/tavily-axios-limit',
        new AbortController(),
      ),
    ).rejects.toThrow(/response_too_large/)
  })
})
