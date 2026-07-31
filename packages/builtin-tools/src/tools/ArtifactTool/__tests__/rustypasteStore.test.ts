import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rustypasteStore } from '../rustypasteStore.js'

const originalFetch = globalThis.fetch
const originalUrl = process.env.OCC_ARTIFACTS_URL
const originalToken = process.env.OCC_ARTIFACTS_TOKEN

function mockFetch(body: string, status = 200): typeof fetch {
  return mock(() =>
    Promise.resolve(new Response(body, { status })),
  ) as unknown as typeof fetch
}

function restoreEnv(
  name: 'OCC_ARTIFACTS_URL' | 'OCC_ARTIFACTS_TOKEN',
  value?: string,
) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('rustypasteStore', () => {
  beforeEach(() => {
    process.env.OCC_ARTIFACTS_URL = 'https://paste.example.test'
    process.env.OCC_ARTIFACTS_TOKEN = 'raw-test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv('OCC_ARTIFACTS_URL', originalUrl)
    restoreEnv('OCC_ARTIFACTS_TOKEN', originalToken)
  })

  test('uploads HTML and maps the response URL to the store result', async () => {
    const fetchMock = mockFetch('https://paste.example.test/safe-toad.html\n')
    globalThis.fetch = fetchMock

    const result = await rustypasteStore.upload({
      html: '<h1>hello</h1>',
      ttlDays: 7,
    })

    expect(result).toEqual({
      id: 'safe-toad.html',
      url: 'https://paste.example.test/safe-toad.html',
      expiresAt: undefined,
    })

    const calls = (
      fetchMock as unknown as {
        mock: { calls: [string | URL | Request, RequestInit | undefined][] }
      }
    ).mock.calls
    expect(calls[0][0]).toBe('https://paste.example.test')
    expect(calls[0][1]?.method).toBe('POST')
    expect(calls[0][1]?.headers).toEqual({
      Authorization: 'raw-test-token',
      expire: '7d',
    })

    const form = calls[0][1]?.body as FormData
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name.endsWith('.html')).toBe(true)
    expect(await (file as File).text()).toBe('<h1>hello</h1>')
  })

  test.each([
    [7, '7d'],
    [30, '30d'],
  ] as const)('maps a %i-day TTL to expire: %s', async (ttlDays, expire) => {
    const fetchMock = mockFetch('https://paste.example.test/paste.html')
    globalThis.fetch = fetchMock

    await rustypasteStore.upload({ html: '<p>x</p>', ttlDays })

    const init = (
      fetchMock as unknown as {
        mock: { calls: [string | URL | Request, RequestInit | undefined][] }
      }
    ).mock.calls[0][1]
    expect(init?.headers).toMatchObject({ expire })
  })

  test('rejects custom hashes without making a request', async () => {
    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve(new Response(''))
    }) as unknown as typeof fetch

    await expect(
      rustypasteStore.upload({
        html: '<p>x</p>',
        hash: 'stable-id',
        ttlDays: 7,
      }),
    ).rejects.toThrow(/not supported by the rustypaste backend/)
    expect(fetchCalled).toBe(false)
  })

  test('includes the HTTP status and response body in upload errors', async () => {
    globalThis.fetch = mockFetch('unauthorized', 401)

    await expect(
      rustypasteStore.upload({ html: '<p>x</p>', ttlDays: 7 }),
    ).rejects.toThrow('HTTP 401: unauthorized')
  })
})
