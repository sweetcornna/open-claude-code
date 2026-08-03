import { afterEach, describe, expect, test } from 'bun:test'
import {
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from '../mcpValidation.js'

const savedMaxMcpOutputTokens = process.env.MAX_MCP_OUTPUT_TOKENS

afterEach(() => {
  if (savedMaxMcpOutputTokens === undefined) {
    delete process.env.MAX_MCP_OUTPUT_TOKENS
  } else {
    process.env.MAX_MCP_OUTPUT_TOKENS = savedMaxMcpOutputTokens
  }
})

describe('MCP token-count failure fallback', () => {
  test.each([
    ['throws', async () => Promise.reject(new Error('count unavailable'))],
    ['returns null', async () => null],
  ])('conservatively truncates oversized content when token counting %s', async (_name, countTokens) => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '10'
    const content = 'x'.repeat(30)

    expect(await mcpContentNeedsTruncation(content, countTokens)).toBe(true)

    const truncated = await truncateMcpContentIfNeeded(content, countTokens)
    expect(typeof truncated).toBe('string')
    expect(truncated).not.toContain(content)
    expect(truncated).toStartWith('x'.repeat(10))
    expect(truncated).toContain('[OUTPUT TRUNCATED')
  })
})
