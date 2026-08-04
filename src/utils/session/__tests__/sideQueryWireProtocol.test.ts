/**
 * Side queries must speak the same wire protocol as the main loop.
 *
 * Regression: `OPENAI_WIRE_API=responses` only moved the main loop. Every side
 * query (classifiers, title generation, model validation, …) still went out as
 * Chat Completions, so a Responses-only upstream rejected them — the session
 * looked configured for `/responses` while half its traffic was not.
 *
 * The check is end-to-end over a real local HTTP server: what matters is the
 * PATH the request lands on, which no amount of function-level mocking proves.
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
let server: ReturnType<typeof Bun.serve> | undefined
let requestBodies: Array<Record<string, unknown>> = []

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

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      hits.push(url.pathname)
      requestBodies.push((await request.json()) as Record<string, unknown>)
      if (url.pathname.endsWith('/responses')) {
        return new Response(RESPONSES_SSE, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response(CHAT_COMPLETION_JSON, {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`
  process.env.OPENAI_MODEL = 'test-model'
  delete process.env.OPENAI_AUTH_MODE
})

afterEach(() => {
  hits.length = 0
  requestBodies = []
})

afterAll(() => {
  server?.stop(true)
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function runSideQuery(): Promise<void> {
  const { sideQuery } = await import('../sideQuery.js')
  await sideQuery({
    model: 'test-model',
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

  test('OPENAI_WIRE_API=chat keeps side queries on Chat Completions', async () => {
    process.env.OPENAI_WIRE_API = 'chat'
    await runSideQuery()
    expect(hits).toEqual(['/v1/chat/completions'])
  })

  test('a Codex-family model defaults to /responses without an explicit setting', async () => {
    delete process.env.OPENAI_WIRE_API
    process.env.OPENAI_MODEL = 'gpt-5-codex'
    try {
      await runSideQuery()
      expect(hits).toEqual(['/v1/responses'])
    } finally {
      process.env.OPENAI_MODEL = 'test-model'
    }
  })
})
