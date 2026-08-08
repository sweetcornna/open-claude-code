import { afterEach, describe, expect, test } from 'bun:test'
import { clearOpenAIClientCache, getOpenAIClient } from '../client.js'

const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
}

afterEach(() => {
  clearOpenAIClientCache()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getOpenAIClient cache', () => {
  test('includes maxRetries in the cache key', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

    const noRetries = getOpenAIClient({ maxRetries: 0 })
    const twoRetries = getOpenAIClient({ maxRetries: 2 })
    const twoRetriesAgain = getOpenAIClient({ maxRetries: 2 })
    const clampedRetries = getOpenAIClient({ maxRetries: 999 })

    expect(noRetries).not.toBe(twoRetries)
    expect(twoRetriesAgain).toBe(twoRetries)
    expect(noRetries.maxRetries).toBe(0)
    expect(twoRetries.maxRetries).toBe(2)
    expect(clampedRetries.maxRetries).toBe(10)
  })

  test('splits resource URLs and query params before SDK requests', async () => {
    const seen: string[] = []
    const client = getOpenAIClient({
      apiKeyOverride: 'sk-test',
      baseURLOverride:
        'https://gateway.example/Tenant/v1/chat/completions?api-version=AbC#wrong',
      fetchOverride: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    await client.models.list()
    expect(client.baseURL).toBe('https://gateway.example/Tenant/v1')
    expect(seen).toEqual([
      'https://gateway.example/Tenant/v1/models?api-version=AbC',
    ])
  })
})
