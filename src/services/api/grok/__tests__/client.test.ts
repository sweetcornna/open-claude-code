import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import { getGrokClient, clearGrokClientCache } from '../client.js'

describe('getGrokClient', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearGrokClientCache()
    process.env.GROK_API_KEY = 'test-key'
    delete process.env.GROK_BASE_URL
  })

  afterEach(() => {
    clearGrokClientCache()
    process.env = { ...originalEnv }
  })

  test('creates client with default base URL', () => {
    const client = getGrokClient()
    expect(client).toBeDefined()
    expect(client.baseURL).toBe('https://api.x.ai/v1')
  })

  test('uses GROK_BASE_URL when set', () => {
    process.env.GROK_BASE_URL = 'https://custom.grok.api/v1'
    clearGrokClientCache()
    const client = getGrokClient()
    expect(client.baseURL).toBe('https://custom.grok.api/v1')
  })

  test('canonicalizes resource URLs before SDK requests', async () => {
    process.env.GROK_BASE_URL =
      'https://custom.grok.api/Tenant/v1/models?tenant=AbC#wrong'
    const seen: string[] = []
    const client = getGrokClient({
      fetchOverride: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    await client.models.list()
    expect(client.baseURL).toBe('https://custom.grok.api/Tenant/v1')
    expect(seen).toEqual([
      'https://custom.grok.api/Tenant/v1/models?tenant=AbC',
    ])
  })

  test('clamps SDK retry options at ten', () => {
    expect(getGrokClient({ maxRetries: 999 }).maxRetries).toBe(10)
  })

  test('returns cached client on second call', () => {
    const client1 = getGrokClient()
    const client2 = getGrokClient()
    expect(client1).toBe(client2)
  })

  test('environment changes invalidate the keyed cache', () => {
    const client1 = getGrokClient()
    process.env.GROK_BASE_URL = 'https://other.api/v1'
    const client2 = getGrokClient()
    expect(client1).not.toBe(client2)
    expect(client2.baseURL).toBe('https://other.api/v1')
  })

  test('an injected fetch never reuses the shared client', async () => {
    getGrokClient()
    const seen: string[] = []
    const client = getGrokClient({
      fetchOverride: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    await client.models.list()
    expect(seen).toEqual(['https://api.x.ai/v1/models'])
  })
})
