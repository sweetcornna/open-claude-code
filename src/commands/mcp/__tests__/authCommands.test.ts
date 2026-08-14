import { describe, expect, test } from 'bun:test'
import type { McpServerConfig } from '../../../services/mcp/types.js'
import {
  classifyMcpAuthTarget,
  describeUnsupportedTarget,
} from '../authCommands.js'

/**
 * The classifier is the whole reason `mcp login` doesn't just call
 * `performMCPOAuthFlow`: three of the four server kinds occ supports cannot
 * hold a per-server OAuth grant, and each needs a different explanation.
 */
describe('classifyMcpAuthTarget', () => {
  test('http and sse servers are the OAuth-capable ones', () => {
    for (const type of ['http', 'sse'] as const) {
      const config = { type, url: 'https://example.com/mcp' } as McpServerConfig
      const target = classifyMcpAuthTarget(config)
      expect(target.kind).toBe('oauth')
      // The config is passed through untouched — performMCPOAuthFlow needs the
      // caller's object, not a copy.
      if (target.kind === 'oauth') {
        expect(target.config === (config as unknown)).toBe(true)
      }
    }
  })

  test('claude.ai connectors are called out separately', () => {
    const target = classifyMcpAuthTarget({
      type: 'claudeai-proxy',
    } as unknown as McpServerConfig)
    expect(target.kind).toBe('claudeai-proxy')
  })

  test('stdio servers have no OAuth at all', () => {
    const target = classifyMcpAuthTarget({
      type: 'stdio',
      command: 'my-server',
    } as McpServerConfig)
    expect(target).toEqual({ kind: 'unsupported-transport', type: 'stdio' })
  })

  test('a config with no explicit type is treated as stdio', () => {
    const target = classifyMcpAuthTarget({
      command: 'my-server',
    } as unknown as McpServerConfig)
    expect(target).toEqual({ kind: 'unsupported-transport', type: 'stdio' })
  })
})

describe('describeUnsupportedTarget', () => {
  test('points connector users at the account login, not at mcp login', () => {
    const message = describeUnsupportedTarget('notion', {
      kind: 'claudeai-proxy',
    })
    expect(message).toContain('claude.ai connector')
    expect(message).toContain('/login')
  })

  test('names the transport that cannot do OAuth', () => {
    const message = describeUnsupportedTarget('local-fs', {
      kind: 'unsupported-transport',
      type: 'stdio',
    })
    expect(message).toContain('"stdio"')
    expect(message).toContain('http and sse')
  })
})
