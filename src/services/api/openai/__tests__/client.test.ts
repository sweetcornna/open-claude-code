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

    expect(noRetries).not.toBe(twoRetries)
    expect(twoRetriesAgain).toBe(twoRetries)
    expect(noRetries.maxRetries).toBe(0)
    expect(twoRetries.maxRetries).toBe(2)
  })
})
