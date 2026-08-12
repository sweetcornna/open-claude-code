/**
 * Discoverability of the two deferred MCP tools.
 *
 * Deferred tools are absent from the API tools array, so SearchExtraTools' index is the
 * *only* channel through which the model ever learns they exist or what arguments they
 * take. A deferred tool that does not surface for its own vocabulary is dead code with a
 * description; one whose schema fails to make it into the index leaves the model guessing
 * parameter names while ExecuteExtraTool validates against the real zod schema — so the
 * call is refused every time. Both failure modes are silent, hence this file.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'
import { setupGrowthbookMock } from '../../../../tests/mocks/growthbook.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
const growthbookMock = setupGrowthbookMock({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_DEPRECATED: async () => undefined,
  getFeatureValue_CACHED_WITH_REFRESH: async () => undefined,
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  onGrowthBookRefresh: () => () => {},
  initializeGrowthBook: async () => null,
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
})
afterAll(() => growthbookMock.reset())

const { buildToolIndex, searchTools } = await import('../toolIndex.js')
const { isDeferredTool } = await import(
  '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
)
const { WaitForMcpServersTool } = await import(
  '@open-claude-code/builtin-tools/tools/WaitForMcpServersTool/WaitForMcpServersTool.js'
)
const { RefreshMcpToolsTool } = await import(
  '@open-claude-code/builtin-tools/tools/RefreshMcpToolsTool/RefreshMcpToolsTool.js'
)

type AnyTool = import('../../../Tool.js').Tool
const TOOLS = [
  WaitForMcpServersTool,
  RefreshMcpToolsTool,
] as unknown as AnyTool[]

describe('the MCP wait/refresh tools are deferred and discoverable', () => {
  test('both are deferred — absent from CORE_TOOLS is what makes them lazy', () => {
    for (const tool of TOOLS) expect(isDeferredTool(tool)).toBe(true)
  })

  test('both land in the search index with real tokens', async () => {
    const index = await buildToolIndex(TOOLS)
    expect(index.map(entry => entry.name).sort()).toEqual([
      'RefreshMcpTools',
      'WaitForMcpServers',
    ])
    for (const entry of index) {
      expect(entry.tokens.length).toBeGreaterThan(0)
      // tfVector is a Map, not a plain object — `Object.keys(…).length` on it is
      // silently 0 and would pass this assertion for a completely empty index.
      expect(entry.tfVector.size).toBeGreaterThan(0)
    }
  })

  test('WaitForMcpServers wins the query a model would actually type', async () => {
    const index = await buildToolIndex(TOOLS)
    const results = searchTools(
      'wait for mcp server to finish connecting',
      index,
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe('WaitForMcpServers')
    expect(results[0]!.score).toBeGreaterThan(0)
  })

  test('RefreshMcpTools wins the "my device is open now" phrasing', async () => {
    const index = await buildToolIndex(TOOLS)
    const results = searchTools(
      're-sync missing mcp tools from a device',
      index,
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe('RefreshMcpTools')
  })

  test('their parameter schemas ride along in the index', async () => {
    const index = await buildToolIndex(TOOLS)
    const byName = new Map(index.map(entry => [entry.name, entry]))

    const wait = byName.get('WaitForMcpServers')!.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(wait.properties)).toEqual(['servers'])

    const refresh = byName.get('RefreshMcpTools')!.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(refresh.properties)).toEqual(['server'])
  })
})
