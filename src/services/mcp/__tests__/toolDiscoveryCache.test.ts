import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { createToolsListChangedRefreshGuard } from '../toolsListChangedRefreshGuard.js'
import type { MCPServerConnection } from '../types.js'

mock.module('src/utils/telemetry/log.ts', logMock)

const { fetchToolsForClient } = await import('../client.js')

type ListedTool = {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
  }
}

function listedTool(
  name: string,
  description = `${name} description`,
): ListedTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function connectedClient(
  name: string,
  listTools: () => Promise<{ tools: unknown[] }>,
  config: Record<string, unknown> = {
    type: 'stdio',
    command: 'fixture',
    scope: 'dynamic',
  },
): MCPServerConnection {
  return {
    type: 'connected',
    name,
    capabilities: { tools: {} },
    client: { listTools },
    config,
    cleanup: async () => {},
  } as unknown as MCPServerConnection
}

beforeEach(() => fetchToolsForClient.cache.clear())
afterEach(() => fetchToolsForClient.cache.clear())

describe('MCP tool discovery cache', () => {
  test('retries after the first listTools failure instead of caching an empty list', async () => {
    let attempt = 0
    const connection = connectedClient('service-a', async () => {
      attempt++
      if (attempt === 1) throw new Error('temporary discovery failure')
      return { tools: [listedTool('action')] }
    })

    await expect(fetchToolsForClient(connection)).rejects.toThrow(
      'temporary discovery failure',
    )
    const tools = await fetchToolsForClient(connection)

    expect(attempt).toBe(2)
    expect(tools.map(tool => tool.name)).toEqual(['mcp__service-a__action'])
  })

  test.each([
    'service-a',
    'service_a',
  ])('does not reuse tools from an older %s connection', async serverName => {
    const firstListTools = mock(async () => ({
      tools: [listedTool('old_action')],
    }))
    const secondListTools = mock(async () => ({
      tools: [listedTool('new_action')],
    }))
    const first = connectedClient(serverName, firstListTools)
    const replacement = connectedClient(serverName, secondListTools)

    const firstTools = await fetchToolsForClient(first)
    const replacementTools = await fetchToolsForClient(replacement)

    expect(firstTools.map(tool => tool.name)).toEqual([
      `mcp__${serverName}__old_action`,
    ])
    expect(replacementTools.map(tool => tool.name)).toEqual([
      `mcp__${serverName}__new_action`,
    ])
    expect(firstListTools).toHaveBeenCalledTimes(1)
    expect(secondListTools).toHaveBeenCalledTimes(1)
  })

  test('keeps arbitrary tools from a user-configured server named ide', async () => {
    const connection = connectedClient('ide', async () => ({
      tools: [listedTool('arbitrary_action')],
    }))

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(tool => tool.name)).toEqual(['mcp__ide__arbitrary_action'])
  })

  // The IDE extension advertises private RPCs (openDiff / close_tab /
  // closeAllDiffTabs) that the CLI drives itself; a model calling them hijacks
  // the diff panel an in-flight edit is holding. Narrowing keys off the
  // internal-only transport type, i.e. the lockfile-discovery provenance, not
  // off the server being named `ide`.
  test.each([
    'sse-ide',
    'ws-ide',
  ])('exposes only executeCode and getDiagnostics on a %s lockfile connection', async transportType => {
    const connection = connectedClient(
      'ide',
      async () => ({
        tools: [
          listedTool('openDiff'),
          listedTool('getDiagnostics'),
          listedTool('closeAllDiffTabs'),
          listedTool('close_tab'),
          listedTool('executeCode'),
        ],
      }),
      {
        type: transportType,
        url: 'ws://127.0.0.1:12345',
        ideName: 'Visual Studio Code',
        scope: 'dynamic',
      },
    )

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(tool => tool.name)).toEqual([
      'mcp__ide__getDiagnostics',
      'mcp__ide__executeCode',
    ])
  })

  test('narrows a lockfile IDE connection registered under a different name', async () => {
    const connection = connectedClient(
      'vscode',
      async () => ({
        tools: [listedTool('openDiff'), listedTool('executeCode')],
      }),
      {
        type: 'sse-ide',
        url: 'http://127.0.0.1:12345/sse',
        ideName: 'Visual Studio Code',
        scope: 'dynamic',
      },
    )

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(tool => tool.name)).toEqual(['mcp__vscode__executeCode'])
  })

  test('keeps valid tools when another definition is malformed', async () => {
    const malformed = {} as Record<string, unknown>
    Object.defineProperty(malformed, 'name', {
      enumerable: true,
      get() {
        throw new Error('malformed tool name')
      },
    })
    const connection = connectedClient('service_a', async () => ({
      tools: [malformed, listedTool('action')],
    }))

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(tool => tool.name)).toEqual(['mcp__service_a__action'])
  })

  test('fails explicitly when every advertised tool is malformed', async () => {
    const connection = connectedClient('service-a', async () => ({
      tools: [{ name: null, inputSchema: { type: 'object' } }],
    }))

    await expect(fetchToolsForClient(connection)).rejects.toThrow(
      'Every advertised MCP tool failed conversion',
    )
  })
})

describe('tools/list_changed refresh ordering', () => {
  test('publishes only the newest notification when fetches finish out of order', async () => {
    const guard = createToolsListChangedRefreshGuard()
    const connection = { name: 'service-a', client: {} }
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    const published: string[][] = []
    guard.activate(connection)

    const firstRefresh = guard.refresh(
      connection,
      () => first.promise,
      tools => published.push(tools),
    )
    const secondRefresh = guard.refresh(
      connection,
      () => second.promise,
      tools => published.push(tools),
    )

    second.resolve(['new-tool'])
    await expect(secondRefresh).resolves.toBe(true)
    first.resolve(['old-tool'])
    await expect(firstRefresh).resolves.toBe(false)
    expect(published).toEqual([['new-tool']])
  })

  test('rejects a late refresh from a replaced connection', async () => {
    const guard = createToolsListChangedRefreshGuard()
    const oldConnection = { name: 'service-a', client: {} }
    const replacement = { name: 'service-a', client: {} }
    const oldFetch = deferred<string[]>()
    const published: string[][] = []
    guard.activate(oldConnection)

    const oldRefresh = guard.refresh(
      oldConnection,
      () => oldFetch.promise,
      tools => published.push(tools),
    )
    guard.activate(replacement)
    const replacementRefresh = guard.refresh(
      replacement,
      () => Promise.resolve(['replacement-tool']),
      tools => published.push(tools),
    )

    await expect(replacementRefresh).resolves.toBe(true)
    oldFetch.resolve(['stale-tool'])
    await expect(oldRefresh).resolves.toBe(false)
    expect(published).toEqual([['replacement-tool']])
  })
})
