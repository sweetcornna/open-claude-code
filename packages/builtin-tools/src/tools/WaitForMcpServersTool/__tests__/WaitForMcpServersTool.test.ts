/**
 * WaitForMcpServers.
 *
 * The tool has one job with a sharp edge: it must observe connection transitions that
 * happen *after* the turn started. Reading `options.mcpClients` once — the obvious
 * implementation — produces a tool that always reports the state it was born with and
 * therefore never returns ready for the case it exists to serve.
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { WaitForMcpServersTool } = await import('../WaitForMcpServersTool.js')

type Client = { name: string; type: string; config?: unknown }

function makeContext(
  clients: Client[],
  mutable?: { clients: Client[] },
): unknown {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ mcp: { clients: mutable?.clients ?? clients } }),
    setAppState: () => {},
    options: { mcpClients: clients, tools: [] },
  }
}

async function run(input: unknown, context: unknown) {
  const result = await (
    WaitForMcpServersTool as unknown as {
      call: (
        i: unknown,
        c: unknown,
      ) => Promise<{ data: Record<string, unknown> }>
    }
  ).call(input, context)
  return result.data
}

describe('WaitForMcpServersTool', () => {
  test('returns ready immediately when the requested servers are already connected', async () => {
    const clients: Client[] = [{ name: 'alpha', type: 'connected' }]
    const data = await run({ servers: ['alpha'] }, makeContext(clients))
    expect(data).toEqual({
      ready: true,
      connected: ['alpha'],
      failed: [],
      stillPending: [],
      needsAuth: [],
      disabled: [],
      unknown: [],
    })
  })

  test('with no argument it waits on exactly the pending servers', async () => {
    const clients: Client[] = [
      { name: 'alpha', type: 'connected' },
      { name: 'beta', type: 'failed' },
    ]
    const data = await run({}, makeContext(clients))
    // No pending servers means nothing was requested, so nothing is reported —
    // and ready is true, because there is nothing left to wait for.
    expect(data.ready).toBe(true)
    expect(data.connected).toEqual([])
  })

  test('observes a transition that happens after the call started', async () => {
    const mutable = { clients: [{ name: 'slow', type: 'pending' }] as Client[] }
    const context = makeContext(mutable.clients, mutable)
    setTimeout(() => {
      mutable.clients = [{ name: 'slow', type: 'connected' }]
    }, 60)
    const data = await run({ servers: ['slow'] }, context)
    expect(data).toMatchObject({ ready: true, connected: ['slow'] })
  })

  // Runs the real MAX_WAIT_MS (5s) to prove the wait is actually bounded — the bug this
  // guards against is a poll loop that never gives up. Hence the raised timeout.
  test('a server that never connects comes back not-ready and still pending', async () => {
    const clients: Client[] = [{ name: 'stuck', type: 'pending' }]
    const startedAt = Date.now()
    const data = await run({ servers: ['stuck'] }, makeContext(clients))
    expect(data).toMatchObject({ ready: false, stillPending: ['stuck'] })
    expect(Date.now() - startedAt).toBeLessThan(9_000)
  }, 15_000)

  test('needs-auth and disabled are their own buckets, not failures', async () => {
    const clients: Client[] = [
      { name: 'locked', type: 'needs-auth' },
      { name: 'off', type: 'disabled' },
    ]
    const data = await run({ servers: ['locked', 'off'] }, makeContext(clients))
    expect(data).toMatchObject({
      ready: false,
      failed: [],
      needsAuth: ['locked'],
      disabled: ['off'],
    })
  })

  test('an unconfigured name is reported as unknown rather than pending forever', async () => {
    const clients: Client[] = [{ name: 'alpha', type: 'connected' }]
    const data = await run({ servers: ['ghost'] }, makeContext(clients))
    expect(data).toMatchObject({ ready: false, unknown: ['ghost'] })
  })

  test('the MCP-normalized spelling matches — that is the only name the model has seen', async () => {
    const clients: Client[] = [{ name: 'my server', type: 'connected' }]
    // The model only ever saw `mcp__my_server__…`, so this is the name it will pass.
    const data = await run({ servers: ['my_server'] }, makeContext(clients))
    expect(data).toMatchObject({ ready: true, connected: ['my server'] })
  })

  test('the tool result names a distinct next action per bucket', () => {
    const block = (
      WaitForMcpServersTool as unknown as {
        mapToolResultToToolResultBlockParam: (
          c: unknown,
          id: string,
        ) => { content: string; is_error?: boolean }
      }
    ).mapToolResultToToolResultBlockParam(
      {
        ready: false,
        connected: ['a'],
        failed: ['b'],
        stillPending: ['c'],
        needsAuth: ['d'],
        disabled: ['e'],
        unknown: ['f'],
      },
      'tu-1',
    )
    expect(block.is_error).toBe(true)
    expect(block.content).toContain('call them directly')
    expect(block.content).toContain('/mcp')
    expect(block.content).toContain(
      'no MCP server with this name is configured',
    )
  })

  test('render and permissions: waiting never asks the user for approval', async () => {
    const tool = WaitForMcpServersTool as unknown as {
      renderToolUseMessage: (i: unknown) => string
      checkPermissions: (i: unknown) => Promise<{ behavior: string }>
      isReadOnly: () => boolean
      isConcurrencySafe: () => boolean
    }
    expect(tool.renderToolUseMessage({ servers: ['a', 'b'] })).toBe(
      'Wait for MCP servers to connect: a, b',
    )
    expect(tool.renderToolUseMessage({})).toBe(
      'Wait for pending MCP servers to connect',
    )
    expect((await tool.checkPermissions({})).behavior).toBe('allow')
    expect(tool.isReadOnly()).toBe(true)
    // A barrier that runs concurrently with what it gates is not a barrier.
    expect(tool.isConcurrencySafe()).toBe(false)
  })
})
