import * as realToolConstants from 'src/constants/tools.js'
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

// Spread the real module: CORE_TOOLS and COORDINATOR_MODE_ALLOWED_TOOLS are
// not overridden here, and leaving them out made CORE_TOOLS `undefined` for
// every later file in the packages/builtin-tools shard — SearchExtraToolsTool's
// isDeferred() reads it at call time. constants/tools.ts is a pure leaf (the
// prompt-purity ratchet enforces that), so importing it costs nothing.
mock.module('src/constants/tools.js', () => ({
  ...realToolConstants,
  ALL_AGENT_DISALLOWED_TOOLS: new Set(),
  ASYNC_AGENT_ALLOWED_TOOLS: new Set(),
  CUSTOM_AGENT_DISALLOWED_TOOLS: new Set(),
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS: new Set(),
}))

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

// messages.ts is complex - provide stubs for all named exports
mock.module('src/utils/messages.ts', () => ({
  extractTextContent: (content: any[]) =>
    content
      ?.filter?.((b: any) => b.type === 'text')
      ?.map?.((b: any) => b.text)
      ?.join('') ?? '',
  getLastAssistantMessage: () => null,
  SYNTHETIC_MESSAGES: new Set(),
  INTERRUPT_MESSAGE: '',
  INTERRUPT_MESSAGE_FOR_TOOL_USE: '',
  CANCEL_MESSAGE: '',
  REJECT_MESSAGE: '',
  REJECT_MESSAGE_WITH_REASON_PREFIX: '',
  SUBAGENT_REJECT_MESSAGE: '',
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX: '',
  PLAN_REJECTION_PREFIX: '',
  DENIAL_WORKAROUND_GUIDANCE: '',
  NO_RESPONSE_REQUESTED: '',
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER: '',
  SYNTHETIC_MODEL: '',
  AUTO_REJECT_MESSAGE: noop,
  DONT_ASK_REJECT_MESSAGE: noop,
  withMemoryCorrectionHint: (s: string) => s,
  deriveShortMessageId: () => '',
  isClassifierDenial: () => false,
  buildYoloRejectionMessage: () => '',
  buildClassifierUnavailableMessage: () => '',
  isEmptyMessageText: () => true,
  createAssistantMessage: noop,
  createAssistantAPIErrorMessage: noop,
  createUserMessage: noop,
  prepareUserContent: noop,
  createUserInterruptionMessage: noop,
  createSyntheticUserCaveatMessage: noop,
  formatCommandInputTags: noop,
}))

mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  completeAgentTask: noop,
  createActivityDescriptionResolver: () => ({}),
  createProgressTracker: () => ({}),
  enqueueAgentNotification: noop,
  failAgentTask: noop,
  getProgressUpdate: () => ({ tokenCount: 0, toolUseCount: 0 }),
  getTokenCountFromTracker: () => 0,
  isLocalAgentTask: () => false,
  killAsyncAgent: noop,
  updateAgentProgress: noop,
  updateProgressFromMessage: noop,
}))

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

// Break circular dep
mock.module('src/tools/AgentTool/AgentTool.tsx', () => ({
  AgentTool: {},
  inputSchema: {},
  outputSchema: {},
  default: {},
}))

const { countToolUses, getLastToolUseName } = await import('../agentToolUtils')

function makeAssistantMessage(content: any[]): any {
  return { type: 'assistant', message: { content } }
}

function makeUserMessage(text: string): any {
  return { type: 'user', message: { content: text } }
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
