/**
 * One API response is split into one AssistantMessage per content block, and
 * the final `usage` / `stop_reason` only arrive on `message_delta`, after the
 * last `content_block_stop`. Backfilling only the tail record leaves every
 * earlier block of a "text + tool_use" or "thinking + text" turn persisted with
 * `stop_reason: null` and `output_tokens: 0` — which is what the transcript
 * then hands to resume, `/context` and anything else that reads a record's own
 * usage.
 *
 * Driven end to end through `queryModelWithStreaming` with a canned SSE body,
 * because the defect lives in the `message_delta` handler's choice of target,
 * not in any extractable helper.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AssistantMessage } from '../../../types/message.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

// MACRO is a build-time define; provide it for bare test runtime (same pattern
// as logoBillingType.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

const settingsMock = setupSettingsMock()

// The developer's own settings.json decides getAPIProvider(); an `openai`
// modelType would route this straight past claude.ts.
beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => ({}) })
})
const savedEnv = { ...process.env }
afterAll(() => {
  settingsMock.reset()
  const fixturesRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  if (fixturesRoot && fixturesRoot.startsWith(tmpdir())) {
    rmSync(fixturesRoot, { recursive: true, force: true })
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

const PROVIDER_ENV_PREFIX =
  /^(OPENAI_|GEMINI_|GOOGLE_|GROK_|XAI_|OPENCODE_|DEEPSEEK_|ANTHROPIC_|CLAUDE_CODE_USE_)/

function toSSE(events: Record<string, unknown>[]): string {
  return events
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

/** A turn with two content blocks, so "last record only" is observable. */
const TWO_BLOCK_RESPONSE: Record<string, unknown>[] = [
  {
    type: 'message_start',
    message: {
      id: 'msg_two_blocks',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-5',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3,
      },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'listing files' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 42 },
  },
  { type: 'message_stop' },
]

async function streamedAssistantMessages(): Promise<AssistantMessage[]> {
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV_PREFIX.test(key)) delete process.env[key]
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  // queryModelWithStreaming always wraps the loop in the VCR cassette layer,
  // which is armed by NODE_ENV=test. Point it at a throwaway root and force
  // record mode so every run misses, executes the real stream loop, and writes
  // nothing into the repo's fixtures/ directory. Without VCR_RECORD the CI
  // branch refuses a cache miss outright.
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = mkdtempSync(
    join(tmpdir(), 'occ-stream-finalization-'),
  )
  process.env.VCR_RECORD = '1'

  const { queryModelWithStreaming } = await import('../claude.js')
  const messages: AssistantMessage[] = []
  for await (const message of queryModelWithStreaming({
    messages: [],
    systemPrompt: ['test'] as never,
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => ({ mode: 'default' }) as never,
      model: 'claude-sonnet-4-5',
      isNonInteractiveSession: true,
      querySource: 'sdk',
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      fetchOverride: (async () =>
        new Response(toSSE(TWO_BLOCK_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as never,
    } as never,
  })) {
    if (message.type === 'assistant') {
      messages.push(message as AssistantMessage)
    }
  }
  return messages
}

describe('streamed response finalization', () => {
  test('backfills stop_reason and usage onto every content block record', async () => {
    const assistants = await streamedAssistantMessages()

    // Guard the fixture itself: a single record would make the assertions
    // below vacuous.
    expect(assistants.length).toBe(2)
    expect(assistants.every(m => m.message.id === 'msg_two_blocks')).toBe(true)

    for (const message of assistants) {
      expect(message.message.stop_reason).toBe('tool_use')
      expect(message.message.usage?.output_tokens).toBe(42)
      expect(message.message.usage?.cache_read_input_tokens).toBe(3)
    }
  })
})
