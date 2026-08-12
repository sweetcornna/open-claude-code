/**
 * RefreshMcpTools.
 *
 * Covered here: the paths that need no live connection — server selection, the
 * never-dial contract, and the shape the model reads. The connected path (invalidate →
 * re-fetch → swap → diff) lives in `refreshMcpServerTools` and is exercised in
 * src/services/mcp/__tests__/refreshTools.test.ts, where the tool pool can be observed
 * directly.
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { RefreshMcpToolsTool } = await import('../RefreshMcpToolsTool.js')

type Client = { name: string; type: string }

function makeContext(clients: Client[]): unknown {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ mcp: { clients, tools: [] } }),
    setAppState: () => {},
    options: { mcpClients: clients, tools: [] },
  }
}

async function run(input: unknown, context: unknown) {
  const result = await (
    RefreshMcpToolsTool as unknown as {
      call: (i: unknown, c: unknown) => Promise<{ data: unknown[] }>
    }
  ).call(input, context)
  return result.data as Array<Record<string, unknown>>
}

describe('RefreshMcpToolsTool', () => {
  test('a disconnected server is reported, never dialled', async () => {
    const data = await run({}, makeContext([{ name: 'gone', type: 'failed' }]))
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ server: 'gone', status: 'not_connected' })
    expect(String(data[0]!.error)).toContain('never dials')
  })

  test('each non-connected state is named in its own error text', async () => {
    const data = await run(
      {},
      makeContext([
        { name: 'a', type: 'pending' },
        { name: 'b', type: 'needs-auth' },
        { name: 'c', type: 'disabled' },
      ]),
    )
    expect(data.map(entry => entry.status)).toEqual([
      'not_connected',
      'not_connected',
      'not_connected',
    ])
    expect(String(data[1]!.error)).toContain('needs-auth')
  })

  test('the server argument selects one server, literally or normalized', async () => {
    const clients = [
      { name: 'alpha', type: 'pending' },
      { name: 'my server', type: 'pending' },
    ]
    expect(await run({ server: 'alpha' }, makeContext(clients))).toHaveLength(1)
    // The model has only seen `mcp__my_server__…`, so it will ask for that spelling.
    const normalized = await run({ server: 'my_server' }, makeContext(clients))
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({ server: 'my server' })
  })

  test('an unknown server name throws with the available list, rather than silently doing nothing', async () => {
    await expect(
      run(
        { server: 'ghost' },
        makeContext([{ name: 'alpha', type: 'pending' }]),
      ),
    ).rejects.toThrow('Server "ghost" not found. Available servers: alpha')
  })

  test('zero servers is not an error — it is an empty refresh', async () => {
    expect(await run({}, makeContext([]))).toEqual([])
  })

  test('the empty result says so in prose rather than shipping "[]" to the model', () => {
    const tool = RefreshMcpToolsTool as unknown as {
      mapToolResultToToolResultBlockParam: (
        c: unknown,
        id: string,
      ) => { content: string }
      renderToolUseMessage: (i: unknown) => string
      isReadOnly: () => boolean
      isConcurrencySafe: () => boolean
    }
    expect(tool.mapToolResultToToolResultBlockParam([], 'tu-1').content).toBe(
      'No MCP servers to refresh.',
    )
    expect(
      tool.mapToolResultToToolResultBlockParam(
        [{ server: 'a', status: 'refreshed', toolCount: 2 }],
        'tu-1',
      ).content,
    ).toContain('"refreshed"')
    expect(tool.renderToolUseMessage({ server: 'a' })).toBe(
      'Refresh MCP tools from server "a"',
    )
    expect(tool.renderToolUseMessage({})).toBe('Refresh all MCP tool lists')
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe()).toBe(true)
  })
})
