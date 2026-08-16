/**
 * The OpenAI chat and Grok lanes must not wait forever on a stream that opens
 * and then goes quiet.
 *
 * Both lanes hand the SDK's chunk iterator straight to
 * `adaptOpenAIStreamToAnthropic`, and the SDK's own `timeout` only covers the
 * headers (openai 6.x clears that timer once the fetch resolves). Before the
 * watchdog, a stalled response had no deadline at all — the turn sat there
 * until the user pressed Esc, which for an auto-compact means a session that
 * appears to have frozen for no stated reason.
 *
 * Hermetic by construction: every request goes through `options.fetchOverride`,
 * so no client is cached and nothing reaches a provider. The base URLs are
 * pinned to a dead loopback port as a second line of defence — if the override
 * ever stopped being honoured, the test fails rather than dialling out.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import type { Options } from '../claude.js'
import { queryModelGrok } from '../grok/index.js'
import { queryModelOpenAI } from '../openai/index.js'
import { asSystemPrompt } from '../../../utils/session/systemPromptType.js'

const MANAGED_ENV =
  /^(OPENAI_|GROK_|XAI_|OPENCODE_|ANTHROPIC_|GEMINI_|CLAUDE_CODE_|CLAUDE_STREAM_|ENABLE_SEARCH_EXTRA_TOOLS$)/

const USER_MESSAGE = {
  type: 'user',
  uuid: 'u1',
  message: { role: 'user', content: 'hi' },
} as unknown as Message

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function deltaChunk(model: string, delta: Record<string, unknown>): string {
  return chunk({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  })
}

function finishChunk(model: string): string {
  return chunk({
    id: 'chunk-2',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
}

type FakeEndpoint = {
  fetchOverride: typeof fetch
  /** How many times the lane put a request on the wire. */
  requests: () => number
  /** How many of those requests had their transport aborted. */
  aborts: () => number
}

/** A response that emits `head`, then never writes another byte. */
function stallingEndpoint(head: string): FakeEndpoint {
  let requests = 0
  let aborts = 0
  const fetchOverride = (async (_input: unknown, init?: RequestInit) => {
    requests++
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(head))
        init?.signal?.addEventListener('abort', () => {
          aborts++
          try {
            controller.error(new Error('request aborted'))
          } catch {
            // Already errored by an earlier abort; nothing to do.
          }
        })
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  return { fetchOverride, requests: () => requests, aborts: () => aborts }
}

/** A response that completes normally. */
function completeEndpoint(body: string): FakeEndpoint {
  let requests = 0
  const fetchOverride = (async () => {
    requests++
    return new Response(`${body}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  return { fetchOverride, requests: () => requests, aborts: () => 0 }
}

async function drain(
  stream: AsyncGenerator<unknown, void>,
): Promise<Record<string, unknown>[]> {
  const outputs: Record<string, unknown>[] = []
  for await (const output of stream) {
    outputs.push(output as Record<string, unknown>)
  }
  return outputs
}

function renderedText(outputs: Record<string, unknown>[]): string {
  return outputs
    .filter(output => output.type === 'assistant')
    .flatMap(output => {
      const content = (output.message as { content?: unknown })?.content
      return Array.isArray(content) ? content : []
    })
    .map(block => (block as { text?: string }).text ?? '')
    .join('\n')
}

describe('third-party chat stream idle watchdog', () => {
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const key of Object.keys(process.env)) {
      if (MANAGED_ENV.test(key)) {
        saved[key] = process.env[key]
        delete process.env[key]
      }
    }
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'
    process.env.GROK_API_KEY = 'test-grok-key'
    process.env.GROK_BASE_URL = 'http://127.0.0.1:1/v1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '50'
    // One retry, so the assertion below distinguishes "gave up" from "never
    // noticed" without paying the default ladder's ten backoffs.
    process.env.CLAUDE_CODE_MAX_RETRIES = '1'
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (MANAGED_ENV.test(key)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value
    }
  })

  test('OpenAI chat: a stream that stalls after one chunk fails instead of hanging', async () => {
    const endpoint = stallingEndpoint(
      deltaChunk('gpt-test', { role: 'assistant' }),
    )

    const outputs = await drain(
      queryModelOpenAI(
        [USER_MESSAGE],
        asSystemPrompt(['sys']),
        [],
        new AbortController().signal,
        {
          model: 'gpt-test',
          querySource: 'repl_main_thread',
          fetchOverride: endpoint.fetchOverride,
        } as unknown as Options,
      ),
    )

    expect(renderedText(outputs)).toContain(
      'OpenAI Chat stream idle timeout after 50ms',
    )
    // Re-sent once and then given up on: the watchdog produces an ordinary
    // retryable failure, not a special case.
    expect(endpoint.requests()).toBe(2)
    // Every stalled request had its transport cut; leaving them draining in the
    // background is how one hung turn becomes several.
    expect(endpoint.aborts()).toBe(2)
  }, 30_000)

  test('OpenAI chat: a stream that keeps flowing is untouched', async () => {
    const endpoint = completeEndpoint(
      deltaChunk('gpt-test', { role: 'assistant', content: 'hello' }) +
        finishChunk('gpt-test'),
    )

    const outputs = await drain(
      queryModelOpenAI(
        [USER_MESSAGE],
        asSystemPrompt(['sys']),
        [],
        new AbortController().signal,
        {
          model: 'gpt-test',
          querySource: 'repl_main_thread',
          fetchOverride: endpoint.fetchOverride,
        } as unknown as Options,
      ),
    )

    expect(renderedText(outputs)).toBe('hello')
    expect(endpoint.requests()).toBe(1)
  }, 30_000)

  test('Grok: a stream that stalls after one chunk fails instead of hanging', async () => {
    const endpoint = stallingEndpoint(
      deltaChunk('grok-test', { role: 'assistant' }),
    )

    const outputs = await drain(
      queryModelGrok(
        [USER_MESSAGE],
        asSystemPrompt(['sys']),
        [],
        new AbortController().signal,
        {
          model: 'grok-test',
          querySource: 'repl_main_thread',
          fetchOverride: endpoint.fetchOverride,
        } as unknown as Options,
      ),
    )

    expect(renderedText(outputs)).toContain(
      'Grok stream idle timeout after 50ms',
    )
    expect(endpoint.requests()).toBe(2)
    expect(endpoint.aborts()).toBe(2)
  }, 30_000)

  test('Grok: a stream that keeps flowing is untouched', async () => {
    const endpoint = completeEndpoint(
      deltaChunk('grok-test', { role: 'assistant', content: 'hello' }) +
        finishChunk('grok-test'),
    )

    const outputs = await drain(
      queryModelGrok(
        [USER_MESSAGE],
        asSystemPrompt(['sys']),
        [],
        new AbortController().signal,
        {
          model: 'grok-test',
          querySource: 'repl_main_thread',
          fetchOverride: endpoint.fetchOverride,
        } as unknown as Options,
      ),
    )

    expect(renderedText(outputs)).toBe('hello')
    expect(endpoint.requests()).toBe(1)
  }, 30_000)
})
