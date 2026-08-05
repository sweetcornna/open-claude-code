import { describe, expect, mock, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { authMockWith } from '../../../../tests/mocks/auth.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/auth/auth.js', authMockWith())
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

import {
  CannotRetryError,
  getDefaultMaxRetries,
  isTransientNetworkError,
  isTransientNetworkErrorText,
  markTransientRetriesExhausted,
  withRetry,
  withTransientNetworkRetry,
} from '../withRetry.js'

describe('withRetry context overflow adjustment', () => {
  test('does not retry when thinking alone exceeds the remaining context', async () => {
    const overflow = new APIError(
      400,
      {
        error: {
          message:
            'input length and `max_tokens` exceed context limit: 195000 + 20000 > 200000',
        },
      },
      'input length and `max_tokens` exceed context limit: 195000 + 20000 > 200000',
      new Headers(),
    )
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async (_client, _attempt, context) => {
        calls++
        if (calls === 1) throw overflow
        return context.maxTokensOverride
      },
      {
        maxRetries: 1,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'enabled', budgetTokens: 5_000 },
      },
    )

    await expect(generator.next()).rejects.toBe(overflow)
    expect(calls).toBe(1)
  })

  test('caps a retry max_tokens value at the remaining context', async () => {
    const overflow = new APIError(
      400,
      {
        error: {
          message:
            'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
        },
      },
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
      new Headers(),
    )
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async (_client, _attempt, context) => {
        calls++
        if (calls === 1) throw overflow
        return context.maxTokensOverride
      },
      {
        maxRetries: 1,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'enabled', budgetTokens: 3_000 },
      },
    )

    const result = await generator.next()
    expect(result).toEqual({ done: true, value: 9_000 })
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Transient network error handling
// ---------------------------------------------------------------------------

/** Builds an error whose real code only shows up down the `cause` chain. */
function withCause(message: string, cause: Error): Error {
  const error = new Error(message)
  error.cause = cause
  return error
}

function codedError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

type StreamItem = { type: string; [key: string]: unknown }

function apiErrorMessage(text: string): StreamItem {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function textDelta(text: string): StreamItem {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }
}

function assistantMessage(text: string): StreamItem {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

async function collect(
  generator: AsyncGenerator<StreamItem, void>,
): Promise<StreamItem[]> {
  const out: StreamItem[] = []
  for await (const item of generator) {
    out.push(item)
  }
  return out
}

describe('isTransientNetworkError', () => {
  test('matches bare Bun/undici transport failures', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientNetworkError(new Error('terminated'))).toBe(true)
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isTransientNetworkError(new Error('Body Timeout Error'))).toBe(true)
    expect(isTransientNetworkError(new Error('Premature close'))).toBe(true)
  })

  test('matches errno codes carried on the error itself', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'UND_ERR_SOCKET',
      'UND_ERR_HEADERS_TIMEOUT',
    ]) {
      expect(isTransientNetworkError(codedError(code))).toBe(true)
    }
  })

  test('walks the cause chain for the real code', () => {
    const nested = withCause(
      'fetch failed',
      withCause('upstream', codedError('ECONNRESET', 'read ECONNRESET')),
    )
    expect(isTransientNetworkError(nested)).toBe(true)
  })

  test('walks the cause chain for message-only failures', () => {
    const nested = withCause('request failed', new Error('other side closed'))
    expect(isTransientNetworkError(nested)).toBe(true)
  })

  test('classifies APIConnectionError with a transport cause', () => {
    const error = new APIConnectionError({
      message: 'Connection error.',
      cause: codedError('ETIMEDOUT'),
    })
    expect(isTransientNetworkError(error)).toBe(true)
  })

  test('never retries user aborts', () => {
    expect(isTransientNetworkError(new APIUserAbortError())).toBe(false)
    expect(isTransientNetworkError(new Error('Request was aborted.'))).toBe(
      false,
    )
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    expect(isTransientNetworkError(abortError)).toBe(false)
  })

  test('an outer transport failure outranks a nested abort message', () => {
    const nested = withCause(
      'fetch failed',
      new Error('The operation was aborted'),
    )
    // Documents the precedence rather than asserting it is desirable: the outer
    // `fetch failed` matches before the chain walk reaches the abort text. Real
    // aborts never rely on this — both retry loops check `signal.aborted`
    // before sleeping, and APIUserAbortError is rejected outright above.
    expect(isTransientNetworkError(nested)).toBe(true)
  })

  test('does not retry deterministic failures', () => {
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
    expect(isTransientNetworkError(new Error('Prompt is too long'))).toBe(false)
    expect(isTransientNetworkError(codedError('CERT_HAS_EXPIRED'))).toBe(false)
    expect(
      isTransientNetworkError(
        new APIError(400, undefined, 'invalid_request_error', new Headers()),
      ),
    ).toBe(false)
  })

  test('never retries a TLS handshake failure', () => {
    // Must fail in seconds so getSSLErrorHint's NODE_EXTRA_CA_CERTS advice is
    // actionable, instead of after a ~3 minute backoff ladder.
    expect(
      isTransientNetworkError(
        codedError('EPROTO', 'write EPROTO ssl/tls alert handshake failure'),
      ),
    ).toBe(false)
    expect(
      isTransientNetworkError(codedError('ERR_SSL_PACKET_LENGTH_TOO_LONG')),
    ).toBe(false)
    expect(
      isTransientNetworkError(codedError('ERR_SSL_WRONG_VERSION_NUMBER')),
    ).toBe(false)
    expect(
      isTransientNetworkError(codedError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
    ).toBe(false)
    expect(
      isTransientNetworkError(codedError('DEPTH_ZERO_SELF_SIGNED_CERT')),
    ).toBe(false)
    // Even nested behind a wrapper whose message would otherwise match.
    expect(
      isTransientNetworkError(
        withCause(
          'fetch failed',
          codedError('EPROTO', 'write EPROTO ssl/tls alert handshake failure'),
        ),
      ),
    ).toBe(false)
  })

  test('retries the stream deaths claude.ts throws itself', () => {
    expect(
      isTransientNetworkError(
        new Error('Stream idle timeout - no chunks received'),
      ),
    ).toBe(true)
    expect(
      isTransientNetworkError(
        new Error('Stream ended without receiving any events'),
      ),
    ).toBe(true)
  })
})

describe('isTransientNetworkErrorText', () => {
  test('matches the API Error text queryModel yields', () => {
    for (const text of [
      'API Error: fetch failed',
      'API Error: terminated',
      'API Error: Upstream request failed',
      'API Error: Responses API request failed (502): bad gateway',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      'API Error: 503 Service Unavailable',
      'API Error: Connection error.',
      'API Error: no healthy upstream',
    ]) {
      expect(isTransientNetworkErrorText(text)).toBe(true)
    }
  })

  test('matches the stream deaths claude.ts throws itself', () => {
    // Only reachable text when CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1.
    expect(
      isTransientNetworkErrorText(
        'API Error: Stream idle timeout - no chunks received',
      ),
    ).toBe(true)
    expect(
      isTransientNetworkErrorText(
        'API Error: Stream ended without receiving any events',
      ),
    ).toBe(true)
  })

  test('reads statuses only from producer-anchored positions', () => {
    // Every hand-rolled 3P fetch writes `<label> request failed (<status>...`.
    expect(
      isTransientNetworkErrorText(
        'API Error: Gemini API request failed (503 Service Unavailable): upstream',
      ),
    ).toBe(true)
    expect(
      isTransientNetworkErrorText(
        'API Error: ChatGPT token request failed (429)',
      ),
    ).toBe(true)
    // ...and the same anchor with a permanent status must NOT match.
    expect(
      isTransientNetworkErrorText(
        'API Error: Gemini API request failed (400 Bad Request): invalid argument',
      ),
    ).toBe(false)
    expect(
      isTransientNetworkErrorText(
        'API Error: Responses API request failed (404): model not found',
      ),
    ).toBe(false)
  })

  test('a transient status buried in a 4xx response body is not a retry signal', () => {
    // The regression this anchoring exists for: free-scanning the text turns a
    // permanent 400 into ~3 minutes of backoff because its body says "500".
    for (const text of [
      'API Error: 400 {"error":{"message":"exceeded the 500 output token maximum"}}',
      'API Error: 400 {"error":{"message":"max_tokens: must be <= 502"}}',
      'API Error: Responses API request failed (400): {"error":{"message":"input exceeds 429 tokens"}}',
      'API Error: 422 {"error":{"message":"expected 503 items, got 2"}}',
    ]) {
      expect(isTransientNetworkErrorText(text)).toBe(false)
    }
  })

  test('leaves deterministic failures alone', () => {
    for (const text of [
      '',
      'API Error: Request was aborted.',
      'Prompt is too long',
      'API Error: 400 {"type":"invalid_request_error"}',
      'API Error: 401 {"type":"authentication_error"}',
      'API Error: 403 {"type":"permission_error"}',
      'API Error: 404 {"type":"not_found_error"}',
      'API Error: 413 {"type":"request_too_large"}',
      'API Error: The model has reached its context window limit.',
      'API Error (claude-opus-4-6): 400 {"type":"invalid_request_error"}',
      'Please run /login · API Error: 401 {"type":"authentication_error"}',
      'input length and `max_tokens` exceed context limit: 195000 + 20000 > 200000',
    ]) {
      expect(isTransientNetworkErrorText(text)).toBe(false)
    }
  })
})

describe('withRetry with bare (non-APIError) transport failures', () => {
  test('retries a bare TypeError and reports each wait', async () => {
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        if (calls < 3) throw new TypeError('fetch failed')
        return 'ok'
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )

    const retryNotices = []
    let step = await generator.next()
    while (!step.done) {
      retryNotices.push(step.value)
      step = await generator.next()
    }

    expect(calls).toBe(3)
    expect(step.value).toBe('ok')
    // The bare failures must be visible, not silently swallowed.
    expect(retryNotices).toHaveLength(2)
    expect(retryNotices[0]).toMatchObject({
      type: 'system',
      subtype: 'api_error',
      retryAttempt: 1,
      maxRetries: 3,
    })
  }, 15_000)

  test('still bails immediately on a bare non-network error', async () => {
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        throw new Error('something deterministic broke')
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )

    await expect(generator.next()).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(1)
  })
})

describe('withTransientNetworkRetry', () => {
  test('defaults to a ten-attempt ladder', () => {
    const previous = process.env.CLAUDE_CODE_MAX_RETRIES
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    expect(getDefaultMaxRetries()).toBe(10)
    if (previous !== undefined) {
      process.env.CLAUDE_CODE_MAX_RETRIES = previous
    }
  })

  test('re-runs the query when an attempt only produced a transient error', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          if (attempts === 1) {
            yield apiErrorMessage('API Error: fetch failed')
            return
          }
          yield textDelta('hi')
          yield assistantMessage('hi')
        },
        { maxRetries: 2 },
      ),
    )

    expect(attempts).toBe(2)
    // The swallowed error must not reach the caller; only the retry notice does.
    expect(items.filter(i => i.isApiErrorMessage)).toHaveLength(0)
    expect(items.filter(i => i.type === 'system')).toHaveLength(1)
    expect(items.at(-1)).toMatchObject({ type: 'assistant' })
  }, 15_000)

  test('never retries once content has been emitted (inc-4258 double tool exec)', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield textDelta('partial answer')
          yield apiErrorMessage('API Error: terminated')
        },
        { maxRetries: 5 },
      ),
    )

    expect(attempts).toBe(1)
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ isApiErrorMessage: true })
  })

  test('passes the error through once the ladder is exhausted', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield apiErrorMessage('API Error: fetch failed')
        },
        { maxRetries: 2 },
      ),
    )

    expect(attempts).toBe(3) // 1 initial + 2 retries
    expect(items.filter(i => i.type === 'system')).toHaveLength(2)
    expect(items.at(-1)).toMatchObject({ isApiErrorMessage: true })
  }, 15_000)

  test('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield apiErrorMessage('API Error: fetch failed')
        },
        { maxRetries: 10, signal: controller.signal },
      ),
    )

    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ isApiErrorMessage: true })
  })

  test('does not stack a second ladder on an already-exhausted error', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield markTransientRetriesExhausted(
            apiErrorMessage('API Error: fetch failed'),
          )
        },
        { maxRetries: 10 },
      ),
    )

    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
  })

  test('leaves deterministic API errors untouched', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield apiErrorMessage(
            'API Error: 400 {"type":"invalid_request_error"}',
          )
        },
        { maxRetries: 10 },
      ),
    )

    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
  })

  test('retries the stream deaths seen with the non-streaming fallback disabled', async () => {
    // CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 rethrows these out of the
    // stream loop, so claude.ts converts them to `API Error: <text>` with no
    // CannotRetryError and therefore no exhausted marker — this wrapper is the
    // only ladder they ever get.
    for (const text of [
      'API Error: Stream idle timeout - no chunks received',
      'API Error: Stream ended without receiving any events',
    ]) {
      let attempts = 0
      const items = await collect(
        withTransientNetworkRetry(
          async function* () {
            attempts++
            if (attempts === 1) {
              yield apiErrorMessage(text)
              return
            }
            yield assistantMessage('recovered')
          },
          { maxRetries: 2 },
        ),
      )
      expect(attempts).toBe(2)
      expect(items.filter(i => i.isApiErrorMessage)).toHaveLength(0)
      expect(items.at(-1)).toMatchObject({ type: 'assistant' })
    }
  }, 15_000)

  test('the exhausted marker never reaches the transcript JSONL', () => {
    const message = markTransientRetriesExhausted(
      apiErrorMessage('API Error: fetch failed'),
    )
    // Symbol-keyed, so session persistence round-trips cleanly.
    expect(JSON.stringify(message)).not.toContain('transientRetriesExhausted')
    expect(Object.keys(message)).not.toContain('transientRetriesExhausted')
    // ...and the wrapper still reads it.
    expect(Object.getOwnPropertySymbols(message).map(String)).toContain(
      'Symbol(occ.api.transientRetriesExhausted)',
    )
  })

  test('emits an earlier held error rather than dropping it on overwrite', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          if (attempts === 1) {
            yield apiErrorMessage('API Error: fetch failed')
            yield apiErrorMessage('API Error: terminated')
            return
          }
          yield assistantMessage('recovered')
        },
        { maxRetries: 2 },
      ),
    )

    expect(attempts).toBe(2)
    // The first error is surfaced (not swallowed); the second is the one held
    // back and replaced by the successful retry.
    const errors = items.filter(i => i.isApiErrorMessage)
    expect(errors).toHaveLength(1)
    expect(items.at(-1)).toMatchObject({ type: 'assistant' })
  }, 15_000)

  test('retries a thrown transient error but rethrows a user abort', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          if (attempts === 1) {
            throw new TypeError('fetch failed')
          }
          yield assistantMessage('recovered')
        },
        { maxRetries: 2 },
      ),
    )
    expect(attempts).toBe(2)
    expect(items.at(-1)).toMatchObject({ type: 'assistant' })

    await expect(
      collect(
        withTransientNetworkRetry(
          // biome-ignore lint/correctness/useYield: models a query that dies before its first yield
          async function* () {
            throw new APIUserAbortError()
          },
          { maxRetries: 2 },
        ),
      ),
    ).rejects.toBeInstanceOf(APIUserAbortError)
  }, 15_000)

  test('is a passthrough when retries are disabled', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield apiErrorMessage('API Error: fetch failed')
        },
        { maxRetries: 0 },
      ),
    )
    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
  })
})
