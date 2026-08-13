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

/**
 * Subscription shape, per test. The 429 gate asks two different questions of
 * auth, and both answers change the outcome, so they have to be steerable
 * rather than pinned by the shared mock's defaults.
 */
const subscription = { claudeAI: true, enterprise: false }

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module(
  'src/utils/auth/auth.js',
  authMockWith({
    isClaudeAISubscriber: () => subscription.claudeAI,
    isEnterpriseSubscriber: () => subscription.enterprise,
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
  FallbackTriggeredError,
  clampMaxRetries,
  getDefaultMaxRetries,
  isTransientNetworkError,
  isTransientNetworkErrorText,
  markTransientRetriesExhausted,
  withRetry,
  withTransientNetworkRetry,
} from '../withRetry.js'
import { createAssistantAPIErrorMessageFromError } from '../../../utils/messages.js'
import {
  attachAPIErrorSource,
  categorizeRetryableAPIError,
  classifyRetryableAPIError,
  describeAPIError,
  getAPIErrorSource,
  isAPIErrorReplayable,
  NonRetryableError,
} from '../retryClassification.js'

describe('withRetry context overflow adjustment', () => {
  test('uses the full retry budget when thinking prevents an adjustment', async () => {
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
      async () => {
        calls++
        throw overflow
      },
      {
        maxRetries: 2,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'enabled', budgetTokens: 5_000 },
      },
    )

    await expect(async () => {
      let step = await generator.next()
      while (!step.done) step = await generator.next()
    }).toThrow(CannotRetryError)
    expect(calls).toBe(3)
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

/**
 * Which retry budget a failure lands in.
 *
 * Official retryable failures use the transient lane; permanent means the
 * request stops without entering the retry ladder.
 */
function laneOf(error: unknown): 'transient' | 'permanent' {
  return classifyRetryableAPIError(error).persistence
}

/** Every attempt `withRetry` makes for `error`, and how long it took. */
async function runLadder(
  error: unknown,
  maxRetries = 10,
): Promise<{ calls: number; elapsedMs: number }> {
  const startedAt = Date.now()
  let calls = 0
  const generator = withRetry(
    async () => ({}) as unknown as Anthropic,
    async () => {
      calls++
      throw error
    },
    {
      maxRetries,
      model: 'claude-sonnet',
      thinkingConfig: { type: 'disabled' },
    },
  )
  try {
    let step = await generator.next()
    while (!step.done) step = await generator.next()
  } catch {
    // CannotRetryError once the budget is spent — the counts are the assertion.
  }
  return { calls, elapsedMs: Date.now() - startedAt }
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
    expect(
      isTransientNetworkError(new Error('unclassified provider failure')),
    ).toBe(false)
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

  test('retries official transient statuses and rejects permanent 4xx', () => {
    for (const status of [408, 409, 429, 500, 501, 503, 529]) {
      // A short retry-after keeps the 429 out of the window gate, which is a
      // separate decision with its own describe block below.
      const error = new APIError(
        status,
        undefined,
        `status ${status}`,
        new Headers({ 'retry-after': '5' }),
      )
      expect(isTransientNetworkError(error)).toBe(true)
      expect(laneOf(error)).toBe('transient')
    }
    for (const status of [400, 403, 404, 422, 425]) {
      const error = new APIError(
        status,
        undefined,
        `status ${status}: Upstream request failed`,
        new Headers(),
      )
      expect(isTransientNetworkError(error)).toBe(false)
      expect(laneOf(error)).toBe('permanent')
    }
    expect(
      isTransientNetworkError(
        new APIError(401, undefined, 'unauthorized', new Headers()),
      ),
    ).toBe(true)
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

  test('a nested abort outranks outer transient transport wording', () => {
    const nested = withCause(
      'fetch failed',
      new Error('The operation was aborted'),
    )
    expect(isTransientNetworkError(nested)).toBe(false)
  })

  test('a non-error is not retried at all', () => {
    // Nothing happened, so there is nothing to attempt again. This is not the
    // permanent lane, it is the absence of a failure.
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
    expect(isTransientNetworkError('')).toBe(false)
  })

  test('deterministic failures do not enter the ladder', () => {
    for (const error of [
      new Error('Prompt is too long'),
      codedError('CERT_HAS_EXPIRED'),
      new APIError(400, undefined, 'invalid_request_error', new Headers()),
    ]) {
      expect(isTransientNetworkError(error)).toBe(false)
      expect(laneOf(error)).toBe('permanent')
    }
  })

  test('a TLS handshake failure stays off the ladder', () => {
    for (const error of [
      codedError('EPROTO', 'write EPROTO ssl/tls alert handshake failure'),
      codedError('ERR_SSL_PACKET_LENGTH_TOO_LONG'),
      codedError('ERR_SSL_WRONG_VERSION_NUMBER'),
      codedError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
      codedError('DEPTH_ZERO_SELF_SIGNED_CERT'),
      // Even nested behind a wrapper whose message would otherwise match.
      withCause(
        'fetch failed',
        codedError('EPROTO', 'write EPROTO ssl/tls alert handshake failure'),
      ),
    ]) {
      expect(laneOf(error)).toBe('permanent')
    }
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

describe('structured API error classification', () => {
  test('classifies official retryable and permanent HTTP statuses', () => {
    for (const status of [408, 409, 429, 529, 500, 503]) {
      expect(classifyRetryableAPIError({ status })).toMatchObject({
        retryable: true,
        persistence: 'transient',
      })
    }
    for (const status of [400, 402, 403, 404, 413, 422, 425]) {
      expect(classifyRetryableAPIError({ status })).toMatchObject({
        retryable: false,
        persistence: 'permanent',
      })
    }
    expect(classifyRetryableAPIError({ status: 401 })).toMatchObject({
      retryable: true,
      persistence: 'transient',
    })
    expect(categorizeRetryableAPIError({ status: 401 })).toBe(
      'authentication_failed',
    )
    expect(categorizeRetryableAPIError({ status: 402 })).toBe('billing_error')
    expect(categorizeRetryableAPIError({ status: 413 })).toBe('invalid_request')
    expect(categorizeRetryableAPIError({ status: 503 })).toBe('server_error')
  })

  test('a disabled model is an invalid request, not a bad credential', () => {
    // OpenCode's Console plane refuses a model the org is not entitled to with
    // a 403, and the status alone classifies that as `authentication_failed` —
    // which sends the user to /login to repair a credential that is working.
    // The body's own type is read before the status, so it wins.
    expect(
      categorizeRetryableAPIError({
        status: 403,
        error: {
          type: 'managed_inference_model_disabled',
          message: 'Model is disabled for this organization',
        },
      }),
    ).toBe('invalid_request')
    // A real 403 with nothing to say is still an auth failure.
    expect(categorizeRetryableAPIError({ status: 403 })).toBe(
      'authentication_failed',
    )
  })

  test('an unserved model is an invalid request even when it arrives as a 401', () => {
    // Measured against opencode.ai/zen/go/v1, which answers an id it does not
    // serve with this exact shape. Relays that pass an upstream body through
    // verbatim reproduce it under their own domain, so the user sees "your
    // credentials failed" for a key that had just authenticated well enough for
    // the gateway to look the model up and answer about it.
    expect(
      categorizeRetryableAPIError({
        status: 401,
        error: {
          type: 'ModelError',
          message: 'Model gpt-5.6-sol is not supported',
        },
      }),
    ).toBe('invalid_request')
    // A 401 that says nothing about a model is still an auth failure.
    expect(categorizeRetryableAPIError({ status: 401 })).toBe(
      'authentication_failed',
    )
  })

  test('recognizes statusless provider type and code families', () => {
    for (const value of [
      { type: 'server_error' },
      { type: 'api_error' },
      { code: 'internal_error' },
      { status: 'UNAVAILABLE' },
      { code: 'DEADLINE_EXCEEDED' },
      { status: 'RESOURCE_EXHAUSTED' },
      { status: 'ABORTED' },
      { code: 'ThrottlingException' },
      { code: 'InternalServerException' },
      { code: 'ModelStreamErrorException' },
      { code: 'ECONNRESET' },
      // The Responses gateway's own wording for a dropped upstream socket.
      { type: 'upstream_error', code: 'stream_read_error' },
    ]) {
      expect(classifyRetryableAPIError(value)).toMatchObject({
        retryable: true,
        persistence: 'transient',
      })
    }
    expect(categorizeRetryableAPIError({ status: 'RESOURCE_EXHAUSTED' })).toBe(
      'rate_limit',
    )
    expect(classifyRetryableAPIError({ code: 'INVALID_ARGUMENT' })).toEqual({
      category: 'invalid_request',
      retryable: false,
      persistence: 'permanent',
    })
    expect(classifyRetryableAPIError({ code: 'ValidationException' })).toEqual({
      category: 'invalid_request',
      retryable: false,
      persistence: 'permanent',
    })
    for (const code of [
      'AccessDeniedException',
      'UnrecognizedClientException',
      'ExpiredTokenException',
      'InvalidSignatureException',
      'NotAuthorizedException',
      'PermissionDeniedException',
    ]) {
      expect(classifyRetryableAPIError({ code })).toEqual({
        category: 'authentication_failed',
        retryable: false,
        persistence: 'permanent',
      })
    }
  })

  test('uses the documented abort, TLS, explicit, and structured precedence', () => {
    expect(
      classifyRetryableAPIError(
        Object.assign(new Error('fetch failed'), {
          retryable: true,
          cause: new Error('The operation was aborted'),
        }),
      ).retryable,
    ).toBe(false)
    expect(
      classifyRetryableAPIError(
        Object.assign(new Error('fetch failed'), {
          retryable: true,
          cause: codedError(
            'EPROTO',
            'write EPROTO ssl/tls alert handshake failure',
          ),
        }),
      ).persistence,
    ).toBe('permanent')
    expect(
      classifyRetryableAPIError({
        status: 503,
        retryable: false,
        message: 'service unavailable',
      }),
    ).toEqual({
      category: 'server_error',
      retryable: true,
      persistence: 'transient',
    })
    expect(
      classifyRetryableAPIError({
        status: 400,
        retryable: true,
        message: 'upstream timeout',
      }),
    ).toEqual({
      category: 'invalid_request',
      retryable: false,
      persistence: 'permanent',
    })
    for (const value of [
      {
        status: 500,
        code: 'ValidationException',
        message: 'invalid request',
      },
      {
        status: 503,
        type: 'INVALID_ARGUMENT',
        message: 'service unavailable',
      },
      { status: 429, code: 'InvalidModel', message: 'invalid model' },
    ]) {
      expect(classifyRetryableAPIError(value)).toEqual({
        category: 'invalid_request',
        retryable: false,
        persistence: 'permanent',
      })
    }
    expect(classifyRetryableAPIError({ retryable: true })).toEqual({
      category: 'server_error',
      retryable: true,
      persistence: 'transient',
    })
    expect(
      classifyRetryableAPIError(new Error('unclassified failure')),
    ).toEqual({
      category: 'server_error',
      retryable: false,
      persistence: 'permanent',
    })
  })

  test('permanent local preconditions never enter the API retry policy', () => {
    // Local preconditions use this field when no API request happened. Stream
    // replay safety is represented separately by `replayable`.
    const chatgpt =
      'ChatGPT account is not logged in. Run /login and select ChatGPT account with subscription.'
    const antigravity =
      'Antigravity project discovery returned no project. Open Antigravity once with this Google account, then retry.'

    expect(classifyRetryableAPIError(new Error(chatgpt))).toEqual({
      category: 'authentication_failed',
      retryable: false,
      persistence: 'permanent',
    })
    expect(
      classifyRetryableAPIError(
        new NonRetryableError(chatgpt, { category: 'authentication_failed' }),
      ),
    ).toEqual({
      category: 'authentication_failed',
      retryable: false,
      persistence: 'permanent',
    })

    expect(classifyRetryableAPIError(new Error(antigravity))).toEqual({
      category: 'invalid_request',
      retryable: false,
      persistence: 'permanent',
    })
    expect(
      classifyRetryableAPIError(
        new NonRetryableError(antigravity, { category: 'invalid_request' }),
      ),
    ).toEqual({
      category: 'invalid_request',
      retryable: false,
      persistence: 'permanent',
    })
  })

  test('the declared category survives re-wrapping', () => {
    // The thrower states the category outright so the SDK error surface does
    // not depend on the prose continuing to match a regex.
    const wrapped = new Error('request failed', {
      cause: new NonRetryableError('account has no seat', {
        category: 'billing_error',
      }),
    })
    expect(classifyRetryableAPIError(wrapped)).toEqual({
      category: 'billing_error',
      retryable: false,
      persistence: 'permanent',
    })
  })

  test('a committed UND_ERR_SOCKET stays retryable but is not replayable', () => {
    const socket = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    })
    const committed = Object.assign(
      new Error('other side closed', { cause: socket }),
      {
        name: 'OpenAIRequestError',
        retryable: true,
        replayable: false,
      },
    )

    expect(classifyRetryableAPIError(committed)).toEqual({
      category: 'server_error',
      retryable: true,
      persistence: 'transient',
    })
    expect(isAPIErrorReplayable(committed)).toBe(false)
    expect(
      describeAPIError(committed, { provider: 'OpenAI' }).content,
    ).toContain(
      'code=UND_ERR_SOCKET · name=OpenAIRequestError · category=server_error · retryable=yes · replayable=no',
    )
  })

  test('the reported category does not depend on the retry verdict', () => {
    // The upstream-gateway failure from the real bug report, in both the plain
    // shape and the shape a closed retry window marks non-replayable. It used to
    // report category=server_error in the first and
    // category=unknown in the second, which made one failure look like two and
    // sent a diagnosis down the wrong path.
    const payload = {
      type: 'upstream_error',
      code: 'stream_read_error',
      message: 'stream_read_error',
    }
    const pinned = Object.assign(new Error('stream_read_error'), {
      name: 'OpenAIRequestError',
      retryable: true,
      replayable: false,
      cause: payload,
    })

    expect(categorizeRetryableAPIError(payload)).toBe('server_error')
    expect(categorizeRetryableAPIError(pinned)).toBe('server_error')
    expect(classifyRetryableAPIError(pinned).retryable).toBe(true)
    expect(isAPIErrorReplayable(pinned)).toBe(false)

    // Same invariant for a failure with no signal at all: whichever verdict it
    // ends up with, the reported category is the same one.
    const opaque = new Error('provider exploded')
    expect(categorizeRetryableAPIError(opaque)).toBe('server_error')
    expect(
      categorizeRetryableAPIError(
        Object.assign(new Error('provider exploded'), { retryable: false }),
      ),
    ).toBe('server_error')
  })

  test('the new permanent phrases do not swallow transient wording', () => {
    // "then retry" in the Antigravity copy is advice for the user, and a
    // gateway saying it is unavailable must still climb the ladder.
    for (const message of [
      'upstream request failed — try again later',
      'no healthy upstream',
    ]) {
      expect(classifyRetryableAPIError(new Error(message)).retryable).toBe(true)
    }
  })

  test('keeps source errors in non-enumerable symbol metadata', () => {
    const source = Object.assign(new Error('upstream unavailable'), {
      type: 'server_error',
      secret: 'raw-only',
    })
    const message = createAssistantAPIErrorMessageFromError({
      content: 'API Error: upstream unavailable',
      apiError: 'api_error',
      sourceError: source,
    })

    expect(message.error).toBe('server_error')
    expect(getAPIErrorSource(message)).toBe(source)
    const sourceSymbol = Object.getOwnPropertySymbols(message).find(symbol =>
      String(symbol).includes('sourceError'),
    )
    expect(sourceSymbol).toBeDefined()
    expect(
      Object.getOwnPropertyDescriptor(message, sourceSymbol!)?.enumerable,
    ).toBe(false)
    expect(Object.keys(message).some(key => key.includes('sourceError'))).toBe(
      false,
    )
    const ndjson = `${JSON.stringify(message)}\n`
    expect(ndjson).not.toContain('sourceError')
    expect(ndjson).not.toContain('raw-only')
    expect(JSON.parse(ndjson).error).toBe('server_error')
  })

  test('formats detailed diagnostics from whitelisted, redacted scalars', () => {
    const source = Object.assign(
      new Error(
        '503 {"error":{"message":"backend unavailable api_key=sk-proj-123456789","prompt":"do not expose"}}',
      ),
      {
        status: 503,
        code: 'UPSTREAM_FAILURE',
        type: 'server_error',
        requestID: 'req_123',
        headers: new Headers({
          authorization: 'Bearer secret-token',
          'x-request-id': 'req_header',
        }),
      },
    )

    const diagnostic = describeAPIError(source, {
      provider: 'OpenAI',
      wire: 'responses',
    })

    expect(diagnostic.content).toContain('API Error [OpenAI]')
    expect(diagnostic.content).toContain('backend unavailable')
    expect(diagnostic.content).toContain('wire=responses')
    expect(diagnostic.content).toContain('status=503')
    expect(diagnostic.content).toContain('code=UPSTREAM_FAILURE')
    expect(diagnostic.content).toContain('type=server_error')
    expect(diagnostic.content).toContain('request_id=req_123')
    expect(diagnostic.content).toContain('retryable=yes')
    expect(diagnostic.content).not.toContain('sk-proj-123456789')
    expect(diagnostic.errorDetails).not.toContain('do not expose')
    expect(diagnostic.errorDetails).not.toContain('authorization')
    expect(diagnostic.errorDetails).not.toContain('secret-token')
  })

  test('redacts authorization, prompts, and request bodies from diagnostics', () => {
    for (const [message, secret] of [
      ['upstream failed Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
      ['request rejected prompt=PRIVATE_USER_PROMPT', 'PRIVATE_USER_PROMPT'],
      [
        'request failed body={"messages":[{"content":"PRIVATE_BODY"}]}',
        'PRIVATE_BODY',
      ],
      ['custom Authorization: Token TOP_SECRET_VALUE', 'TOP_SECRET_VALUE'],
      [
        'provider says prompt was PRIVATE_PROMPT_VARIANT',
        'PRIVATE_PROMPT_VARIANT',
      ],
      [
        'request body was {"conversation":"PRIVATE_BODY_VARIANT"}',
        'PRIVATE_BODY_VARIANT',
      ],
    ]) {
      const diagnostic = describeAPIError(new Error(message), {
        provider: 'Probe',
      })
      expect(diagnostic.content).not.toContain(secret)
      expect(diagnostic.errorDetails).not.toContain(secret)
      expect(diagnostic.content).toContain('[REDACTED]')
    }
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
    // ...and the same anchor with a permanent status must stay off the ladder.
    expect(
      laneOf(
        'API Error: Gemini API request failed (400 Bad Request): invalid argument',
      ),
    ).toBe('permanent')
    expect(
      laneOf('API Error: Responses API request failed (404): model not found'),
    ).toBe('permanent')
  })

  test('a transient status buried in a 4xx response body is not a ladder signal', () => {
    // The regression this anchoring exists for: free-scanning the text turns a
    // permanent 400 into ~3 minutes of backoff because its body says "500".
    // Now that nothing fails outright, the anchoring is what keeps these on
    // the one-attempt lane instead of the ladder.
    for (const text of [
      'API Error: 400 {"error":{"message":"exceeded the 500 output token maximum"}}',
      'API Error: 400 {"error":{"message":"max_tokens: must be <= 502"}}',
      'API Error: Responses API request failed (400): {"error":{"message":"input exceeds 429 tokens"}}',
      'API Error: Responses API request failed (400): Upstream request failed',
      'API Error: 422 {"error":{"message":"expected 503 items, got 2"}}',
    ]) {
      expect(laneOf(text)).toBe('permanent')
    }
  })

  test('leaves deterministic failures on the cheap lane', () => {
    for (const text of [
      'Prompt is too long',
      'API Error: 400 {"type":"invalid_request_error"}',
      'API Error: 403 {"type":"permission_error"}',
      'API Error: 404 {"type":"not_found_error"}',
      'API Error: 413 {"type":"request_too_large"}',
      'API Error: The model has reached its context window limit.',
      'API Error (claude-opus-4-6): 400 {"type":"invalid_request_error"}',
      'Please run /login · API Error: 401 {"type":"authentication_error"}',
    ]) {
      expect(laneOf(text)).toBe('permanent')
    }
  })

  test('still refuses empty text and cancellations outright', () => {
    expect(isTransientNetworkErrorText('')).toBe(false)
    expect(isTransientNetworkErrorText('API Error: Request was aborted.')).toBe(
      false,
    )
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

  test('rejects permanent API statuses without retry', async () => {
    for (const status of [400, 403, 404, 422]) {
      const { calls } = await runLadder(
        new APIError(status, undefined, `status ${status}`, new Headers()),
      )
      expect(calls).toBe(1)
    }
  })

  test('a transient status still gets the full ladder', async () => {
    // The cheap lane must not have quietly capped everything at one retry.
    const { calls } = await runLadder(
      new APIError(
        503,
        undefined,
        'service unavailable',
        new Headers({ 'retry-after': '0' }),
      ),
      4,
    )
    expect(calls).toBe(5)
  }, 20_000)

  test('rejects an unclassified API-boundary error', async () => {
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        throw new Error('unclassified provider failure')
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
    // maxRetries: 0 keeps these focused on WHICH cache is dropped. The retry
    // budget is asserted elsewhere; here a second attempt would only record
    // the same recovery calls twice.
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        throw error
      },
      {
        maxRetries: 0,
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

  test('rejects an absurd Retry-After instead of parking the turn', async () => {
    await expect(firstRetryDelayMs('7200')).rejects.toBeInstanceOf(
      CannotRetryError,
    )
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

describe('429 retry coverage', () => {
  /**
   * The ladder's first decision. A granted retry yields its countdown notice
   * before sleeping; a refusal throws CannotRetryError out of the same call.
   */
  async function decisionFor(
    headers: Record<string, string>,
  ): Promise<'retried' | 'refused'> {
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        throw new APIError(
          429,
          undefined,
          'rate limit exceeded',
          new Headers(headers),
        )
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
      },
    )
    try {
      const step = await generator.next()
      await generator.return(undefined as never)
      return step.done ? 'refused' : 'retried'
    } catch {
      return 'refused'
    }
  }

  const inSeconds = (offsetMs: number): string =>
    String(Math.floor((Date.now() + offsetMs) / 1000))

  afterEach(() => {
    subscription.claudeAI = true
    subscription.enterprise = false
  })

  test('retries a 429 whose advertised reset is hours away', async () => {
    expect(
      await decisionFor({
        'anthropic-ratelimit-unified-reset': inSeconds(5 * 60 * 60 * 1000),
      }),
    ).toBe('retried')
  })

  test('still retries a 429 whose window reopens inside the ladder', async () => {
    // A per-minute limit is exactly what the ladder is for.
    expect(
      await decisionFor({
        'anthropic-ratelimit-unified-reset': inSeconds(20_000),
      }),
    ).toBe('retried')
  })

  test('rejects excessive and honors short Retry-After values', async () => {
    expect(await decisionFor({ 'retry-after': '7200' })).toBe('refused')
    expect(await decisionFor({ 'retry-after': '30' })).toBe('retried')
  })

  test('retries an unlabelled 429 for a subscription plan', async () => {
    subscription.claudeAI = true
    subscription.enterprise = false
    expect(await decisionFor({})).toBe('retried')
  })

  test('retries an unlabelled 429 for PAYG and enterprise seats', async () => {
    subscription.claudeAI = false
    expect(await decisionFor({})).toBe('retried')

    subscription.claudeAI = true
    subscription.enterprise = true
    expect(await decisionFor({})).toBe('retried')
  })
})

describe('529 retry coverage', () => {
  /** The ladder's first decision for a 529 raised under `querySource`. */
  async function decisionFor(
    querySource?: string,
  ): Promise<'retried' | 'refused'> {
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        throw new APIError(529, undefined, 'overloaded', new Headers())
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
        ...(querySource ? { querySource } : {}),
      },
    )
    try {
      const step = await generator.next()
      await generator.return(undefined as never)
      return step.done ? 'refused' : 'retried'
    } catch {
      return 'refused'
    }
  }

  test('drops a 529 for auxiliary background sources', async () => {
    for (const source of ['title_generation', 'suggestions', 'quota_probe']) {
      expect(await decisionFor(source)).toBe('refused')
    }
  })

  test('retries a 529 the user is blocked on', async () => {
    for (const source of [
      'repl_main_thread',
      'agent:default',
      'workflow',
      'compact',
      'auto_mode',
    ]) {
      expect(await decisionFor(source)).toBe('retried')
    }
  })

  test('retries an untagged 529, conservatively', async () => {
    expect(await decisionFor()).toBe('retried')
  })

  test('uses the configured retry budget when no fallback model is configured', async () => {
    const error = new APIError(
      529,
      undefined,
      'overloaded',
      new Headers({ 'retry-after': '0' }),
    )
    const { calls } = await runLadder(error, 2)
    expect(calls).toBe(3)
  })

  test('falls back from Sonnet after three consecutive 529 responses', async () => {
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        calls++
        throw new APIError(
          529,
          undefined,
          'overloaded',
          new Headers({ 'retry-after': '0' }),
        )
      },
      {
        maxRetries: 4,
        model: 'claude-sonnet',
        fallbackModel: 'claude-haiku',
        thinkingConfig: { type: 'disabled' },
      },
    )

    await expect(async () => {
      let step = await generator.next()
      while (!step.done) step = await generator.next()
    }).toThrow(FallbackTriggeredError)
    expect(calls).toBe(3)
  })
})

describe('withTransientNetworkRetry', () => {
  test('defaults to ten retries and clamps explicit overrides at fifteen', () => {
    const previous = process.env.CLAUDE_CODE_MAX_RETRIES
    try {
      delete process.env.CLAUDE_CODE_MAX_RETRIES
      expect(getDefaultMaxRetries()).toBe(10)
      process.env.CLAUDE_CODE_MAX_RETRIES = '999'
      expect(getDefaultMaxRetries()).toBe(15)
      expect(clampMaxRetries(999)).toBe(15)
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

  test('does not multiply a provider ladder exhausted on the source error', async () => {
    const exhausted = Object.assign(new Error('fetch failed'), {
      retryable: true,
      [Symbol.for('occ.api.transientRetriesExhausted')]: true,
    })
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield attachAPIErrorSource(
            {
              ...apiErrorMessage('API Error: fetch failed'),
              error: 'server_error',
            },
            exhausted,
          )
        },
        { maxRetries: 10 },
      ),
    )

    expect(attempts).toBe(1)
    expect(items).toHaveLength(1)
  })

  test('retries a retryable source error when no content was emitted', async () => {
    let attempts = 0
    const items = await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield {
            ...apiErrorMessage('API Error: stream idle timeout'),
            error: Object.assign(new Error('stream idle timeout'), {
              name: 'OpenAIRequestError',
              retryable: true,
              replayable: false,
            }),
          }
        },
        { maxRetries: 5 },
      ),
    )

    expect(attempts).toBe(6)
    expect(items.at(-1)).toMatchObject({ isApiErrorMessage: true })
  }, 30_000)

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

  test('surfaces a deterministic API error without retry', async () => {
    const startedAt = Date.now()
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
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    expect(items.at(-1)).toMatchObject({ isApiErrorMessage: true })
  }, 15_000)

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

  for (const blockType of ['tool_use', 'server_tool_use']) {
    test(`does not replay after a ${blockType} identity was yielded`, async () => {
      let attempts = 0
      const items = await collect(
        withTransientNetworkRetry(
          async function* () {
            attempts++
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                content_block: {
                  type: blockType,
                  id: 'toolu_1',
                  name: 'Bash',
                  input: {},
                },
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
  }

  test('still refuses to retry after tool arguments started (inc-4258)', async () => {
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

  test('does not replay after a refusal terminal event', async () => {
    let attempts = 0
    await collect(
      withTransientNetworkRetry(
        async function* () {
          attempts++
          yield {
            type: 'stream_event',
            event: {
              type: 'message_delta',
              delta: { stop_reason: 'refusal', stop_sequence: null },
              usage: { output_tokens: 0 },
            },
          } as StreamItem
          yield apiErrorMessage('API Error: terminated')
        },
        { maxRetries: 5 },
      ),
    )

    expect(attempts).toBe(1)
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

  test('delivered content is never replayed for a class the policy now retries', async () => {
    // Asserted as a pair, because either half alone is satisfiable by the
    // wrong implementation: a build that never retries a 401 passes the first,
    // and a build without the barrier passes the second.
    const run = async (emitText: boolean) => {
      let attempts = 0
      const items = await collect(
        withTransientNetworkRetry(
          async function* () {
            attempts++
            if (emitText) yield textDelta('half an answer')
            yield apiErrorMessage(
              'API Error: 401 {"type":"authentication_error"}',
            )
          },
          { maxRetries: 1 },
        ),
      )
      return { attempts, items }
    }

    // A 401 is the official credential-refresh retry case.
    expect((await run(false)).attempts).toBe(2)

    // A delta already went to the terminal, to an ACP `agent_message_chunk`
    // and to `--include-partial-messages` stdout — none of which has an update
    // kind that takes a chunk back. The barrier sits above the policy.
    const delivered = await run(true)
    expect(delivered.attempts).toBe(1)
    expect(delivered.items).toHaveLength(2)
    expect(delivered.items.at(-1)).toMatchObject({ isApiErrorMessage: true })
  }, 15_000)
})

/** Official Claude Code retry policy and provider-shape bridges. */
describe('official retry policy', () => {
  test('retries 401 for credential refresh but rejects other auth failures', async () => {
    expect(
      classifyRetryableAPIError(
        new APIError(401, undefined, 'unauthorized', new Headers()),
      ),
    ).toMatchObject({
      category: 'authentication_failed',
      retryable: true,
      persistence: 'transient',
    })
    for (const error of [
      new APIError(403, undefined, 'forbidden', new Headers()),
      new Error('authentication failed'),
      codedError('NotAuthorizedException', 'rejected'),
    ]) {
      expect(classifyRetryableAPIError(error)).toMatchObject({
        category: 'authentication_failed',
        retryable: false,
        persistence: 'permanent',
      })
    }

    const { calls } = await runLadder(
      new APIError(401, undefined, 'unauthorized', new Headers()),
      1,
    )
    expect(calls).toBe(2)
  }, 15_000)

  test('does not retry billing, permission, or invalid requests', () => {
    for (const [error, category] of [
      [
        new APIError(402, undefined, 'payment required', new Headers()),
        'billing_error',
      ],
      [new Error('Your credit balance is too low'), 'billing_error'],
      [
        new APIError(403, undefined, 'permission denied', new Headers()),
        'authentication_failed',
      ],
      [codedError('PermissionDeniedException'), 'authentication_failed'],
      [
        new APIError(400, undefined, 'invalid_request_error', new Headers()),
        'invalid_request',
      ],
      [codedError('INVALID_ARGUMENT'), 'invalid_request'],
    ] as Array<[unknown, string]>) {
      expect(classifyRetryableAPIError(error)).toMatchObject({
        category,
        retryable: false,
        persistence: 'permanent',
      })
    }
  })

  test('does not retry an unclassified fall-through', () => {
    expect(classifyRetryableAPIError(new Error('provider exploded'))).toEqual({
      category: 'server_error',
      retryable: false,
      persistence: 'permanent',
    })
  })

  test('x-should-retry:false vetoes retry', async () => {
    const header = new Headers({ 'x-should-retry': 'false' })
    const { calls } = await runLadder(
      new APIError(503, undefined, 'service unavailable', header),
    )
    expect(calls).toBe(1)
  })

  test('a cancellation is never retried, whatever else the error says', async () => {
    const named = new Error('The operation was aborted')
    named.name = 'AbortError'
    for (const error of [
      new APIUserAbortError(),
      named,
      new Error('Request was aborted.'),
      // Carrying a producer verdict of retryable AND transient transport prose.
      Object.assign(new TypeError('fetch failed'), {
        retryable: true,
        cause: named,
      }),
    ]) {
      expect(classifyRetryableAPIError(error).retryable).toBe(false)
      expect(isTransientNetworkError(error)).toBe(false)
    }

    // The ladder makes exactly one attempt for a cancellation...
    const { calls } = await runLadder(new APIUserAbortError())
    expect(calls).toBe(1)

    // ...and an already-aborted signal never reaches the operation at all.
    const controller = new AbortController()
    controller.abort()
    let ran = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async () => {
        ran++
        return 'ok'
      },
      {
        maxRetries: 3,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'disabled' },
        signal: controller.signal,
      },
    )
    await expect(generator.next()).rejects.toBeInstanceOf(APIUserAbortError)
    expect(ran).toBe(0)
  })
})
