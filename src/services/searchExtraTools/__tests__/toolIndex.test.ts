import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'
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

const {
  parseToolName,
  buildToolIndex,
  searchTools,
  getToolIndex,
  getToolInputJSONSchema,
  clearToolIndexCache,
} = await import('../toolIndex.js')

type MockTool = {
  name: string
  alwaysLoad?: boolean
  isMcp?: boolean
  shouldDefer?: boolean
  searchHint?: string
  prompt: () => Promise<string>
  inputJSONSchema?: object
  inputSchema?: unknown
}

function makeMockTool(overrides: Partial<MockTool> = {}): MockTool {
  return {
    name: 'TestTool',
    isMcp: false,
    shouldDefer: undefined,
    alwaysLoad: undefined,
    searchHint: undefined,
    prompt: async () => 'A test tool for testing purposes.',
    inputJSONSchema: undefined,
    inputSchema: undefined,
    ...overrides,
  }
}

describe('parseToolName', () => {
  test('parses MCP tool names', () => {
    const result = parseToolName('mcp__github__create_issue')
    expect(result.isMcp).toBe(true)
    expect(result.parts).toEqual(['github', 'create', 'issue'])
  })

  test('parses built-in tool names', () => {
    const result = parseToolName('NotebookEditTool')
    expect(result.isMcp).toBe(false)
    expect(result.parts).toEqual(['notebook', 'edit', 'tool'])
  })

  test('parses underscore-separated tool names', () => {
    const result = parseToolName('EnterWorktreeTool')
    expect(result.isMcp).toBe(false)
    expect(result.parts).toContain('enter')
    expect(result.parts).toContain('worktree')
  })
})

describe('buildToolIndex', () => {
  test('builds index from deferred tools only', async () => {
    const tools = [
      makeMockTool({ name: 'CoreRead', alwaysLoad: true }),
      makeMockTool({
        name: 'ConfigTool',
        searchHint: 'configure settings options',
        prompt: async () => 'Manage configuration settings.',
      }),
      makeMockTool({
        name: 'CronCreateTool',
        searchHint: 'schedule recurring prompt',
        prompt: async () => 'Create cron jobs for scheduling.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    // Only non-core, non-alwaysLoad tools should be indexed
    expect(index.length).toBe(2)
    for (const entry of index) {
      expect(entry.tokens.length).toBeGreaterThan(0)
      expect(entry.tfVector.size).toBeGreaterThan(0)
    }
  })

  test('returns empty array when all tools are core', async () => {
    const tools = [
      makeMockTool({ name: 'Read', alwaysLoad: true }),
      makeMockTool({ name: 'Edit', alwaysLoad: true }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    expect(index.length).toBe(0)
  })
})

describe('searchTools', () => {
  test('finds tools matching query', async () => {
    const tools = [
      makeMockTool({
        name: 'CronCreateTool',
        searchHint: 'schedule a recurring or one-shot prompt',
        prompt: async () => 'Create cron jobs for scheduling tasks.',
      }),
      makeMockTool({
        name: 'ConfigTool',
        searchHint: 'configure settings options',
        prompt: async () => 'Manage configuration settings.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    const results = searchTools('schedule cron job', index)
    expect(results.length).toBeGreaterThan(0)
    // CronCreateTool should rank highest for "schedule cron job"
    expect(results[0]!.name).toBe('CronCreateTool')
    expect(results[0]!.score).toBeGreaterThan(0)
  })

  test('returns empty array for empty query', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    expect(searchTools('', index)).toEqual([])
  })

  test('returns empty array when no tools match', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration settings.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    const results = searchTools('quantum physics entanglement', index)
    expect(results).toEqual([])
  })

  test('CJK tokenization produces bigrams', async () => {
    // Verify CJK text is tokenized into bigrams (delegated to localSearch.tokenize)
    const { tokenizeAndStem } = await import('../../skillSearch/localSearch.js')
    const tokens = tokenizeAndStem('搜索代码')
    expect(tokens).toContain('搜索')
    expect(tokens).toContain('代码')
  })
})

describe('getToolIndex caching', () => {
  beforeEach(() => {
    clearToolIndexCache()
  })

  test('returns cached index for same tool list', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const first = await getToolIndex(tools)
    const second = await getToolIndex(tools)
    expect(first).toBe(second) // Same reference = cached
  })

  test('rebuilds same-name entries after list_changed definition updates', async () => {
    const firstTools = [
      makeMockTool({
        name: 'mcp__service-a__action',
        prompt: async () => 'Old description.',
        inputJSONSchema: {
          type: 'object',
          properties: { oldField: { type: 'string' } },
        },
      }),
    ] as unknown as import('../../../Tool.js').Tool[]
    const updatedTools = [
      makeMockTool({
        name: 'mcp__service-a__action',
        prompt: async () => 'Updated description.',
        inputJSONSchema: {
          type: 'object',
          properties: { newField: { type: 'number' } },
        },
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const first = await getToolIndex(firstTools)
    const updated = await getToolIndex(updatedTools)

    expect(updated).not.toBe(first)
    expect(updated[0]?.description).toBe('Updated description.')
    expect(updated[0]?.inputSchema).toEqual(updatedTools[0]?.inputJSONSchema)
  })

  test('rebuilds index after clearToolIndexCache', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const first = await getToolIndex(tools)
    clearToolIndexCache()
    const second = await getToolIndex(tools)
    expect(first).not.toBe(second) // Different reference = rebuilt
  })
})

/**
 * Deferred tools are filtered out of the API tools array, so the schema
 * carried here is the model's ONLY view of their parameters before it calls
 * ExecuteExtraTool — which validates against the same schema and rejects both
 * missing required fields and unknown keys. When this returns undefined the
 * model must guess field names, and the call fails deterministically. That was
 * the cause of the reported DiscoverSkills / Monitor parameter errors.
 */
describe('getToolInputJSONSchema', () => {
  test('passes through inputJSONSchema (MCP tools)', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(getToolInputJSONSchema({ inputJSONSchema: schema })).toBe(schema)
  })

  test('converts a zod inputSchema (built-in deferred tools)', async () => {
    const { z } = await import('zod/v4')
    const result = getToolInputJSONSchema({
      inputSchema: z.strictObject({
        description: z.string(),
        limit: z.number().optional(),
      }),
    }) as {
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }

    // The model needs all three facts to build a valid call: which fields
    // exist, which are mandatory, and that extras are rejected.
    expect(Object.keys(result.properties ?? {}).sort()).toEqual([
      'description',
      'limit',
    ])
    expect(result.required).toEqual(['description'])
    expect(result.additionalProperties).toBe(false)
  })

  test('returns undefined when the tool declares no schema', () => {
    expect(getToolInputJSONSchema({})).toBeUndefined()
  })

  test('a broken schema degrades to undefined instead of throwing', () => {
    // Discovery of every other tool must survive one bad schema, so NOTHING
    // in here may propagate — including the property read itself. Built-in
    // tools expose `inputSchema` as a lazy getter, and this is the first path
    // that forces every deferred tool's getter, so a throwing getter is the
    // realistic shape of "one bad tool".
    const explodingGetter = {
      get inputSchema() {
        throw new Error('boom')
      },
    }
    expect(getToolInputJSONSchema(explodingGetter)).toBeUndefined()

    const explodingMcpGetter = {
      get inputJSONSchema(): object {
        throw new Error('boom')
      },
    }
    expect(getToolInputJSONSchema(explodingMcpGetter)).toBeUndefined()

    // A value that isn't a zod schema at all fails inside the conversion.
    expect(
      getToolInputJSONSchema({
        inputSchema: {
          /* not a zod schema */
        },
      }),
    ).toBeUndefined()
  })
})

describe('buildToolIndex carries parameter schemas', () => {
  beforeEach(() => clearToolIndexCache())

  test('indexes a zod schema, not just inputJSONSchema', async () => {
    const { z } = await import('zod/v4')
    const tools = [
      makeMockTool({
        name: 'Monitor',
        prompt: async () => 'Watch a log file.',
        inputSchema: z.strictObject({ command: z.string() }),
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    expect(index).toHaveLength(1)
    // Pre-fix this was undefined for every built-in deferred tool.
    expect(index[0]!.inputSchema).toBeDefined()
    expect(
      Object.keys(
        (index[0]!.inputSchema as { properties: Record<string, unknown> })
          .properties,
      ),
    ).toEqual(['command'])
  })
})
