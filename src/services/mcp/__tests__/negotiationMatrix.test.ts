import {
  isInputRequiredResult,
  specTypeSchemas,
  withInputRequired,
} from '@modelcontextprotocol/client'
import {
  acceptedContent,
  inputRequired,
  type McpServerFactory,
  Server as ModernServer,
  type Tool as ModernTool,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  createLinkedTransportPair,
  type DualEraTransport,
} from '../InProcessTransport.js'
import {
  createMcpClient,
  MCP_MODERN_PROTOCOL_VERSION,
} from '../clientFactory.js'

// `mcpClientIdentity()` reads `MACRO.VERSION` when a client is constructed.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

/**
 * Fixture servers are a handful of in-memory message hops, so these finish in
 * milliseconds — the budget only exists so a negotiation bug hangs the test
 * instead of the whole run.
 */
const ROUND_TRIP_TIMEOUT_MS = 15_000

/**
 * Every protocol revision a 2025-era `initialize` handshake can settle on.
 *
 * `2026-07-28` is deliberately NOT here: it is absent from both SDKs'
 * `SUPPORTED_PROTOCOL_VERSIONS` and reachable only through `server/discover`,
 * which is exactly the property the modern-era block below asserts.
 */
const LEGACY_ERAS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
] as const

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echoes its argument back as text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
} satisfies ModernTool

/** A tool that demands one round of client input before it will do anything. */
const CONFIRM_TOOL = {
  name: 'confirm-deploy',
  description: 'Deploys, but only after the client confirms.',
  inputSchema: {
    type: 'object',
    properties: { env: { type: 'string' } },
    required: ['env'],
  },
} satisfies ModernTool

/** Opaque server state the MRTR round trip must echo back verbatim. */
const MRTR_REQUEST_STATE = 'deploy-round-1'

/** Teardown for whatever a test opened, run even when an assertion throws. */
let cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  const pending = cleanups
  cleanups = []
  for (const cleanup of pending.reverse()) {
    await cleanup().catch(() => {})
  }
})

function echoText(args: unknown): string {
  const text = (args as { text?: unknown } | undefined)?.text
  return `echo:${String(text)}`
}

/**
 * Rewrites the `protocolVersion` of the `initialize` RESULT this transport
 * sends, pinning the peer to `era`.
 *
 * The v1 `Server` answers `initialize` by ECHOING whichever version the client
 * asked for (when it supports it), so a stock v1 server would always land on
 * the migrated client's own preference and the matrix would test one era four
 * times. Rewriting the response — rather than the client's request — is the
 * faithful direction: it models a server that only speaks `era`, and leaves
 * every other byte of the v1 server's real behaviour intact.
 */
function pinInitializeEra(transport: DualEraTransport, era: string): void {
  const send = transport.send.bind(transport)
  transport.send = async (message, options) => {
    const result = (message as { result?: { protocolVersion?: unknown } })
      .result
    if (result && typeof result.protocolVersion === 'string') {
      return send(
        { ...message, result: { ...result, protocolVersion: era } },
        options,
      )
    }
    return send(message, options)
  }
}

/**
 * A v1-SDK server pinned to `era`, wired to a fresh linked transport pair.
 * Returns the client end for the migrated client to connect to.
 */
function startLegacyEraServer(era: string): DualEraTransport {
  const [clientSide, serverSide] = createLinkedTransportPair()
  pinInitializeEra(serverSide, era)

  const server = new LegacyServer(
    { name: `legacy-${era}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [ECHO_TOOL],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{ type: 'text', text: echoText(request.params.arguments) }],
  }))

  const connected = server.connect(serverSide)
  cleanups.push(async () => {
    await connected
    await server.close()
  })
  return clientSide
}

/**
 * The dual-era serve fixture.
 *
 * `serveStdio` — not the `Server` object — owns the era decision, so driving a
 * `Server` directly over a linked pair would never exercise `server/discover`
 * at all. The registered handlers are era-agnostic: the SAME factory answers
 * a 2025 `initialize` handshake and a 2026-07-28 stateless client, which is
 * what lets the assertions below attribute any difference to negotiation
 * rather than to two different servers.
 *
 * A local factory rather than occ's own `createMcpServerFactory`: this file is
 * about negotiation, and occ's real tool inventory is already covered in both
 * eras by `src/entrypoints/__tests__/mcp.test.ts`. A local one also lets the
 * server hand back an `input_required` result, which occ's tools never do.
 */
const dualEraFactory: McpServerFactory = () => {
  const server = new ModernServer(
    { name: 'matrix-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler('tools/list', async () => ({
    tools: [ECHO_TOOL, CONFIRM_TOOL],
  }))

  server.setRequestHandler('tools/call', async (request, ctx) => {
    if (request.params.name === 'echo') {
      return {
        content: [{ type: 'text', text: echoText(request.params.arguments) }],
      }
    }
    if (request.params.name === 'confirm-deploy') {
      const answer = acceptedContent<{ confirm: boolean }>(
        ctx.mcpReq.inputResponses,
        'confirm',
      )
      if (!answer?.confirm) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: 'Deploy to prod?',
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm'],
              },
            }),
          },
          requestState: MRTR_REQUEST_STATE,
        })
      }
      // `requestState` is an ACCESSOR, not a field: calling it runs the
      // configured `requestState.verify` hook and yields the decoded payload
      // (here, with no hook, the raw wire string). Reading it as a property
      // silently hands back the function itself.
      return {
        content: [
          {
            type: 'text',
            text: `deployed:${String(ctx.mcpReq.requestState<string>())}`,
          },
        ],
      }
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool ${request.params.name}` }],
    }
  })

  return server
}

/** Serves the dual-era fixture and returns the client end of the pair. */
function startDualEraServer(): DualEraTransport {
  const [clientSide, serverSide] = createLinkedTransportPair()
  const handle = serveStdio(dualEraFactory, { transport: serverSide })
  cleanups.push(() => handle.close())
  return clientSide
}

/** Text of the first content block, for the round-trip assertions. */
function firstText(result: { content?: unknown }): string | undefined {
  const blocks = result.content as { type: string; text?: string }[] | undefined
  return blocks?.[0]?.text
}

describe('createMcpClient legacy-era negotiation', () => {
  for (const era of LEGACY_ERAS) {
    test(
      `connects, lists and calls against a ${era} server`,
      async () => {
        const transport = startLegacyEraServer(era)
        const client = createMcpClient({ capabilities: { roots: {} } })
        cleanups.push(() => client.close())

        await client.connect(transport)

        // The flag-off build must land on the plain 2025 handshake for every
        // revision a real server might answer with.
        expect(client.getProtocolEra()).toBe('legacy')
        expect(client.getNegotiatedProtocolVersion()).toBe(era)

        const listed = await client.request({ method: 'tools/list' })
        expect(listed.tools.map(tool => tool.name)).toEqual(['echo'])

        const called = await client.callTool({
          name: 'echo',
          arguments: { text: era },
        })
        expect(called.isError).toBeFalsy()
        expect(firstText(called)).toBe(`echo:${era}`)
      },
      ROUND_TRIP_TIMEOUT_MS,
    )
  }

  test(
    'auto negotiation degrades to legacy against a 2025-only server',
    async () => {
      // The safety property `MCP_2026` rests on: turning the flag on probes
      // with `server/discover` first, and a server that has never heard of it
      // must still end up on an ordinary legacy connection rather than a
      // failed one.
      const transport = startLegacyEraServer('2025-06-18')
      const client = createMcpClient({
        capabilities: { roots: {} },
        versionNegotiation: { mode: 'auto' },
      })
      cleanups.push(() => client.close())

      await client.connect(transport)

      expect(client.getProtocolEra()).toBe('legacy')
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-06-18')

      const called = await client.callTool({
        name: 'echo',
        arguments: { text: 'fallback' },
      })
      expect(firstText(called)).toBe('echo:fallback')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'the default construction stays legacy against a dual-era server',
    async () => {
      // `MCP_2026` is compiled out under `bun test`, so this is the shipped
      // build: even a server that WOULD speak 2026-07-28 gets the 2025
      // handshake, because the client never probes for anything else.
      const client = createMcpClient({ capabilities: { roots: {} } })
      cleanups.push(() => client.close())

      await client.connect(startDualEraServer())

      expect(client.getProtocolEra()).toBe('legacy')
      expect(client.getNegotiatedProtocolVersion()).not.toBe(
        MCP_MODERN_PROTOCOL_VERSION,
      )

      const listed = await client.request({ method: 'tools/list' })
      expect(listed.tools.map(tool => tool.name)).toContain('echo')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )
})

describe('createMcpClient modern-era negotiation', () => {
  test(
    'reaches 2026-07-28 via server/discover when pinned',
    async () => {
      const client = createMcpClient({
        capabilities: { roots: {} },
        versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
      })
      cleanups.push(() => client.close())

      await client.connect(startDualEraServer())

      expect(client.getProtocolEra()).toBe('modern')
      expect(client.getNegotiatedProtocolVersion()).toBe(
        MCP_MODERN_PROTOCOL_VERSION,
      )

      const listed = await client.request({ method: 'tools/list' })
      expect(listed.tools.map(tool => tool.name)).toEqual([
        'echo',
        'confirm-deploy',
      ])

      const called = await client.callTool({
        name: 'echo',
        arguments: { text: 'modern' },
      })
      expect(called.isError).toBeFalsy()
      expect(firstText(called)).toBe('echo:modern')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'auto negotiation prefers 2026-07-28 when the server offers it',
    async () => {
      // This is precisely the construction `feature('MCP_2026')` selects, so
      // this is the flag-on build's behaviour without the compile-time flag.
      const client = createMcpClient({
        capabilities: { roots: {} },
        versionNegotiation: { mode: 'auto' },
      })
      cleanups.push(() => client.close())

      await client.connect(startDualEraServer())

      expect(client.getProtocolEra()).toBe('modern')
      expect(client.getNegotiatedProtocolVersion()).toBe(
        MCP_MODERN_PROTOCOL_VERSION,
      )

      const called = await client.callTool({
        name: 'echo',
        arguments: { text: 'auto' },
      })
      expect(firstText(called)).toBe('echo:auto')
    },
    ROUND_TRIP_TIMEOUT_MS,
  )
})

describe('modern-era multi-round-trip results', () => {
  test(
    'auto-fulfils an input_required result through the elicitation handler',
    async () => {
      // The payoff of keeping elicitation on `setRequestHandler`: on the
      // modern era the server no longer SENDS `elicitation/create`, it embeds
      // it in an `input_required` result — and the SDK's driver fulfils it
      // through the very same registered handler, then retries. Whatever the
      // next stage builds for MRTR UX inherits this handler, not a new one.
      const client = createMcpClient({
        capabilities: { roots: {}, elicitation: {} },
        versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
      })
      cleanups.push(() => client.close())

      await client.connect(startDualEraServer())
      expect(client.getProtocolEra()).toBe('modern')

      let elicited = 0
      client.setRequestHandler('elicitation/create', async () => {
        elicited += 1
        return { action: 'accept' as const, content: { confirm: true } }
      })

      const called = await client.callTool({
        name: 'confirm-deploy',
        arguments: { env: 'prod' },
      })

      expect(elicited).toBe(1)
      expect(called.isError).toBeFalsy()
      // The opaque `requestState` came back to the server byte-for-byte.
      expect(firstText(called)).toBe(`deployed:${MRTR_REQUEST_STATE}`)
    },
    ROUND_TRIP_TIMEOUT_MS,
  )

  test(
    'hands the input_required result back when the call opts into manual mode',
    async () => {
      const client = createMcpClient({
        capabilities: { roots: {}, elicitation: {} },
        versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
      })
      cleanups.push(() => client.close())

      await client.connect(startDualEraServer())

      // `allowInputRequired` overrides auto-fulfilment for this call only;
      // `withInputRequired` is what types both outcomes on the explicit-schema
      // path (the method-keyed overload only knows the complete result).
      const pending = await client.request(
        {
          method: 'tools/call',
          params: { name: 'confirm-deploy', arguments: { env: 'prod' } },
        },
        withInputRequired(specTypeSchemas.CallToolResult),
        { allowInputRequired: true },
      )

      expect(isInputRequiredResult(pending)).toBe(true)
      if (!isInputRequiredResult(pending)) {
        throw new Error('expected an input_required result')
      }
      expect(pending.resultType).toBe('input_required')
      expect(Object.keys(pending.inputRequests ?? {})).toEqual(['confirm'])
      expect(pending.requestState).toBe(MRTR_REQUEST_STATE)

      // Retrying by hand — a fresh request carrying the gathered responses and
      // the echoed state — is the shape the MRTR UX will drive next stage.
      const resumed = await client.request({
        method: 'tools/call',
        params: {
          name: 'confirm-deploy',
          arguments: { env: 'prod' },
          inputResponses: {
            confirm: { action: 'accept', content: { confirm: true } },
          },
          requestState: pending.requestState,
        },
      })

      expect(resumed.isError).toBeFalsy()
      expect(firstText(resumed)).toBe(`deployed:${MRTR_REQUEST_STATE}`)
    },
    ROUND_TRIP_TIMEOUT_MS,
  )
})
