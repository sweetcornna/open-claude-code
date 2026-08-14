import { afterAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { setupAgentSummaryMock } from '../../../../../../tests/mocks/agentSummary.js'
import { setupDumpPromptsMock } from '../../../../../../tests/mocks/dumpPrompts.js'
import { setupYoloClassifierMock } from '../../../../../../tests/mocks/yoloClassifier.js'
import { setupSdkProgressMock } from '../../../../../../tests/mocks/sdkProgress.js'
import { setupToolRuntimeAnalyticsMock } from '../../../../../../tests/mocks/toolRuntimeAnalytics.js'

// ─── Mocks for agentToolUtils.ts dependencies ───
// Only mock modules that are truly unavailable or cause side effects.
//
// Do NOT stub src/Tool.js here. It is a pure re-export barrel over
// @open-claude-code/tool-runtime/Tool.js, and on Linux a mock.module on the
// barrel replaces the underlying package module too — a stubbed
// `findToolByName: () => {}` / `toolMatchesName: () => false` then applies to
// every later file in the packages/builtin-tools shard. That is what made
// SearchExtraToolsTool's select: path find nothing (matches: [], and so no
// already_loaded and no schemas) on CI while passing on macOS, where the same
// mock demonstrably does NOT reach the package module. Local experiments lie
// about this one; the real functions are trivial and pure, so just use them.
// Do NOT mock common/shared modules (zod/v4, bootstrap/state, etc.) to avoid
// corrupting the module cache for other test files in the same Bun process.

const noop = () => {}

mock.module('bun:bundle', () => ({ feature: () => false }))

const agentSummaryMock = setupAgentSummaryMock({
  startAgentSummarization: () => ({ stop: () => {} }),
})
afterAll(() => agentSummaryMock.reset())

// Only logEvent is a real export here; the hand-rolled surface this replaced
// also listed attachAnalyticsSink, _resetForTesting and a TYPE name used as a
// value — none of which exist on tool-runtime/analytics.
const toolRuntimeAnalyticsMock = setupToolRuntimeAnalyticsMock({
  logEvent: noop,
})
afterAll(() => toolRuntimeAnalyticsMock.reset())

const dumpPromptsMock = setupDumpPromptsMock({
  clearDumpState: noop,
})
afterAll(() => dumpPromptsMock.reset())

mock.module('src/utils/telemetry/debug.ts', debugMock)

const yoloClassifierMock = setupYoloClassifierMock({
  buildTranscriptForClassifier: () => '',
  classifyYoloAction: async () => ({}),
})
afterAll(() => yoloClassifierMock.reset())

const sdkProgressMock = setupSdkProgressMock({
  emitTaskProgress: noop,
})
afterAll(() => sdkProgressMock.reset())

const {
  countToolUses,
  finalizeAgentTool,
  findMaxTurnsTruncation,
  getLastToolUseName,
} = await import('../agentToolUtils')

function makeAssistantMessage(content: any[]): any {
  return { type: 'assistant', message: { content } }
}

function makeUserMessage(text: string): any {
  return { type: 'user', message: { content: text } }
}

function makeMaxTurnsAttachment(maxTurns: number, turnCount: number): any {
  return {
    type: 'attachment',
    attachment: { type: 'max_turns_reached', maxTurns, turnCount },
  }
}

const FINALIZE_METADATA = {
  prompt: 'test',
  resolvedAgentModel: 'test-model',
  isBuiltInAgent: false,
  startTime: Date.now(),
  agentType: 'test',
  isAsync: false,
}

describe('countToolUses', () => {
  test('counts tool_use blocks in messages', () => {
    const messages = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'Read' },
        { type: 'text', text: 'hello' },
      ]),
    ]
    expect(countToolUses(messages)).toBe(1)
  })

  test('returns 0 for messages without tool_use', () => {
    const messages = [makeAssistantMessage([{ type: 'text', text: 'hello' }])]
    expect(countToolUses(messages)).toBe(0)
  })

  test('returns 0 for empty array', () => {
    expect(countToolUses([])).toBe(0)
  })

  test('counts multiple tool_use blocks across messages', () => {
    const messages = [
      makeAssistantMessage([{ type: 'tool_use', name: 'Read' }]),
      makeUserMessage('ok'),
      makeAssistantMessage([{ type: 'tool_use', name: 'Write' }]),
    ]
    expect(countToolUses(messages)).toBe(2)
  })

  test('counts tool_use in single message with multiple blocks', () => {
    const messages = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Grep' },
        { type: 'tool_use', name: 'Write' },
      ]),
    ]
    expect(countToolUses(messages)).toBe(3)
  })
})

describe('finalizeAgentTool', () => {
  test('rejects whitespace-only output instead of returning empty content', () => {
    expect(() =>
      finalizeAgentTool(
        [makeAssistantMessage([{ type: 'text', text: '   ' }])],
        'agent-empty',
        FINALIZE_METADATA,
      ),
    ).toThrow('Agent returned an empty response.')
  })

  // Regression: a subagent truncated by `maxTurns:` frontmatter used to return
  // its partial answer with no marker at all — runAgent swallowed the
  // max_turns_reached attachment and allowlisted the 'max_turns' terminal, so
  // the parent model could not tell a cut-off run from a finished one.
  test('marks the result as partial when the agent hit its turn limit', () => {
    const result = finalizeAgentTool(
      [
        makeAssistantMessage([{ type: 'text', text: 'partial findings' }]),
        makeMaxTurnsAttachment(12, 13),
      ],
      'agent-truncated',
      FINALIZE_METADATA,
    )
    const texts = (result.content as any[]).map(b => b.text)
    expect(texts[0]).toBe('partial findings')
    expect(texts.at(-1)).toContain('12-turn limit')
    expect(texts.at(-1)).toContain('turn 13')
    expect(texts.at(-1)).toContain('incomplete')
  })

  test('leaves a normally completed agent result untouched', () => {
    const result = finalizeAgentTool(
      [makeAssistantMessage([{ type: 'text', text: 'all done' }])],
      'agent-complete',
      FINALIZE_METADATA,
    )
    expect((result.content as any[]).map(b => b.text)).toEqual(['all done'])
  })
})

describe('findMaxTurnsTruncation', () => {
  test('finds the attachment anywhere in the message list', () => {
    expect(
      findMaxTurnsTruncation([
        makeMaxTurnsAttachment(3, 4),
        makeAssistantMessage([{ type: 'text', text: 'x' }]),
      ]),
    ).toEqual({ maxTurns: 3, turnCount: 4 })
  })

  test('returns undefined when the agent ran to completion', () => {
    expect(
      findMaxTurnsTruncation([
        makeAssistantMessage([{ type: 'text', text: 'x' }]),
      ]),
    ).toBeUndefined()
  })

  test('ignores unrelated attachments', () => {
    expect(
      findMaxTurnsTruncation([
        { type: 'attachment', attachment: { type: 'todo_reminder' } } as any,
      ]),
    ).toBeUndefined()
  })
})

describe('getLastToolUseName', () => {
  test('returns last tool name from assistant message', () => {
    const msg = makeAssistantMessage([
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Write' },
    ])
    expect(getLastToolUseName(msg)).toBe('Write')
  })

  test('returns undefined for message without tool_use', () => {
    const msg = makeAssistantMessage([{ type: 'text', text: 'hello' }])
    expect(getLastToolUseName(msg)).toBeUndefined()
  })

  test('returns the last tool when multiple tool_uses present', () => {
    const msg = makeAssistantMessage([
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Grep' },
      { type: 'tool_use', name: 'Edit' },
    ])
    expect(getLastToolUseName(msg)).toBe('Edit')
  })

  test('returns undefined for non-assistant message', () => {
    const msg = makeUserMessage('hello')
    expect(getLastToolUseName(msg)).toBeUndefined()
  })

  test('handles message with null content', () => {
    const msg = { type: 'assistant', message: { content: null } } as any
    expect(getLastToolUseName(msg)).toBeUndefined()
  })
})
