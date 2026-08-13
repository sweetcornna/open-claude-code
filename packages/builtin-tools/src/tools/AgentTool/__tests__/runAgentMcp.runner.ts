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
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('bun:bundle', () => ({ feature: (_name: string) => true }))
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', () => ({
  ...debugMock(),
  logForDebugging: (message: string) => {
    debugMessages.push(message)
  },
}))

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
const connectConfigs = new Map<string, unknown>()
const clientsByName = new Map<string, FakeClient>()
const debugMessages: string[] = []
const savedSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

// Complete surfaces: only the two entry points under test are replaced, every
// other export keeps delegating to the real module (other files in this
// process — and runAgent's own import graph — still need them).
const realMcpClient = await import('src/services/mcp/client.js')
const realMcpConfig = await import('src/services/mcp/config.js')

mock.module('src/services/mcp/client.ts', () => ({
  ...realMcpClient,
  connectToServer: async (name: string, config: unknown) => {
    connectCalls.push(name)
    connectConfigs.set(name, config)
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

const {
  continueAgentIterator,
  initializeAgentMcpServers,
  createAgentRefreshTools,
} = await import('../runAgent.js')
const { ASK_USER_QUESTION_TOOL_NAME } = await import(
  '../../AskUserQuestionTool/prompt.js'
)
const { getAgentModelSettingsSlot, removeInherited1mForAgentAlias } =
  await import('src/utils/model/agent.js')

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
  connectConfigs.clear()
  clientsByName.clear()
  debugMessages.length = 0
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
})

describe('foreground-to-background iterator handoff', () => {
  test('continues the pending next call even when it exceeds the old 1s timeout', async () => {
    let runCount = 0
    let sideEffectCount = 0
    let nextCallCount = 0
    let returnCallCount = 0

    async function* source(): AsyncGenerator<string, void> {
      runCount++
      await new Promise(resolve => setTimeout(resolve, 1_100))
      sideEffectCount++
      yield 'first-result'
      yield 'terminal-result'
    }

    const sourceIterator = source()
    const iterator: AsyncIterator<string, void> = {
      next: () => {
        nextCallCount++
        return sourceIterator.next()
      },
      return: async () => {
        returnCallCount++
        return sourceIterator.return()
      },
    }
    const pendingNext = iterator.next()
    const results: string[] = []

    for await (const result of continueAgentIterator(iterator, pendingNext)) {
      results.push(result)
    }

    expect(results).toEqual(['first-result', 'terminal-result'])
    expect(runCount).toBe(1)
    expect(sideEffectCount).toBe(1)
    expect(returnCallCount).toBe(0)
    expect(nextCallCount).toBe(3)
  }, 5_000)

  test('closes the owned iterator when the continuation consumer exits early', async () => {
    let finalized = false
    async function* source(): AsyncGenerator<string, void> {
      try {
        yield 'first-result'
        yield 'unconsumed-result'
      } finally {
        finalized = true
      }
    }

    const iterator = source()
    for await (const result of continueAgentIterator(
      iterator,
      iterator.next(),
    )) {
      expect(result).toBe('first-result')
      break
    }

    expect(finalized).toBe(true)
  })
})

afterAll(() => {
  if (savedSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = savedSubagentModel
  }
})

describe('Agent model-settings slot propagation', () => {
  test('empty env override follows the configured Agent selection', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = ''

    expect(
      getAgentModelSettingsSlot('default', 'claude-opus-5', 'sonnet'),
    ).toBe('default')
  })

  test('explicit family aliases use their own slot', () => {
    expect(
      getAgentModelSettingsSlot(
        'inherit',
        'claude-sonnet-5',
        'default',
        'sonnet',
      ),
    ).toBe('sonnet')
  })

  test('inherit keeps the parent default slot and suffix', () => {
    expect(
      getAgentModelSettingsSlot('inherit', 'claude-opus-5[1m]', 'default'),
    ).toBe('default')
    expect(removeInherited1mForAgentAlias('inherit', 'claude-opus-5[1m]')).toBe(
      'claude-opus-5[1m]',
    )
  })

  test('a bare alias re-applies 1M from its own slot', () => {
    expect(removeInherited1mForAgentAlias('opus', 'claude-opus-5[1m]')).toBe(
      'claude-opus-5',
    )
    expect(
      removeInherited1mForAgentAlias('opus[1m]', 'claude-opus-5[1m]'),
    ).toBe('claude-opus-5[1m]')
  })

  test('explicit concrete ids use reverse tier lookup', () => {
    expect(
      getAgentModelSettingsSlot(
        'claude-sonnet-5',
        'claude-sonnet-5',
        'default',
      ),
    ).toBe('sonnet')
  })

  test('provider default selections use the default slot', () => {
    expect(
      getAgentModelSettingsSlot('default', 'claude-opus-5', 'sonnet'),
    ).toBe('default')
  })
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

  test('directly constructed definitions cannot connect malformed reserved specs', async () => {
    const secret = 'malformed-reserved-secret'
    const result = await initializeAgentMcpServers(
      agentWithServers([
        Object.fromEntries([
          ['__proto__', { type: 'stdio', command: 'run', args: [secret] }],
        ]),
        inlineServer('good'),
      ]),
      [] as unknown as ParentClients,
    )

    expect(connectCalls).toEqual(['good'])
    expect(debugMessages).toContain(
      "[Agent: tester] Skipping reserved MCP server name '__proto__' in frontmatter",
    )
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test('directly constructed definitions cannot connect reserved server names', async () => {
    const secret = 'reserved-secret'
    const result = await initializeAgentMcpServers(
      agentWithServers([
        {
          'computer-use': {
            type: 'stdio',
            command: 'run',
            args: [secret],
          },
        },
        inlineServer('good'),
      ]),
      [] as unknown as ParentClients,
    )

    expect(connectCalls).toEqual(['good'])
    expect(result.tools.map(t => t.name)).toEqual(['mcp__good__tool'])
    expect(debugMessages).toContain(
      "[Agent: tester] Skipping reserved MCP server name 'computer-use' in frontmatter",
    )
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test('directly constructed malformed IDE transport is blocked', async () => {
    const secret = 'malformed-ide-secret'
    const result = await initializeAgentMcpServers(
      agentWithServers([
        {
          internal: {
            type: 'sse-ide',
            url: 'http://127.0.0.1',
            authToken: secret,
          },
        },
        inlineServer('good'),
      ]),
      [] as unknown as ParentClients,
    )

    expect(connectCalls).toEqual(['good'])
    expect(result.tools.map(t => t.name)).toEqual(['mcp__good__tool'])
    expect(debugMessages).toContain(
      "[Agent: tester] Skipping internal-only MCP transport 'sse-ide' for 'internal' in frontmatter",
    )
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test.each([
    'sse-ide',
    'ws-ide',
    'sdk',
    'claudeai-proxy',
  ] as const)('directly constructed definitions cannot connect %s transports', async transport => {
    const secret = `${transport}-secret`
    const config =
      transport === 'sdk'
        ? { type: transport, name: secret }
        : transport === 'claudeai-proxy'
          ? { type: transport, url: 'https://example.test/mcp', id: secret }
          : {
              type: transport,
              url: 'http://127.0.0.1',
              ideName: 'test-ide',
              authToken: secret,
            }
    const result = await initializeAgentMcpServers(
      agentWithServers([{ internal: config }, inlineServer('good')]),
      [] as unknown as ParentClients,
    )

    expect(connectCalls).toEqual(['good'])
    expect(result.tools.map(t => t.name)).toEqual(['mcp__good__tool'])
    expect(debugMessages).toContain(
      `[Agent: tester] Skipping internal-only MCP transport '${transport}' for 'internal' in frontmatter`,
    )
    expect(debugMessages.join('\n')).not.toContain(secret)
  })

  test.each([
    ['stdio', { type: 'stdio' as const, command: 'run', args: [] }],
    ['http', { type: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { type: 'sse' as const, url: 'https://example.test/sse' }],
    ['ws', { type: 'ws' as const, url: 'wss://example.test/mcp' }],
  ])('keeps user-authored %s transports', async (name, config) => {
    const result = await initializeAgentMcpServers(
      agentWithServers([{ [name]: config }]),
      [] as unknown as ParentClients,
    )

    expect(connectCalls).toEqual([name])
    expect(connectConfigs.get(name)).toMatchObject({
      ...config,
      scope: 'dynamic',
    })
    expect(result.tools.map(t => t.name)).toEqual([`mcp__${name}__tool`])
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
