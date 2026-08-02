import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import {
  isMcpSamplingEnabled,
  registerSamplingHandler,
  resetSamplingCallCount,
} from '../samplingHandler.js'

type Handler = (
  request: { params?: unknown },
  ctx: { mcpReq: { signal: AbortSignal } },
) => Promise<Record<string, unknown>>

function makeFakeClient(): {
  client: { setRequestHandler: (method: string, handler: Handler) => void }
  handlers: Map<string, Handler>
} {
  const handlers = new Map<string, Handler>()
  return {
    client: {
      setRequestHandler: (method, handler) => handlers.set(method, handler),
    },
    handlers,
  }
}

const okSampler = (async (opts: { max_tokens?: number; model: string }) => ({
  content: [{ type: 'text', text: 'sampled response' }],
  model: opts.model,
  stop_reason: 'end_turn',
})) as unknown as Parameters<typeof registerSamplingHandler>[2] extends {
  sampler?: infer S
}
  ? S
  : never

const CTX = { mcpReq: { signal: new AbortController().signal } }

describe('samplingHandler', () => {
  const savedEnv = process.env.OCC_MCP_SAMPLING

  beforeEach(() => {
    resetSamplingCallCount()
    process.env.OCC_MCP_SAMPLING = '1'
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OCC_MCP_SAMPLING
    else process.env.OCC_MCP_SAMPLING = savedEnv
  })

  test('disabled by default (no OCC_MCP_SAMPLING)', () => {
    delete process.env.OCC_MCP_SAMPLING
    expect(isMcpSamplingEnabled()).toBe(false)
    const { client, handlers } = makeFakeClient()
    registerSamplingHandler(client as never, 'srv')
    expect(handlers.size).toBe(0)
  })

  test('registers handler and returns a CreateMessageResult', async () => {
    const { client, handlers } = makeFakeClient()
    registerSamplingHandler(client as never, 'srv', {
      sampler: okSampler,
      resolveModel: () => 'small-model',
    })
    const handler = handlers.get('sampling/createMessage')
    expect(handler).toBeDefined()

    const result = await handler!(
      {
        params: {
          messages: [
            { role: 'user', content: { type: 'text', text: 'hello' } },
          ],
          maxTokens: 256,
        },
      },
      CTX,
    )

    expect(result).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'sampled response' },
      model: 'small-model',
      stopReason: 'endTurn',
    })
  })

  test('clamps maxTokens and rejects message lists without text', async () => {
    let capturedMaxTokens = 0
    const capturingSampler = (async (opts: {
      max_tokens?: number
      model: string
    }) => {
      capturedMaxTokens = opts.max_tokens ?? 0
      return {
        content: [{ type: 'text', text: 'x' }],
        model: opts.model,
        stop_reason: 'max_tokens',
      }
    }) as never
    const { client, handlers } = makeFakeClient()
    registerSamplingHandler(client as never, 'srv', {
      sampler: capturingSampler,
      resolveModel: () => 'small-model',
    })
    const handler = handlers.get('sampling/createMessage')!

    const result = await handler(
      {
        params: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          ],
          maxTokens: 999_999,
        },
      },
      CTX,
    )
    expect(capturedMaxTokens).toBe(4096)
    expect(result.stopReason).toBe('maxTokens')

    await expect(
      handler(
        { params: { messages: [{ role: 'user', content: [] }] } },
        CTX,
      ),
    ).rejects.toThrow('at least one text message')
  })

  test('enforces the per-session call cap', async () => {
    const { client, handlers } = makeFakeClient()
    registerSamplingHandler(client as never, 'srv', {
      sampler: okSampler,
      resolveModel: () => 'small-model',
    })
    const handler = handlers.get('sampling/createMessage')!
    const request = {
      params: {
        messages: [{ role: 'user', content: { type: 'text', text: 'go' } }],
      },
    }
    for (let i = 0; i < 100; i++) {
      await handler(request, CTX)
    }
    await expect(handler(request, CTX)).rejects.toThrow(
      'MCP sampling limit reached',
    )
  })
})
