import { describe, test, expect } from 'bun:test'
import { mock } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { makeSharedModuleMock } from '../../../../../../tests/mocks/sharedModuleMock'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

mock.module('@open-claude-code/tool-runtime/featureGate.js', () => ({
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
  onGrowthBookRefresh: () => {},
  initializeGrowthBook: async () => {},
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
}))

mock.module('src/utils/tools/searchExtraTools.js', () => ({
  isSearchExtraToolsEnabledOptimistic: () => true,
  getAutoSearchExtraToolsCharThreshold: () => 100,
  getSearchExtraToolsMode: () => 'tst' as const,
  isSearchExtraToolsToolAvailable: async () => true,
  isSearchExtraToolsEnabled: async () => true,
  isToolReferenceBlock: () => false,
  extractDiscoveredToolNames: () => new Set(),
  isDeferredToolsDeltaEnabled: () => false,
  getDeferredToolsDelta: () => null,
}))

mock.module('src/constants/tools.js', () => ({
  CORE_TOOLS: new Set(['Read', 'Edit', 'SearchExtraTools', 'ExecuteExtraTool']),
}))

// Mock toolIndex module
type MockSearchExtraToolsResult = {
  name: string
  description: string
  searchHint: string | undefined
  score: number
  isMcp: boolean
  isDeferred: boolean
  inputSchema: object | undefined
}
const mockSearchTools = mock(
  (
    _query: string,
    _index: unknown,
    _limit?: number,
  ): MockSearchExtraToolsResult[] => [],
)
const mockGetToolIndex = mock(async (_tools: unknown) => [])

// Complete-surface mock, per CLAUDE.md: mock.module is process-global and
// last-write-wins, so a hand-rolled partial surface makes every export this
// file happens not to list (parseToolName, buildToolIndex,
// clearToolIndexCache, getToolInputJSONSchema) resolve to undefined for any
// test file that loads later in the same process — and file order differs
// between macOS and Linux, so it only breaks on CI. Every export delegates to
// the real implementation; only the two search entry points are overridden,
// which is all these tests actually stub.
const realToolIndex = await import('src/services/searchExtraTools/toolIndex.js')

makeSharedModuleMock(
  'src/services/searchExtraTools/toolIndex.js',
  realToolIndex,
).setup({
  getToolIndex: mockGetToolIndex,
  searchTools: mockSearchTools,
})

// Mock analytics
mock.module('@open-claude-code/tool-runtime/analytics.js', () => ({
  logEvent: () => {},
}))

const { SearchExtraToolsTool } = await import('../SearchExtraToolsTool.js')

function makeDeferredTool(name: string, desc: string = 'A tool') {
  return {
    name,
    isMcp: false,
    alwaysLoad: undefined,
    shouldDefer: undefined,
    searchHint: '',
    prompt: async () => desc,
    description: async () => desc,
    inputSchema: {},
    isEnabled: () => true,
  }
}

function makeContext(tools: unknown[] = []) {
  return {
    options: { tools },
    cwd: '/tmp',
    sessionId: 'test',
    getAppState: () => ({
      mcp: { clients: [] },
    }),
  } as never
}

describe('SearchExtraToolsTool search enhancements', () => {
  test('discover: prefix triggers TF-IDF search and returns matches', async () => {
    const mockTool = makeDeferredTool('CronCreate', 'Schedule cron jobs')
    mockGetToolIndex.mockResolvedValueOnce([])
    mockSearchTools.mockReturnValueOnce([
      {
        name: 'CronCreate',
        description: 'Schedule cron jobs',
        searchHint: undefined,
        score: 0.85,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ])

    const result: { data: { matches: string[] } } = await (
      SearchExtraToolsTool as any
    ).call(
      { query: 'discover:schedule cron job', max_results: 5 },
      makeContext([mockTool]),
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data.matches).toContain('CronCreate')
  })

  test('keyword + TF-IDF parallel search merges results', async () => {
    const toolA = makeDeferredTool('ToolA', 'Tool A description')
    const toolB = makeDeferredTool('ToolB', 'Tool B description')
    const toolC = makeDeferredTool('ToolC', 'Tool C description')

    // getToolIndex returns tools, searchTools returns different ranking
    mockGetToolIndex.mockResolvedValueOnce([])
    mockSearchTools.mockReturnValueOnce([
      {
        name: 'ToolB',
        description: 'Tool B',
        searchHint: undefined,
        score: 0.9,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
      {
        name: 'ToolC',
        description: 'Tool C',
        searchHint: undefined,
        score: 0.8,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ])

    const result: { data: { matches: string[] } } = await (
      SearchExtraToolsTool as any
    ).call(
      { query: 'tool B', max_results: 5 },
      makeContext([toolA, toolB, toolC]),
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    // ToolB should be in results (matched by both keyword and TF-IDF)
    expect(result.data.matches).toContain('ToolB')
  })

  test('text mode output for all models (unified self-built search)', async () => {
    const tool = makeDeferredTool('TestTool', 'A test tool')
    mockGetToolIndex.mockResolvedValueOnce([])
    mockSearchTools.mockReturnValueOnce([])

    // First call: search returns matches
    mockSearchTools.mockReturnValueOnce([
      {
        name: 'TestTool',
        description: 'A test',
        searchHint: undefined,
        score: 0.9,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ])

    // mapToolResultToToolResultBlockParam always returns text, not tool_reference
    const blockParam = SearchExtraToolsTool.mapToolResultToToolResultBlockParam(
      { matches: ['TestTool'], query: 'test', total_deferred_tools: 1 },
      'tool-use-123',
      { mainLoopModel: 'claude-3-haiku-20240307' },
    )

    expect(typeof blockParam.content).toBe('string')
    expect(blockParam.content as string).toContain('TestTool')
    expect(blockParam.content as string).toContain('ExecuteExtraTool')
  })

  test('text output works for any model without distinction', async () => {
    const blockParam = SearchExtraToolsTool.mapToolResultToToolResultBlockParam(
      { matches: ['TestTool'], query: 'test', total_deferred_tools: 1 },
      'tool-use-123',
      { mainLoopModel: 'claude-sonnet-4-20250514' },
    )

    expect(typeof blockParam.content).toBe('string')
    expect(blockParam.content as string).toContain('TestTool')
    expect(blockParam.content as string).toContain('ExecuteExtraTool')
  })

  test('backwards compatible without context parameter', async () => {
    const blockParam = SearchExtraToolsTool.mapToolResultToToolResultBlockParam(
      { matches: ['TestTool'], query: 'test', total_deferred_tools: 1 },
      'tool-use-123',
    )

    expect(typeof blockParam.content).toBe('string')
    expect(blockParam.content as string).toContain('TestTool')
    expect(blockParam.content as string).toContain('ExecuteExtraTool')
  })

  test('empty results return helpful message', async () => {
    const blockParam = SearchExtraToolsTool.mapToolResultToToolResultBlockParam(
      { matches: [], query: 'nonexistent', total_deferred_tools: 5 },
      'tool-use-123',
    )

    expect(blockParam.content).toContain('No matching deferred tools found')
  })
})

/**
 * Deferred tools never appear in the API tools array, so this tool_result text
 * is the model's only view of their parameters — and ExecuteExtraTool then
 * validates `params` against the same schema, rejecting missing required
 * fields and unknown keys alike. Dropping the schema here forces the model to
 * guess, which is what produced the reported DiscoverSkills (`query` instead
 * of `description`) and Monitor (`task_id`) failures.
 */
describe('SearchExtraTools delivers parameter schemas to the model', () => {
  // Reset before setting an implementation. Earlier tests in this file queue
  // mockReturnValueOnce values they never consume, and a queued Once wins over
  // mockImplementation — so without the reset these tests would read another
  // test's leftover return value.
  function stubSearch(results: MockSearchExtraToolsResult[]): void {
    mockGetToolIndex.mockReset()
    mockSearchTools.mockReset()
    mockGetToolIndex.mockImplementation(async () => [])
    mockSearchTools.mockImplementation(() => results)
  }

  const zodTool = async (name: string) => {
    const { z } = await import('zod/v4')
    return {
      ...makeDeferredTool(name, `${name} does things`),
      inputSchema: z.strictObject({
        description: z.string(),
        limit: z.number().optional(),
      }),
    }
  }

  test('select: returns the schema for the selected tool', async () => {
    const tool = await zodTool('DiscoverSkills')
    const result: { data: { schemas?: Record<string, unknown> } } = await (
      SearchExtraToolsTool as any
    ).call(
      { query: 'select:DiscoverSkills', max_results: 5 },
      makeContext([tool]),
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    const schema = result.data.schemas?.DiscoverSkills as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema).toBeDefined()
    expect(Object.keys(schema.properties).sort()).toEqual([
      'description',
      'limit',
    ])
    expect(schema.required).toEqual(['description'])
  })

  test('discover: returns the schema (it used to build the text then drop it)', async () => {
    const tool = await zodTool('Monitor')
    stubSearch([
      {
        name: 'Monitor',
        description: 'Watch a log',
        searchHint: undefined,
        score: 0.9,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ])

    const result: { data: { schemas?: Record<string, unknown> } } = await (
      SearchExtraToolsTool as any
    ).call(
      { query: 'discover:watch a log file', max_results: 5 },
      makeContext([tool]),
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data.schemas?.Monitor).toBeDefined()
  })

  test('keyword search returns the schema', async () => {
    const tool = await zodTool('Monitor')
    stubSearch([
      {
        name: 'Monitor',
        description: 'Watch a log',
        searchHint: undefined,
        score: 0.9,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ])

    const result: { data: { schemas?: Record<string, unknown> } } = await (
      SearchExtraToolsTool as any
    ).call(
      { query: 'monitor log', max_results: 5 },
      makeContext([tool]),
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data.schemas?.Monitor).toBeDefined()
  })

  test('the schema reaches the wire text, with required fields named', () => {
    const blockParam = SearchExtraToolsTool.mapToolResultToToolResultBlockParam(
      {
        matches: ['DiscoverSkills'],
        query: 'select:DiscoverSkills',
        total_deferred_tools: 1,
        schemas: {
          DiscoverSkills: {
            type: 'object',
            properties: { description: { type: 'string' } },
            required: ['description'],
            additionalProperties: false,
          },
        },
      },
      'tool-use-123',
    )

    const text = blockParam.content as string
    expect(text).toContain('DiscoverSkills')
    expect(text).toContain('description')
    expect(text).toContain('required')
    // additionalProperties:false is what turns an extra key into a hard
    // failure, so the model has to see it.
    expect(text).toContain('additionalProperties')
  })

  test('no schema section when there is nothing to report', () => {
    const blockParam = SearchExtraToolsTool.mapToolResultToToolResultBlockParam(
      { matches: ['TestTool'], query: 'test', total_deferred_tools: 1 },
      'tool-use-123',
    )

    expect(blockParam.content as string).not.toContain('Parameter schemas')
  })

  test('already-loaded core tools get no schema (already in the tools array)', async () => {
    const tool = await zodTool('Read')
    const result: {
      data: { schemas?: Record<string, unknown>; already_loaded?: string[] }
    } = await (SearchExtraToolsTool as any).call(
      { query: 'select:Read', max_results: 5 },
      makeContext([tool]),
      async () => ({ behavior: 'allow' }),
      { type: 'assistant', content: [], uuid: 'msg1' } as never,
      undefined,
    )

    expect(result.data.already_loaded).toEqual(['Read'])
    expect(result.data.schemas).toBeUndefined()
  })
})
