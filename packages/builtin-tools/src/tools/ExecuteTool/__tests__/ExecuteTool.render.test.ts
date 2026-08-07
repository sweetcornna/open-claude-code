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

type RenderResult = React.ReactNode

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
