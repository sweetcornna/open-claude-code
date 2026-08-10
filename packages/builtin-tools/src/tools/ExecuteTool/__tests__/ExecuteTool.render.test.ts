import { describe, expect, test, mock } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

// Only log/debug are stubbed, and both come from tests/mocks (complete
// surfaces). This file used to also stub featureGate, searchExtraTools,
// constants/tools, toolErrors and messages inline — five hand-written partial
// surfaces, none of which any assertion here depends on. Because mock.module
// is process-global and Bun runs a whole shard in one process, the messages
// one (2 of 106 exports) made every later file in packages/builtin-tools that
// imports createAssistantAPIErrorMessage die with "Export named ... not
// found". That was the packages/builtin-tools failure on CI — a shard that had
// never actually run before, because the loop used to abort at the first red
// one. The featureGate stub was also written against a module that now exports
// three names, listing twenty and missing the one that exists
// (registerFeatureGateHost).
//
// Real modules load fine here; the stubs were cargo. Do not reintroduce them —
// `bun run check:mock-hygiene` ratchets this file at zero.
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { ExecuteTool } = await import('../ExecuteTool.js')
const { buildToolDiscoveryAttachment } = await import(
  'src/services/searchExtraTools/prefetch.js'
)
const { extractDiscoveredToolNames } = await import(
  'src/utils/tools/searchExtraTools.js'
)

type RenderResult = React.ReactNode

describe('extractDiscoveredToolNames', () => {
  test('extracts every name from a tool_discovery attachment', () => {
    const attachment = buildToolDiscoveryAttachment(
      [
        {
          name: 'CronCreate',
          description: 'Create a cron job',
          searchHint: 'schedule recurring work',
          score: 0.9,
          isMcp: false,
          isDeferred: true,
          inputSchema: {
            type: 'object',
            properties: { cron: { type: 'string' } },
            required: ['cron'],
          },
        },
        {
          name: 'mcp__calendar__create_event',
          description: 'Create a calendar event',
          searchHint: 'calendar meeting',
          score: 0.8,
          isMcp: true,
          isDeferred: true,
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
        },
      ],
      'assistant_turn',
      'schedule a meeting',
      4,
      20,
    )

    const discovered = extractDiscoveredToolNames([
      {
        type: 'attachment',
        attachment,
        uuid: 'prefetch-discovery',
      },
    ] as never)

    expect(discovered).toEqual(
      new Set(['CronCreate', 'mcp__calendar__create_event']),
    )
  })
})

describe('ExecuteTool prefetch discovery integration', () => {
  test('executes a deferred tool directly after a prefetch attachment', async () => {
    const previousSearchMode = process.env.ENABLE_SEARCH_EXTRA_TOOLS
    const previousBetaKillSwitch =
      process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    process.env.ENABLE_SEARCH_EXTRA_TOOLS = 'true'
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS

    try {
      const call = mock(async () => ({ data: { executed: true } }))
      const targetTool = {
        name: 'PrefetchedTool',
        call,
        checkPermissions: async () => ({ behavior: 'allow' as const }),
        inputSchema: {},
        isEnabled: () => true,
        alwaysLoad: false,
      }
      const searchTool = { name: 'SearchExtraTools' }
      const attachment = buildToolDiscoveryAttachment(
        [
          {
            name: targetTool.name,
            description: 'Run a prefetched operation',
            searchHint: 'prefetched operation',
            score: 0.9,
            isMcp: false,
            isDeferred: true,
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        ],
        'assistant_turn',
        'run the prefetched operation',
        2,
        10,
      )
      const context = {
        messages: [
          {
            type: 'attachment',
            attachment,
            uuid: 'prefetch-discovery',
          },
        ],
        options: { tools: [searchTool, targetTool] },
      } as never

      const result = await ExecuteTool.call(
        {
          tool_name: targetTool.name,
          params: { value: 'ready' },
        },
        context,
        async () => ({ behavior: 'allow' }),
        { type: 'assistant', content: [], uuid: 'assistant' } as never,
        undefined,
      )

      expect(call).toHaveBeenCalledTimes(1)
      expect(result.data).toEqual({
        result: { executed: true },
        tool_name: targetTool.name,
      })
    } finally {
      if (previousSearchMode === undefined) {
        delete process.env.ENABLE_SEARCH_EXTRA_TOOLS
      } else {
        process.env.ENABLE_SEARCH_EXTRA_TOOLS = previousSearchMode
      }
      if (previousBetaKillSwitch === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
      } else {
        process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS =
          previousBetaKillSwitch
      }
    }
  })
})

describe('ExecuteTool.renderToolResultMessage delegation', () => {
  test('delegates to inner tool with content.result and unwrapped params', () => {
    const seen: Array<{
      content: unknown
      input: unknown
    }> = []
    const innerRender = (
      content: unknown,
      _progress: unknown,
      options: { input?: unknown },
    ): RenderResult => {
      seen.push({ content, input: options.input })
      return 'RENDERED' as unknown as RenderResult
    }
    const innerTool = {
      name: 'artifact',
      renderToolResultMessage: innerRender,
    }
    const tools = [innerTool] as never

    const result = ExecuteTool.renderToolResultMessage(
      {
        result: {
          id: 'abc',
          url: 'https://example.com/x.html',
          expiresAt: 'T',
        },
        tool_name: 'artifact',
      },
      [],
      {
        tools,
        input: {
          tool_name: 'artifact',
          params: { file_path: '/tmp/x.html', ttl: 7 },
        },
      } as never,
    )

    expect(result).toBe('RENDERED')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.content).toEqual({
      id: 'abc',
      url: 'https://example.com/x.html',
      expiresAt: 'T',
    })
    // Inner tool should see its own params shape, not the ExecuteExtraTool wrapper
    expect(seen[0]?.input).toEqual({ file_path: '/tmp/x.html', ttl: 7 })
  })

  test('returns null when inner tool has no renderToolResultMessage', () => {
    const innerTool = { name: 'bare' }
    const tools = [innerTool] as never

    const result = ExecuteTool.renderToolResultMessage(
      { result: { ok: true }, tool_name: 'bare' },
      [],
      { tools, input: { tool_name: 'bare', params: {} } } as never,
    )

    expect(result).toBeNull()
  })

  test('returns null when inner tool is not found in tools list', () => {
    const tools = [] as never

    const result = ExecuteTool.renderToolResultMessage(
      { result: { ok: true }, tool_name: 'missing' },
      [],
      { tools, input: { tool_name: 'missing', params: {} } } as never,
    )

    expect(result).toBeNull()
  })

  test('passes through undefined input safely when input is missing', () => {
    const seen: unknown[] = []
    const innerTool = {
      name: 'artifact',
      renderToolResultMessage: (
        _content: unknown,
        _progress: unknown,
        options: { input?: unknown },
      ): RenderResult => {
        seen.push(options.input)
        return null
      },
    }
    const tools = [innerTool] as never

    const result = ExecuteTool.renderToolResultMessage(
      { result: { ok: true }, tool_name: 'artifact' },
      [],
      { tools } as never,
    )

    expect(result).toBeNull()
    expect(seen[0]).toBeUndefined()
  })
})
