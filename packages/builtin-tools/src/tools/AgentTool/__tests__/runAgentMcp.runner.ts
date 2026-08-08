/**
 * Covers the two subagent MCP wiring guarantees in runAgent.ts:
 *
 *  1. initializeAgentMcpServers isolates per-server failures. Since 2.35.0
 *     fetchToolsForClient THROWS instead of returning [], so a single flaky
 *     server used to abort the whole agent run — and leak the inline server
 *     processes started by earlier iterations, because the cleanup closure did
 *     not exist yet at that point.
 *  2. createAgentRefreshTools re-filters the parent's live tool pool through
 *     the agent's own filter chain, so a long-running subagent sees new MCP
 *     tools without ever being handed the unfiltered main-thread pool.
 *
 * Runs in its own process (see runAgentMcp.test.ts) because it replaces
 * src/services/mcp/* for the whole module registry.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('bun:bundle', () => ({ feature: (_name: string) => true }))
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

type FakeClient = {
  name: string
  type: 'connected' | 'failed'
  cleanupCalls: number
  cleanup: () => Promise<void>
}

function makeClient(name: string, type: 'connected' | 'failed'): FakeClient {
  const client: FakeClient = {
    name,
    type,
    cleanupCalls: 0,
    cleanup: async () => {
      client.cleanupCalls++
    },
  }
  return client
}

/** Per-server behaviour for the fake MCP module, keyed by server name. */
const connectBehaviour = new Map<
  string,
  { connect?: () => FakeClient; listTools?: () => unknown[] }
>()
const connectCalls: string[] = []
const clientsByName = new Map<string, FakeClient>()

// Complete surfaces: only the two entry points under test are replaced, every
// other export keeps delegating to the real module (other files in this
// process — and runAgent's own import graph — still need them).
const realMcpClient = await import('src/services/mcp/client.js')
const realMcpConfig = await import('src/services/mcp/config.js')

mock.module('src/services/mcp/client.ts', () => ({
  ...realMcpClient,
  connectToServer: async (name: string) => {
    connectCalls.push(name)
    const behaviour = connectBehaviour.get(name)
    const client = behaviour?.connect
      ? behaviour.connect()
      : makeClient(name, 'connected')
    clientsByName.set(name, client)
    return client
  },
  fetchToolsForClient: async (client: FakeClient) => {
    const behaviour = connectBehaviour.get(client.name)
    if (!behaviour?.listTools) return [{ name: `mcp__${client.name}__tool` }]
    return behaviour.listTools()
  },
}))

mock.module('src/services/mcp/config.ts', () => ({
  ...realMcpConfig,
  getMcpConfigByName: (name: string) =>
    name === 'known' ? { type: 'stdio', command: 'x', scope: 'user' } : null,
}))

const { initializeAgentMcpServers, createAgentRefreshTools } = await import(
  '../runAgent.js'
)
const { ASK_USER_QUESTION_TOOL_NAME } = await import(
  '../../AskUserQuestionTool/prompt.js'
)

type AgentDefinitionLike = Parameters<typeof initializeAgentMcpServers>[0]
type ParentClients = Parameters<typeof initializeAgentMcpServers>[1]

function inlineServer(name: string) {
  return { [name]: { type: 'stdio' as const, command: 'run', args: [] } }
}

function agentWithServers(servers: unknown[]): AgentDefinitionLike {
  return {
    agentType: 'tester',
    source: 'user',
    mcpServers: servers,
  } as unknown as AgentDefinitionLike
}

beforeEach(() => {
  connectBehaviour.clear()
  connectCalls.length = 0
  clientsByName.clear()
})

describe('initializeAgentMcpServers — per-server failure isolation', () => {
  test('a server whose listTools throws costs only its own tools', async () => {
    connectBehaviour.set('bad', {
      listTools: () => {
        throw new Error('listTools failed')
      },
    })

    const result = await initializeAgentMcpServers(
      agentWithServers([inlineServer('good'), inlineServer('bad')]),
      [] as unknown as ParentClients,
    )

    // The good server still contributes; the run is not aborted.
    expect(result.tools.map(t => t.name)).toEqual(['mcp__good__tool'])
    // Both servers were attempted — the failure did not short-circuit the loop.
    expect(connectCalls).toEqual(['good', 'bad'])
    expect(result.clients).toHaveLength(2)
  })

  test('the failed server is still cleaned up (no leaked inline process)', async () => {
    connectBehaviour.set('bad', {
      listTools: () => {
        throw new Error('listTools failed')
      },
    })

    const result = await initializeAgentMcpServers(
      agentWithServers([inlineServer('good'), inlineServer('bad')]),
      [] as unknown as ParentClients,
    )
    await result.cleanup()

    expect(clientsByName.get('good')?.cleanupCalls).toBe(1)
    expect(clientsByName.get('bad')?.cleanupCalls).toBe(1)
  })

  test('a server whose connect throws does not abort the others', async () => {
    connectBehaviour.set('bad', {
      connect: () => {
        throw new Error('spawn failed')
      },
    })

    const result = await initializeAgentMcpServers(
      agentWithServers([inlineServer('bad'), inlineServer('good')]),
      [] as unknown as ParentClients,
    )

    expect(result.tools.map(t => t.name)).toEqual(['mcp__good__tool'])
    expect(result.clients).toHaveLength(1)
  })

  test('unresolvable and malformed specs are skipped, not fatal', async () => {
    const result = await initializeAgentMcpServers(
      agentWithServers(['unknown-name', {}, 'known', inlineServer('inline')]),
      [] as unknown as ParentClients,
    )

    expect(result.tools.map(t => t.name)).toEqual([
      'mcp__known__tool',
      'mcp__inline__tool',
    ])
    // Referenced (shared) clients are not owned by the agent — only the
    // inline one is closed.
    await result.cleanup()
    expect(clientsByName.get('known')?.cleanupCalls).toBe(0)
    expect(clientsByName.get('inline')?.cleanupCalls).toBe(1)
  })

  test('parent clients are preserved ahead of agent clients', async () => {
    const parent = makeClient('parent', 'connected')
    const result = await initializeAgentMcpServers(
      agentWithServers([inlineServer('inline')]),
      [parent] as unknown as ParentClients,
    )
    expect(result.clients.map(c => c.name)).toEqual(['parent', 'inline'])
  })

  test('no frontmatter servers short-circuits to the parent clients', async () => {
    const parent = makeClient('parent', 'connected')
    const result = await initializeAgentMcpServers(agentWithServers([]), [
      parent,
    ] as unknown as ParentClients)
    expect(result.clients.map(c => c.name)).toEqual(['parent'])
    expect(result.tools).toEqual([])
    expect(connectCalls).toEqual([])
  })
})

type FakeTool = { name: string }
/** The tool pool type, without dragging the whole Tool interface into fixtures. */
type Pool = ReturnType<NonNullable<ReturnType<typeof createAgentRefreshTools>>>

const tool = (name: string): FakeTool => ({ name })
const asPool = (tools: FakeTool[]): Pool => tools as unknown as Pool

function refresh(options: {
  fresh: FakeTool[]
  agentDefinition?: Record<string, unknown>
  isAsync?: boolean
  useExactTools?: boolean
  floorTools?: FakeTool[]
}): FakeTool[] {
  const fn = createAgentRefreshTools({
    parentRefreshTools: () => asPool(options.fresh),
    agentDefinition: (options.agentDefinition ?? { source: 'user' }) as never,
    isAsync: options.isAsync ?? false,
    useExactTools: options.useExactTools ?? false,
    floorTools: asPool(options.floorTools ?? []),
  })
  if (!fn) throw new Error('expected a refresh callback')
  return fn() as unknown as FakeTool[]
}

describe('createAgentRefreshTools', () => {
  test('returns undefined when the parent has no callback', () => {
    expect(
      createAgentRefreshTools({
        parentRefreshTools: undefined,
        agentDefinition: { source: 'user' } as never,
        isAsync: false,
        useExactTools: false,
        floorTools: [],
      }),
    ).toBeUndefined()
  })

  test('applies the agent allowlist to the refreshed pool', () => {
    const names = refresh({
      fresh: [tool('Read'), tool('Bash'), tool('mcp__srv__do')],
      agentDefinition: { source: 'user', tools: ['Read'] },
    }).map(t => t.name)
    // Bash and the MCP tool are outside this agent's allowlist and must not
    // arrive through the back door.
    expect(names).toEqual(['Read'])
  })

  test('applies disallowedTools and the global agent disallow list', () => {
    const names = refresh({
      fresh: [
        tool('Read'),
        tool('Bash'),
        tool(ASK_USER_QUESTION_TOOL_NAME),
        tool('mcp__srv__do'),
      ],
      agentDefinition: { source: 'user', disallowedTools: ['Bash'] },
    }).map(t => t.name)
    expect(names).toEqual(['Read', 'mcp__srv__do'])
  })

  test('honours the async allowlist', () => {
    const names = refresh({
      fresh: [tool('Read'), tool('NotebookRead')],
      agentDefinition: { source: 'user' },
      isAsync: true,
    }).map(t => t.name)
    expect(names).toEqual(['Read'])
  })

  test('surfaces MCP tools that connected after the agent started', () => {
    const names = refresh({
      fresh: [tool('Read'), tool('mcp__late__tool')],
      agentDefinition: { source: 'user' },
      floorTools: [tool('Read')],
    }).map(t => t.name)
    expect(names).toContain('mcp__late__tool')
  })

  test('keeps the spawn-time pool as a floor', () => {
    // The parent pool can be narrower than the worker's own (coordinator mode,
    // a --agent main thread): the subagent must not lose tools it started with.
    const names = refresh({
      fresh: [tool('Agent')],
      agentDefinition: { source: 'user' },
      floorTools: [tool('Bash'), tool('mcp__frontmatter__tool')],
    }).map(t => t.name)
    expect(names).toEqual(['Bash', 'mcp__frontmatter__tool'])
  })

  test('a fresh definition wins over the floor entry of the same name', () => {
    const live = tool('mcp__srv__do')
    const stale = tool('mcp__srv__do')
    const result = refresh({
      fresh: [live],
      agentDefinition: { source: 'user' },
      floorTools: [stale],
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(live)
  })

  test('fork path uses the fork filter, not the agent allowlist', () => {
    const names = refresh({
      fresh: [tool('Read'), tool('Bash'), tool(ASK_USER_QUESTION_TOOL_NAME)],
      // A narrow `tools:` list must NOT shrink a fork — it inherits the
      // parent's exact pool minus the always-disallowed tools.
      agentDefinition: { source: 'user', tools: ['Read'] },
      useExactTools: true,
    }).map(t => t.name)
    expect(names).toEqual(['Read', 'Bash'])
  })
})
