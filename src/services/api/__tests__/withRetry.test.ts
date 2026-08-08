import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { authMockWith } from '../../../../tests/mocks/auth.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

/**
 * Credential-recovery side effects, in call order. Recorded rather than
 * asserted through spies because the point of the fix is WHICH caches get
 * dropped for WHICH failure — see `describe('credential recovery …')` below.
 */
const authCalls: string[] = []

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module(
  'src/utils/auth/auth.js',
  authMockWith({
    clearApiKeyHelperCache: () => {
      authCalls.push('clearApiKeyHelperCache')
    },
    clearAwsCredentialsCache: () => {
      authCalls.push('clearAwsCredentialsCache')
    },
    clearGcpCredentialsCache: () => {
      authCalls.push('clearGcpCredentialsCache')
    },
    handleOAuth401Error: async (failedAccessToken: string) => {
      authCalls.push(`handleOAuth401Error:${failedAccessToken}`)
      return true
    },
  }),
)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

import {
  CannotRetryError,
  clampMaxRetries,
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
    expect(isTransientNetworkError(new Error('Upstream request failed'))).toBe(
      true,
    )
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

  test('classifies transient statuses but not permanent 4xx responses', () => {
    for (const status of [408, 409, 425, 429, 500, 501, 503, 529]) {
      expect(
        isTransientNetworkError(
          new APIError(status, undefined, `status ${status}`, new Headers()),
        ),
      ).toBe(true)
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(
        isTransientNetworkError(
          new APIError(
            status,
            undefined,
            `status ${status}: Upstream request failed`,
            new Headers(),
          ),
        ),
      ).toBe(false)
    }
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
      'API Error: 501 Not Implemented',
      'API Error: Gemini API request failed (425 Too Early): retry later',
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
      'API Error: Responses API request failed (400): Upstream request failed',
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

  test('retries a gateway failure with no status', async () => {
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        if (calls === 1) throw new Error('Upstream request failed')
        return 'ok'
      },
      {
        maxRetries: 1,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )

    const notice = await generator.next()
    expect(notice).toMatchObject({ done: false, value: { retryAttempt: 1 } })
    expect(await generator.next()).toEqual({ done: true, value: 'ok' })
    expect(calls).toBe(2)
  })

  test('fails permanent API statuses after one attempt', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      let calls = 0
      const generator = withRetry(
        async () => ({}) as unknown as Anthropic,
        async () => {
          calls++
          throw new APIError(
            status,
            undefined,
            `status ${status}`,
            new Headers(),
          )
        },
        {
          maxRetries: 10,
          model: 'claude-sonnet',
          thinkingConfig: { type: 'disabled' },
        },
      )

      await expect(generator.next()).rejects.toBeInstanceOf(CannotRetryError)
      expect(calls).toBe(1)
    }
  })

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

describe('credential recovery after an auth failure', () => {
  // Restored, not deleted. An unconditional `delete` here wipes the setting of
  // anyone who actually runs on Bedrock or Vertex for the rest of the process —
  // and CLAUDE_CODE_USE_BEDROCK in particular decides getAPIProvider() ahead of
  // everything else, so every later file in the shard inherits the answer.
  const CLOUD_ENV = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ] as const
  const savedCloudEnv: Record<string, string | undefined> = {}
  for (const key of CLOUD_ENV) savedCloudEnv[key] = process.env[key]

  beforeEach(() => {
    for (const key of CLOUD_ENV) delete process.env[key]
  })

  afterEach(() => {
    for (const key of CLOUD_ENV) {
      if (savedCloudEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedCloudEnv[key]
    }
  })

  /**
   * "Do not retry" and "do not refresh the credential" are separate decisions.
   * Every case below still fails the request on its first attempt — what is
   * asserted is that the memoized credential behind it was invalidated, so the
   * NEXT request is not built from the same dead value. Without this a token
   * rotated by another process 401s every request until the CLI restarts.
   */
  async function failOnce(error: unknown): Promise<number> {
    authCalls.length = 0
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        throw error
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )
    await expect(generator.next()).rejects.toBeInstanceOf(CannotRetryError)
    return calls
  }

  test('a 401 drops the apiKeyHelper cache and re-reads the keychain', async () => {
    const calls = await failOnce(
      new APIError(401, undefined, 'unauthorized', new Headers()),
    )
    expect(calls).toBe(1)
    expect(authCalls).toEqual([
      'clearApiKeyHelperCache',
      'handleOAuth401Error:token',
    ])
  })

  test('a revoked OAuth token forces the same refresh as a 401', async () => {
    const calls = await failOnce(
      new APIError(
        403,
        undefined,
        'OAuth token has been revoked',
        new Headers(),
      ),
    )
    expect(calls).toBe(1)
    expect(authCalls).toEqual(['handleOAuth401Error:token'])
  })

  test('an ordinary 403 leaves OAuth state alone', async () => {
    await failOnce(new APIError(403, undefined, 'forbidden', new Headers()))
    expect(authCalls).toEqual([])
  })

  test('a transport blip is not treated as a credential problem', async () => {
    authCalls.length = 0
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        if (calls < 2) throw new TypeError('fetch failed')
        return 'ok'
      },
      {
        maxRetries: 2,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )
    let step = await generator.next()
    while (!step.done) step = await generator.next()
    expect(step.value).toBe('ok')
    expect(authCalls).toEqual([])
  }, 15_000)

  test('Bedrock credential failures clear the AWS cache', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    // Server-side: an expired STS token comes back as a generic 403.
    await failOnce(
      new APIError(
        403,
        undefined,
        'The security token included in the request is invalid',
        new Headers(),
      ),
    )
    expect(authCalls).toEqual(['clearAwsCredentialsCache'])

    // SDK-level: the AWS libs reject before any HTTP call when the cached
    // credential file already holds a past Expiration.
    await failOnce(
      Object.assign(new Error('expired'), {
        name: 'CredentialsProviderError',
      }),
    )
    expect(authCalls).toEqual(['clearAwsCredentialsCache'])
  })

  test('Vertex credential failures clear the GCP cache', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    // google-auth-library fails in prepareOptions(), before the HTTP call.
    await failOnce(new Error('Could not refresh access token'))
    expect(authCalls).toEqual(['clearGcpCredentialsCache'])

    // Vertex answers 401 for an expired token, which is also a first-party
    // OAuth signal — both recoveries have to run.
    await failOnce(new APIError(401, undefined, 'unauthorized', new Headers()))
    expect(authCalls).toEqual([
      'clearApiKeyHelperCache',
      'handleOAuth401Error:token',
      'clearGcpCredentialsCache',
    ])
  })

  test('cloud recovery stays off when the provider is not configured', async () => {
    await failOnce(new Error('Could not refresh access token'))
    expect(authCalls).toEqual([])
  })
})

describe('Retry-After bounds', () => {
  /** Reads the delay off the retry notice without letting the sleep run. */
  async function firstRetryDelayMs(retryAfter: string): Promise<number> {
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        throw new APIError(
          503,
          undefined,
          'service unavailable',
          new Headers({ 'retry-after': retryAfter }),
        )
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )
    const step = await generator.next()
    await generator.return(undefined as never)
    return (step.value as unknown as { retryInMs: number }).retryInMs
  }

  test('honors a sane Retry-After verbatim', async () => {
    expect(await firstRetryDelayMs('45')).toBe(45_000)
  })

  test('caps an absurd Retry-After instead of parking the turn for hours', async () => {
    // Nothing validates this header. A gateway answering `Retry-After: 7200`
    // used to be taken at face value: two hours behind a countdown row the
    // user cannot shorten, on a retry ladder meant to outlast a blip.
    expect(await firstRetryDelayMs('7200')).toBe(60_000)
  })

  test('the exponential ladder is unaffected by the cap', async () => {
    // 32s ceiling, +25% jitter — comfortably under the Retry-After bound.
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        throw new APIError(503, undefined, 'service unavailable', new Headers())
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )
    const step = await generator.next()
    await generator.return(undefined as never)
    const delay = (step.value as unknown as { retryInMs: number }).retryInMs
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThan(60_000)
  })
})

describe('withTransientNetworkRetry', () => {
  test('defaults to ten retries after the initial attempt and clamps overrides', () => {
    const previous = process.env.CLAUDE_CODE_MAX_RETRIES
    try {
      delete process.env.CLAUDE_CODE_MAX_RETRIES
      expect(getDefaultMaxRetries()).toBe(10)
      process.env.CLAUDE_CODE_MAX_RETRIES = '999'
      expect(getDefaultMaxRetries()).toBe(10)
      expect(clampMaxRetries(999)).toBe(10)
      process.env.CLAUDE_CODE_MAX_RETRIES = 'not-a-number'
      expect(getDefaultMaxRetries()).toBe(10)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_MAX_RETRIES
      } else {
        process.env.CLAUDE_CODE_MAX_RETRIES = previous
      }
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

  test('an explicit retryable:false outranks transient-looking prose', async () => {
    // The adapter already classified this failure as permanent. Or-ing the two
    // signals let the wording of the message — 'stream idle timeout' is on the
    // transient list — overrule that verdict and replay a request the producer
    // had ruled out, up to ten times.
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield {
            ...apiErrorMessage('API Error: stream idle timeout'),
            error: Object.assign(new Error('stream idle timeout'), {
              name: 'OpenAIRequestError',
              retryable: false,
            }),
          }
        },
        { maxRetries: 5 },
      ),
    )

    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
  })

  test('an error object saying retryable:true is still retried', async () => {
    let attempts = 0
    await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          if (attempts === 1) {
            // Text alone says nothing here — the object is what carries the
            // verdict, and it must keep winning in this direction too.
            yield {
              ...apiErrorMessage('API Error: gateway said no'),
              error: Object.assign(new Error('gateway said no'), {
                name: 'OpenAIRequestError',
                retryable: true,
              }),
            }
            return
          }
          yield assistantMessage('recovered')
        },
        { maxRetries: 2 },
      ),
    )

    expect(attempts).toBe(2)
  }, 15_000)

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

/** Once any model payload is yielded outside the API layer, replay is unsafe. */
describe('withTransientNetworkRetry commitment boundary', () => {
  function thinkingDelta(thinking: string): StreamItem {
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking },
      },
    }
  }

  function signatureDelta(signature: string): StreamItem {
    return {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'signature_delta', signature },
      },
    }
  }

  for (const [label, partial] of [
    ['thinking', thinkingDelta('reasoning...')],
    ['signature', signatureDelta('sig')],
  ] as Array<[string, StreamItem]>) {
    test(`does not replay after ${label} output was yielded`, async () => {
      let attempts = 0
      const items = await collect(
        withTransientNetworkRetry(
          async function* () {
            attempts++
            yield partial
            yield apiErrorMessage('API Error: terminated')
          },
          { maxRetries: 2 },
        ),
      )

      expect(attempts).toBe(1)
      expect(items).toHaveLength(2)
      expect(items.at(-1)).toMatchObject({ isApiErrorMessage: true })
    })
  }

  test('still refuses to retry after a tool_use block started (inc-4258)', async () => {
    // The double-execution guard must survive the change above: partial_json
    // means a tool_use is materializing, and re-running would run it twice.
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
            },
          } as StreamItem
          yield apiErrorMessage('API Error: terminated')
        },
        { maxRetries: 5 },
      ),
    )

    expect(attempts).toBe(1)
    expect(items.at(-1)).toMatchObject({ isApiErrorMessage: true })
  })

  test('still refuses to retry after text reached the user', async () => {
    let attempts = 0
    await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield textDelta('visible answer')
          yield apiErrorMessage('API Error: terminated')
        },
        { maxRetries: 5 },
      ),
    )
    expect(attempts).toBe(1)
  })

  test('thinking then text then death does not retry', async () => {
    // Text after thinking still pins the turn — the ordering must not matter.
    let attempts = 0
    await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield thinkingDelta('reasoning')
          yield textDelta('visible')
          yield apiErrorMessage('API Error: terminated')
        },
        { maxRetries: 5 },
      ),
    )
    expect(attempts).toBe(1)
  })

  test('a user abort is never retried', async () => {
    // Retrying a cancellation would resurrect a turn the user killed.
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield apiErrorMessage('API Error: Request was aborted.')
        },
        { maxRetries: 5 },
      ),
    )
    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
  })
})
