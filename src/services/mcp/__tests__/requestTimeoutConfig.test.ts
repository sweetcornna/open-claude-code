import { describe, expect, test } from 'bun:test'
import {
  McpHTTPServerConfigSchema,
  McpSSEServerConfigSchema,
  McpStdioServerConfigSchema,
  McpWebSocketServerConfigSchema,
} from '../types.js'

describe('per-server request_timeout_ms config', () => {
  test('accepted on all four user-configurable transports', () => {
    expect(
      McpStdioServerConfigSchema().parse({
        command: 'foo',
        request_timeout_ms: 5000,
      }).request_timeout_ms,
    ).toBe(5000)
    expect(
      McpSSEServerConfigSchema().parse({
        type: 'sse',
        url: 'https://x',
        request_timeout_ms: 5000,
      }).request_timeout_ms,
    ).toBe(5000)
    expect(
      McpHTTPServerConfigSchema().parse({
        type: 'http',
        url: 'https://x',
        request_timeout_ms: 5000,
      }).request_timeout_ms,
    ).toBe(5000)
    expect(
      McpWebSocketServerConfigSchema().parse({
        type: 'ws',
        url: 'wss://x',
        request_timeout_ms: 5000,
      }).request_timeout_ms,
    ).toBe(5000)
  })

  test('optional — absent stays undefined; invalid values rejected', () => {
    expect(
      McpStdioServerConfigSchema().parse({ command: 'foo' }).request_timeout_ms,
    ).toBeUndefined()
    expect(() =>
      McpStdioServerConfigSchema().parse({
        command: 'foo',
        request_timeout_ms: -1,
      }),
    ).toThrow()
    expect(() =>
      McpStdioServerConfigSchema().parse({
        command: 'foo',
        request_timeout_ms: 1.5,
      }),
    ).toThrow()
  })
})
