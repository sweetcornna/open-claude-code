import {
  type McpServerFactory,
  Server as ModernServer,
  type Tool as ModernTool,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import type { MCPServerConnection } from '../types.js'
import { createMcpClient } from '../clientFactory.js'
import {
  createLinkedTransportPair,
  type DualEraTransport,
} from '../InProcessTransport.js'
import { outputSchemaViolation } from '../outputSchemaDegradation.js'

// `client.ts` logs through `utils/log.ts`, whose module-level bootstrap side
// effects (realpathSync / randomUUID) do not belong in a protocol test.
mock.module('src/utils/telemetry/log.ts', logMock)

// Imported after the mock is installed: a static import is hoisted above it
// and would bind the real logger.
const { fetchToolsForClient } = await import('../client.js')

// `mcpClientIdentity()` reads `MACRO.VERSION` when a client is constructed.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

/** In-memory hops; the budget only exists so a hang fails loudly. */
const ROUND_TRIP_TIMEOUT_MS = 15_000

/** The schema every fixture tool below advertises. */
const REPORT_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string' } },
  required: ['status'],
} as const

/**
 * Three tools that all ADVERTISE `REPORT_SCHEMA` and disagree with it in
 * different ways — the disagreements the SDK's validator distinguishes.
 */
const SCHEMA_TOOLS = [
  {
    name: 'text-only',
    description: 'Declares an output schema and answers with plain text.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: REPORT_SCHEMA,
  },
  {
    name: 'conformant',
    description: 'Declares an output schema and honours it.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: REPORT_SCHEMA,
  },
  {
    name: 'mismatched',
    description: 'Declares an output schema and returns something else.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: REPORT_SCHEMA,
  },
] satisfies ModernTool[]

/** Teardown for whatever a test opened, run even when an assertion throws. */
let cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  const pending = cleanups
  cleanups = []
  for (const cleanup of pending.reverse()) {
    await cleanup().catch(() => {})
  }
})

/**
 * A misbehaving-server fixture: every tool advertises `outputSchema`, and only
 * `conformant` actually satisfies it.
 */
const schemaFactory: McpServerFactory = () => {
  const server = new ModernServer(
    { name: 'schema-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler('tools/list', async () => ({ tools: SCHEMA_TOOLS }))

  server.setRequestHandler('tools/call', async request => {
    switch (request.params.name) {
      case 'text-only':
        // The common real-world bug: schema advertised, never honoured.
        return { content: [{ type: 'text', text: 'status: ok' }] }
      case 'conformant':
        return {
          content: [{ type: 'text', text: 'status: ok' }],
          structuredContent: { status: 'ok' },
        }
      case 'mismatched':
        // `status` is required and must be a string.
        return {
          content: [{ type: 'text', text: 'status: ok' }],
          structuredContent: { status: 42 },
        }
      default:
        return {
          isError: true,
          content: [
            { type: 'text', text: `unknown tool ${request.params.name}` },
          ],
        }
    }
  })

  return server
}

function startSchemaServer(): DualEraTransport {
  const [clientSide, serverSide] = createLinkedTransportPair()
  const handle = serveStdio(schemaFactory, { transport: serverSide })
  cleanups.push(() => handle.close())
  return clientSide
}

/**
 * A connected client of the shipped construction — `MCP_2026` is compiled out
 * under `bun test`, so this is the legacy era. Output-schema enforcement is
 * era-independent (it is driven by the client's own response cache), which is
 * exactly why arming it moves the DEFAULT build and not just the flagged one.
 */
async function connectedClient(): Promise<ReturnType<typeof createMcpClient>> {
  const client = createMcpClient({ capabilities: { roots: {} } })
  cleanups.push(() => client.close())
  await client.connect(startSchemaServer())
  expect(client.getProtocolEra()).toBe('legacy')
  return client
}

/** Text of the first content block. */
function firstText(result: { content?: unknown }): string | undefined {
  const blocks = result.content as { type: string; text?: string }[] | undefined
  return blocks?.[0]?.text
}

describe('outputSchema enforcement arming', () => {
  test(
    'stays inert while discovery uses the raw tools/list request',
    async () => {
      // The control, and the pre-change behaviour: `request()` does not write
      // the response cache the validator is compiled from, so a server that
      // ignores its own schema sails through unnoticed. If this test ever
      // starts throwing, the SDK began arming validation from somewhere else
      // and the degradation net below is carrying real traffic.
      const client = await connectedClient()
      await client.request({ method: 'tools/list' })

      const called = await client.callTool({ name: 'text-only' })

      expect(called.isError).toBeFalsy()
      expect(called.structuredContent).toBeUndefined()
      expect(firstText(called)).toBe('status: ok')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'arms once discovery uses the aggregating listTools',
    async () => {
      // The change: same server, same call, different discovery helper.
      const client = await connectedClient()
      const listed = await client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual([
        'text-only',
        'conformant',
        'mismatched',
      ])

      await expect(client.callTool({ name: 'text-only' })).rejects.toThrow()
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'is armed by occs own tool discovery',
    async () => {
      // The assertion the whole commit rests on. The two tests above pin the
      // SDK's behaviour and would keep passing if `fetchToolsForClient` were
      // reverted to `request()`; this one runs the REAL discovery function and
      // then checks the validator it is supposed to have compiled. Revert that
      // one line and this is the test that goes red.
      const client = await connectedClient()
      const connection: MCPServerConnection = {
        type: 'connected',
        // The discovery cache is keyed by server name, so this must not
        // collide with any other test's fixture.
        name: 'output-schema-arming-fixture',
        capabilities: client.getServerCapabilities() ?? {},
        client,
        config: { type: 'stdio', command: 'noop', scope: 'dynamic' },
      } as MCPServerConnection

      const tools = await fetchToolsForClient(connection)
      expect(tools.map(tool => tool.name)).toContain(
        'mcp__output-schema-arming-fixture__text-only',
      )

      const error = await client.callTool({ name: 'text-only' }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(outputSchemaViolation(error)).toBe('missing_structured_content')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )
})

describe('outputSchemaViolation classification', () => {
  test(
    'classifies a text-only answer as missing_structured_content',
    async () => {
      const client = await connectedClient()
      await client.listTools()

      const error = await client.callTool({ name: 'text-only' }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

      // Unclassified would mean the turn dies on a cosmetic server bug: the
      // generic handler rethrows anything this function does not recognise.
      expect(outputSchemaViolation(error)).toBe('missing_structured_content')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'classifies non-conformant structured content as schema_mismatch',
    async () => {
      const client = await connectedClient()
      await client.listTools()

      const error = await client.callTool({ name: 'mismatched' }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

      expect(outputSchemaViolation(error)).toBe('schema_mismatch')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test('ignores errors that are not schema violations', () => {
    expect(
      outputSchemaViolation(new Error('connection closed')),
    ).toBeUndefined()
    expect(outputSchemaViolation(undefined)).toBeUndefined()
  })
})

describe('schema-conformant servers', () => {
  test(
    'passes structuredContent through untouched with validation armed',
    async () => {
      // The other half of the bargain: arming validation must not cost a
      // well-behaved server anything.
      const client = await connectedClient()
      await client.listTools()

      const called = await client.callTool({ name: 'conformant' })

      expect(called.isError).toBeFalsy()
      expect(called.structuredContent).toEqual({ status: 'ok' })
      expect(firstText(called)).toBe('status: ok')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )
})
