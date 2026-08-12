/**
 * The connected half of RefreshMcpTools: what actually lands in the live tool pool.
 *
 * The tool's own test covers the never-dial contract; this one covers the part that can
 * silently do nothing — the swap. A refresh that re-queries but forgets to replace the
 * pool reports "refreshed: 12 tools" while the model keeps seeing the stale twelve, and
 * no assertion about the return value would catch it.
 *
 * `fetchToolsForClient` is memoized per connection object, so a fresh `{}` client per
 * test is enough isolation — no module mocks are needed and none are used here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { refreshMcpServerTools, swapMcpServerTools } = await import(
  '../refreshTools.js'
)

type PoolTool = { name: string }
type State = { mcp: { tools: PoolTool[] } }

let state: State
/**
 * Stands in for the real store setter. The AppState slice under test is `mcp.tools`, so
 * the fixture carries only that; the double assertion is the seam between the fixture's
 * shape and the production signature.
 */
const setAppState = ((updater: (prev: State) => State) => {
  state = updater(state)
}) as unknown as Parameters<typeof swapMcpServerTools>[0]

beforeEach(() => {
  state = { mcp: { tools: [] } }
})

describe('swapMcpServerTools', () => {
  test("replaces only the named server's slice of the pool", () => {
    state = {
      mcp: {
        tools: [
          { name: 'Read' },
          { name: 'mcp__alpha__old' },
          { name: 'mcp__beta__keep' },
        ],
      },
    }
    swapMcpServerTools(setAppState, 'alpha', [
      { name: 'mcp__alpha__new' },
    ] as never)
    expect(state.mcp.tools.map(t => t.name)).toEqual([
      'Read',
      'mcp__beta__keep',
      'mcp__alpha__new',
    ])
  })

  test('a tool that disappeared upstream actually leaves the pool', () => {
    state = { mcp: { tools: [{ name: 'mcp__alpha__gone' }] } }
    swapMcpServerTools(setAppState, 'alpha', [])
    expect(state.mcp.tools).toEqual([])
  })

  test('the server name is normalized the same way tool names are', () => {
    state = { mcp: { tools: [{ name: 'mcp__my_server__old' }] } }
    // Prefix is built from the *unnormalized* name, so 'my server' must reach
    // 'mcp__my_server__' or the swap silently appends instead of replacing.
    swapMcpServerTools(setAppState, 'my server', [
      { name: 'mcp__my_server__new' },
    ] as never)
    expect(state.mcp.tools.map(t => t.name)).toEqual(['mcp__my_server__new'])
  })
})

describe('refreshMcpServerTools', () => {
  test('a non-connected server short-circuits without touching the pool', async () => {
    state = { mcp: { tools: [{ name: 'mcp__alpha__stale' }] } }
    const result = await refreshMcpServerTools(
      { name: 'alpha', type: 'pending' } as never,
      state.mcp.tools as never,
      setAppState,
    )
    expect(result.status).toBe('not_connected')
    expect(state.mcp.tools.map(t => t.name)).toEqual(['mcp__alpha__stale'])
  })

  test('a successful refresh swaps the pool and reports the diff', async () => {
    const listTools = async () => ({
      tools: [
        { name: 'kept', inputSchema: { type: 'object' } },
        { name: 'fresh', inputSchema: { type: 'object' } },
      ],
    })
    const client = {
      name: 'alpha',
      type: 'connected',
      client: { listTools, getServerCapabilities: () => ({ tools: {} }) },
      capabilities: { tools: {} },
      config: { type: 'stdio' },
    }
    state = {
      mcp: {
        tools: [{ name: 'mcp__alpha__kept' }, { name: 'mcp__alpha__old' }],
      },
    }

    const result = await refreshMcpServerTools(
      client as never,
      state.mcp.tools as never,
      setAppState,
    )

    expect(result.status).toBe('refreshed')
    expect(result.toolCount).toBe(2)
    expect(result.added).toEqual(['mcp__alpha__fresh'])
    expect(result.removed).toEqual(['mcp__alpha__old'])
    expect(state.mcp.tools.map(t => t.name).sort()).toEqual([
      'mcp__alpha__fresh',
      'mcp__alpha__kept',
    ])
  })

  test('a failed re-query keeps the previous tool set rather than blanking the server', async () => {
    const client = {
      name: 'alpha',
      type: 'connected',
      client: {
        listTools: async () => {
          throw new Error('transport went away')
        },
        getServerCapabilities: () => ({ tools: {} }),
      },
      capabilities: { tools: {} },
      config: { type: 'stdio' },
    }
    state = { mcp: { tools: [{ name: 'mcp__alpha__kept' }] } }

    const result = await refreshMcpServerTools(
      client as never,
      state.mcp.tools as never,
      setAppState,
    )

    expect(result.status).toBe('error')
    expect(String(result.error)).toContain('previous tool set was kept')
    expect(state.mcp.tools.map(t => t.name)).toEqual(['mcp__alpha__kept'])
  })
})
