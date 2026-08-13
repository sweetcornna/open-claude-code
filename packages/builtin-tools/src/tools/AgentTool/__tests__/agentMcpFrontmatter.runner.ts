import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

const debugMessages: string[] = []

mock.module('bun:bundle', () => ({ feature: (_name: string) => true }))
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', () => ({
  ...debugMock(),
  logForDebugging: (message: string) => {
    debugMessages.push(message)
  },
}))

const { parseAgentFromJson, parseAgentFromMarkdown } = await import(
  '../loadAgentsDir.js'
)
const { parseFrontmatter } = await import('src/utils/text/frontmatterParser.js')

function parseAgentMarkdown(markdown: string) {
  const { frontmatter, content } = parseFrontmatter(markdown)
  return parseAgentFromMarkdown(
    '/tmp/safe-boundary.md',
    '/tmp',
    frontmatter,
    content,
    'userSettings',
  )
}

describe('agent MCP frontmatter security boundary', () => {
  test('JSON rejects reserved names, internal transports, and malformed internal configs', () => {
    const secret = 'malformed-json-secret'
    const agent = parseAgentFromJson('json-boundary', {
      description: 'Security boundary fixture',
      prompt: 'Prompt',
      mcpServers: [
        {
          'computer-use': {
            type: 'stdio',
            command: 'run',
            args: ['reserved-secret'],
          },
        },
        {
          internal: {
            type: 'sse-ide',
            url: 'http://127.0.0.1',
            ideName: 'test-ide',
          },
        },
        {
          malformed: {
            type: 'ws-ide',
            url: 'ws://127.0.0.1',
            authToken: secret,
          },
        },
        {
          safe: { type: 'stdio', command: 'run' },
        },
      ],
    })

    expect(agent?.mcpServers).toEqual([
      { safe: { type: 'stdio', command: 'run', args: [] } },
    ])
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test('YAML rejects reserved names and internal transports without logging credentials', () => {
    const reservedSecret = 'reserved-frontmatter-secret'
    const ideSecret = 'ide-frontmatter-secret'
    const agent = parseAgentMarkdown(`---
name: safe-boundary
description: Security boundary fixture
mcpServers:
  - computer-use:
      type: stdio
      command: run
      args:
        - ${reservedSecret}
  - internal:
      type: ws-ide
      url: ws://127.0.0.1
      ideName: test-ide
      authToken: ${ideSecret}
  - safe-http:
      type: http
      url: https://example.test/mcp
      headers:
        Authorization: safe-secret
---
Prompt
`)

    expect(agent?.mcpServers).toEqual([
      {
        'safe-http': {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'safe-secret' },
        },
      },
    ])
    expect(debugMessages).toContain(
      "[Agent: safe-boundary] Skipping reserved MCP server name 'computer-use' in frontmatter",
    )
    expect(debugMessages).toContain(
      "[Agent: safe-boundary] Skipping internal-only MCP transport 'ws-ide' for 'internal' in frontmatter",
    )
    expect(debugMessages.join('\n')).not.toContain(reservedSecret)
    expect(debugMessages.join('\n')).not.toContain(ideSecret)
  })

  test.each([
    '__proto__',
  ])('YAML rejects reserved object key %s', serverName => {
    debugMessages.length = 0
    const secret = `${serverName}-secret`
    const agent = parseAgentMarkdown(`---
name: object-key-boundary
description: Security boundary fixture
mcpServers:
  - ${serverName}:
      type: stdio
      command: run
      args:
        - ${secret}
  - safe:
      type: stdio
      command: run
---
Prompt
`)

    expect(agent?.mcpServers).toEqual([
      { safe: { type: 'stdio', command: 'run', args: [] } },
    ])
    expect(debugMessages).toContain(
      `[Agent: object-key-boundary] Skipping reserved MCP server name '${serverName}' in frontmatter`,
    )
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test.each([
    'sse-ide',
    'ws-ide',
    'sdk',
    'claudeai-proxy',
  ])('YAML rejects internal transport %s', transport => {
    debugMessages.length = 0
    const secret = `${transport}-secret`
    const config =
      transport === 'sdk'
        ? `type: sdk\n      name: ${secret}`
        : transport === 'claudeai-proxy'
          ? `type: claudeai-proxy\n      url: https://example.test/mcp\n      id: ${secret}`
          : `type: ${transport}\n      url: ws://127.0.0.1\n      ideName: test-ide\n      authToken: ${secret}`
    const agent = parseAgentMarkdown(`---
name: internal-boundary
description: Security boundary fixture
mcpServers:
  - internal:
      ${config}
  - safe:
      type: stdio
      command: run
---
Prompt
`)

    expect(agent?.mcpServers).toEqual([
      { safe: { type: 'stdio', command: 'run', args: [] } },
    ])
    expect(debugMessages).toContain(
      `[Agent: internal-boundary] Skipping internal-only MCP transport '${transport}' for 'internal' in frontmatter`,
    )
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test.each([
    ['stdio', 'command: run'],
    ['http', 'url: https://example.test/mcp'],
    ['sse', 'url: https://example.test/sse'],
    ['ws', 'url: wss://example.test/mcp'],
  ])('keeps YAML %s transport', (transport, field) => {
    const agent = parseAgentMarkdown(`---
name: ${transport}-agent
description: Valid transport fixture
mcpServers:
  - valid:
      type: ${transport}
      ${field}
---
Prompt
`)

    expect(agent?.mcpServers).toHaveLength(1)
    expect(agent?.mcpServers?.[0]).toMatchObject({
      valid: { type: transport },
    })
  })
})
