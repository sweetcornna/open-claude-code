/**
 * Side queries must speak the same wire protocol as the main loop.
 *
 * Regression: `OPENAI_WIRE_API=responses` only moved the main loop. Every side
 * query (classifiers, title generation, model validation, …) still went out as
 * Chat Completions, so a Responses-only upstream rejected them — the session
 * looked configured for `/responses` while half its traffic was not.
 *
 * The check captures the real fetch boundary: what matters is the URL path and
 * request body produced after the complete side-query routing stack runs.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const RESPONSES_SSE = [
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
  'data: [DONE]\n\n',
].join('')

const CHAT_COMPLETION_JSON = JSON.stringify({
  id: 'chatcmpl-test',
  choices: [
    { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1 },
})

const hits: string[] = []
let requestBodies: Array<Record<string, unknown>> = []
let originalFetch: typeof globalThis.fetch

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_AUTH_MODE',
] as const

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    hits.push(url.pathname)
    const body =
      input instanceof Request
        ? await input.clone().text()
        : typeof init?.body === 'string'
          ? init.body
          : ''
    requestBodies.push(
      body ? (JSON.parse(body) as Record<string, unknown>) : {},
    )
    if (url.pathname.endsWith('/responses')) {
      return new Response(RESPONSES_SSE, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    return new Response(CHAT_COMPLETION_JSON, {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.OPENAI_BASE_URL = 'http://openai.test/v1'
  process.env.OPENAI_MODEL = 'test-model'
  delete process.env.OPENAI_AUTH_MODE
})

afterEach(() => {
  hits.length = 0
  requestBodies = []
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  const { clearOpenAIClientCache } = await import(
    '../../../services/api/openai/client.js'
  )
  clearOpenAIClientCache()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function runSideQuery(model = 'test-model'): Promise<void> {
  const { sideQuery } = await import('../sideQuery.js')
  await sideQuery({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    querySource: 'model_validation',
  })
}

describe('sideQuery wire protocol', () => {
  test('OPENAI_WIRE_API=responses sends side queries to /responses', async () => {
    process.env.OPENAI_WIRE_API = 'responses'
    await runSideQuery()
    expect(hits).toEqual(['/v1/responses'])
  })

  test('the /responses body carries an output-token budget big enough for reasoning', async () => {
    process.env.OPENAI_WIRE_API = 'responses'
    await runSideQuery()
    // max_tokens: 16 would be entirely consumed by reasoning tokens.
    expect(requestBodies[0]?.max_output_tokens).toBe(4096)
  })

  test('GPT-family responses side queries explicitly use low reasoning', async () => {
    process.env.OPENAI_WIRE_API = 'responses'
    await runSideQuery('gpt-5.6-sol')
    expect(requestBodies[0]?.reasoning).toEqual({ effort: 'low' })
  })

  test('OPENAI_WIRE_API=chat keeps side queries on Chat Completions', async () => {
    process.env.OPENAI_WIRE_API = 'chat'
    await runSideQuery()
    expect(hits).toEqual(['/v1/chat/completions'])
  })

  test('a Codex-family model defaults to /responses without an explicit setting', async () => {
    delete process.env.OPENAI_WIRE_API
    await runSideQuery('gpt-5-codex')
    expect(hits).toEqual(['/v1/responses'])
  })
})
