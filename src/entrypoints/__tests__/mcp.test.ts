import { Client as ModernClient } from '@modelcontextprotocol/client'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createLinkedTransportPair } from '../../services/mcp/InProcessTransport.js'
import { createMcpServerFactory } from '../mcp.js'

// `createMcpServerFactory` reads `MACRO.VERSION` when the factory runs, so the
// define only has to exist before the first connection is served.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

// Building the tool list resolves the main-loop model and renders 31 tool
// prompts on the first call, so the round trips run well past the 5s default.
const ROUND_TRIP_TIMEOUT_MS = 60_000

/**
 * Serve-mode round trip.
 *
 * The dual-era decision lives in `serveStdio`, not in the `Server` object, so
 * driving a `Server` directly over an in-memory pair would not exercise it at
 * all. Instead these tests hand `serveStdio` its documented bring-your-own
 * `transport` option and connect a real SDK client to the other end of a
 * linked pair. That covers the actual entry — opening exchange, era pinning,
 * handler dispatch — without paying for a subprocess spawn, whose cold CLI
 * boot would dominate the runtime and add a process-lifecycle flake surface.
 */
describe('createMcpServerFactory', () => {
  const factory = createMcpServerFactory(false, false)
  /** Sorted tool names as each era saw them, compared for parity below. */
  const toolNamesByEra: Record<string, string[]> = {}
  let priorApiKey: string | undefined

  beforeAll(() => {
    priorApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  })

  afterAll(() => {
    if (priorApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = priorApiKey
    }
  })

  test(
    'serves a 2025-era client over the v1 SDK handshake',
    async () => {
      const [clientSide, serverSide] = createLinkedTransportPair()
      const handle = serveStdio(factory, {
        transport: serverSide,
      })
      const client = new LegacyClient(
        { name: 'legacy-test-client', version: '1.0.0' },
        { capabilities: {} },
      )

      try {
        await client.connect(clientSide)

        const listed = await client.listTools()
        expect(listed.tools.length).toBeGreaterThan(0)
        expect(listed.tools.map(tool => tool.name)).toContain('Glob')
        toolNamesByEra.legacy = listed.tools.map(tool => tool.name).sort()

        const called = await client.callTool({
          name: 'Glob',
          arguments: { pattern: 'package.json' },
        })
        expect(called.isError).toBeFalsy()
        const content = called.content as { type: string; text: string }[]
        expect(content[0]?.type).toBe('text')
        expect(content[0]?.text).toContain('package.json')
      } finally {
        await client.close()
        await handle.close()
      }
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'serves a 2026-07-28 stateless client',
    async () => {
      const [clientSide, serverSide] = createLinkedTransportPair()
      const handle = serveStdio(factory, {
        transport: serverSide,
      })
      const client = new ModernClient(
        { name: 'modern-test-client', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )

      try {
        await client.connect(clientSide)
        // Pinning would have failed negotiation against a 2025-only server;
        // assert the era the handshake actually settled on.
        expect(client.getProtocolEra()).toBe('modern')

        const listed = await client.listTools()
        expect(listed.tools.length).toBeGreaterThan(0)
        expect(listed.tools.map(tool => tool.name)).toContain('Glob')
        toolNamesByEra.modern = listed.tools.map(tool => tool.name).sort()

        const called = await client.callTool({
          name: 'Glob',
          arguments: { pattern: 'package.json' },
        })
        expect(called.isError).toBeFalsy()
        const content = called.content as { type: string; text: string }[]
        expect(content[0]?.type).toBe('text')
        expect(content[0]?.text).toContain('package.json')
      } finally {
        await client.close()
        await handle.close()
      }
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test('exposes the same tool set to both eras', () => {
    expect(toolNamesByEra.legacy).toBeDefined()
    expect(toolNamesByEra.modern).toEqual(toolNamesByEra.legacy as string[])
  })
})
