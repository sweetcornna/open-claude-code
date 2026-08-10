import { parseSSEFrames } from 'src/cli/transports/SSETransport.js'
import { getValidAntigravityAuth } from 'src/services/auth/antigravity/oauth.js'
import { errorMessage } from 'src/utils/runtime/errors.js'
import { isAntigravityAuthMode } from 'src/utils/model/antigravityModels.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import { buildProviderResourceURL } from 'src/utils/network/providerUrl.js'
import {
  antigravityHeaders,
  antigravityStreamUrl,
  unwrapAntigravityChunk,
  wrapAntigravityRequest,
  type AntigravityRequestType,
} from './antigravityWire.js'
import { hasGeminiOAuthCredentialsSync } from './oauthToken.js'
import type {
  GeminiGenerateContentRequest,
  GeminiStreamChunk,
} from '@ant/model-provider'

const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta'

const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }
const DEFAULT_API_TIMEOUT_MS = 600_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000

function timeoutFromEnv(name: string, fallback: number): number {
  return Number.parseInt(process.env[name] ?? '', 10) || fallback
}

function getGeminiModelPath(model: string): string {
  const normalized = model.replace(/^\/+/, '')
  return normalized.startsWith('models/') ? normalized : `models/${normalized}`
}

/**
 * Where and how one generateContent stream goes out.
 *
 * The Antigravity backend differs from the public Gemini API in every field —
 * URL, auth header, body envelope, and where the payload sits inside a frame —
 * so the four are resolved together instead of being patched onto each other.
 * `unwrapChunk` returning null means "skip this frame".
 */
type GeminiWireRequest = {
  url: string
  headers: Record<string, string>
  body: unknown
  unwrapChunk: (raw: unknown) => GeminiStreamChunk | null
}

class GeminiRequestError extends Error {
  readonly status: number
  readonly headers: Headers

  constructor(message: string, response: Response, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'GeminiRequestError'
    this.status = response.status
    this.headers = response.headers
  }
}

class GeminiStreamError extends Error {
  readonly code: string | number | undefined
  readonly status: string | number | undefined
  readonly retryable: boolean | undefined

  constructor(
    message: string,
    details: {
      code?: string | number
      status?: string | number
      retryable?: boolean
      cause: unknown
    },
  ) {
    super(message, { cause: details.cause })
    this.name = 'GeminiStreamError'
    this.code = details.code
    this.status = details.status
    this.retryable = details.retryable
  }
}

function geminiTimeoutError(
  phase: 'connection' | 'stream idle',
  timeoutMs: number,
  envName: 'API_TIMEOUT_MS' | 'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
): GeminiStreamError {
  return new GeminiStreamError(
    `Gemini ${phase} timeout after ${timeoutMs}ms (${envName})`,
    {
      code: 'ETIMEDOUT',
      retryable: true,
      cause: undefined,
    },
  )
}

function waitForAbort(signal: AbortSignal): {
  promise: Promise<never>
  cleanup: () => void
} {
  let onAbort = () => {}
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    cleanup: () => signal.removeEventListener('abort', onAbort),
  }
}

async function readGeminiChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  callerSignal: AbortSignal,
  idleTimeoutMs: number,
) {
  const timeoutError = geminiTimeoutError(
    'stream idle',
    idleTimeoutMs,
    'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  )
  const abort = waitForAbort(controller.signal)
  const timeout = setTimeout(
    () => controller.abort(timeoutError),
    idleTimeoutMs,
  )
  try {
    return await Promise.race([reader.read(), abort.promise])
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = callerSignal.aborted
        ? callerSignal.reason
        : controller.signal.reason
      try {
        await reader.cancel(reason)
      } catch {
        // Preserve the timeout/cancellation that caused cleanup.
      }
      if (callerSignal.aborted) throw reason ?? error
      if (controller.signal.reason === timeoutError) throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
    abort.cleanup()
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function geminiStreamError(
  parsed: unknown,
  eventName?: string,
): GeminiStreamError | undefined {
  const event = asRecord(parsed)
  if (!event) return undefined
  const data = asRecord(event.data)
  const nested = asRecord(event.error) ?? asRecord(data?.error)
  if (eventName !== 'error' && !nested) return undefined
  const error = nested ?? event
  const scalar = (value: unknown): string | number | undefined =>
    typeof value === 'string' || typeof value === 'number' ? value : undefined
  const code = scalar(error.code)
  const status = scalar(error.status)
  const message =
    typeof error.message === 'string'
      ? error.message
      : 'Gemini stream returned an error envelope'
  return new GeminiStreamError(message, {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    cause: error,
  })
}

/**
 * Whether a call with these options will go out over Antigravity rather than
 * the public Gemini endpoint.
 *
 * Exported because the choice is not merely transport: the two backends serve
 * DIFFERENT MODEL CATALOGUES. Antigravity knows `gemini-3.1-flash-lite` and
 * friends and answers anything else with a bare 404 "Requested entity was not
 * found", so a caller picking a default model has to know which one it is
 * talking to. Callers must not re-derive this condition by hand.
 *
 * An explicit accessToken means the caller already picked its endpoint and
 * credential: honour it verbatim rather than rerouting it through Antigravity's
 * envelope.
 *
 * `useAntigravityWhenAvailable` is for callers that are not the main loop —
 * WebSearch's Gemini source runs even when the session talks to another
 * provider, so "am I in Antigravity mode" is the wrong question there; "is
 * there a Google login" is the right one.
 */
export function usesAntigravityRoute(params: {
  accessToken?: string
  useAntigravityWhenAvailable?: boolean
}): boolean {
  return (
    !params.accessToken &&
    (isAntigravityAuthMode() ||
      (params.useAntigravityWhenAvailable === true &&
        hasGeminiOAuthCredentialsSync()))
  )
}

async function resolveGeminiWireRequest(params: {
  model: string
  body: GeminiGenerateContentRequest
  accessToken?: string
  requestType?: AntigravityRequestType
  useAntigravityWhenAvailable?: boolean
}): Promise<GeminiWireRequest> {
  if (usesAntigravityRoute(params)) {
    const auth = await getValidAntigravityAuth()
    return {
      url: antigravityStreamUrl(),
      headers: antigravityHeaders(auth.accessToken),
      body: wrapAntigravityRequest({
        model: params.model,
        projectId: auth.projectId,
        body: params.body,
        ...(params.requestType ? { requestType: params.requestType } : {}),
      }),
      unwrapChunk: unwrapAntigravityChunk,
    }
  }
  return {
    url: buildProviderResourceURL(
      process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      'gemini',
      `${getGeminiModelPath(params.model)}:streamGenerateContent`,
      { alt: 'sse' },
    ),
    headers: {
      'Content-Type': 'application/json',
      ...(params.accessToken
        ? { Authorization: `Bearer ${params.accessToken}` }
        : { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' }),
    },
    body: params.body,
    unwrapChunk: raw => raw as GeminiStreamChunk,
  }
}

export async function* streamGeminiGenerateContent(params: {
  model: string
  body: GeminiGenerateContentRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  /**
   * OAuth bearer token. When supplied it REPLACES the `x-goog-api-key` header
   * — Google rejects a request carrying both. Used by the OAuth-connected
   * Gemini search source, where there is no GEMINI_API_KEY at all.
   */
  accessToken?: string
  /**
   * Antigravity request kind. Defaults to 'agent'; WebSearch's Gemini source
   * sends 'web_search'. Ignored on the public Gemini endpoint, which has no
   * envelope.
   */
  requestType?: AntigravityRequestType
  /**
   * Route through Antigravity whenever a Google login exists, even if the main
   * loop is not in Antigravity mode. For callers that are not the main loop.
   */
  useAntigravityWhenAvailable?: boolean
}): AsyncGenerator<GeminiStreamChunk, void> {
  const fetchImpl = params.fetchOverride ?? fetch
  const wire = await resolveGeminiWireRequest({
    model: params.model,
    body: params.body,
    ...(params.accessToken ? { accessToken: params.accessToken } : {}),
    ...(params.requestType ? { requestType: params.requestType } : {}),
    ...(params.useAntigravityWhenAvailable
      ? { useAntigravityWhenAvailable: true }
      : {}),
  })
  const { url, unwrapChunk } = wire
  const controller = new AbortController()
  const forwardCallerAbort = () => controller.abort(params.signal.reason)
  if (params.signal.aborted) forwardCallerAbort()
  else {
    params.signal.addEventListener('abort', forwardCallerAbort, { once: true })
  }
  const cleanupRequest = () =>
    params.signal.removeEventListener('abort', forwardCallerAbort)

  const connectionTimeoutMs = timeoutFromEnv(
    'API_TIMEOUT_MS',
    DEFAULT_API_TIMEOUT_MS,
  )
  const connectionTimeoutError = geminiTimeoutError(
    'connection',
    connectionTimeoutMs,
    'API_TIMEOUT_MS',
  )
  const connectionAbort = waitForAbort(controller.signal)
  const connectionTimer = setTimeout(
    () => controller.abort(connectionTimeoutError),
    connectionTimeoutMs,
  )
  let response: Response
  try {
    response = await Promise.race([
      fetchImpl(url, {
        method: 'POST',
        headers: wire.headers,
        body: JSON.stringify(wire.body),
        signal: controller.signal,
        ...getProxyFetchOptions({ forAnthropicAPI: false }),
      }),
      connectionAbort.promise,
    ])
  } catch (error) {
    cleanupRequest()
    if (params.signal.aborted) throw params.signal.reason ?? error
    if (controller.signal.reason === connectionTimeoutError) {
      throw connectionTimeoutError
    }
    throw error
  } finally {
    clearTimeout(connectionTimer)
    connectionAbort.cleanup()
  }

  if (!response.ok) {
    let cause: unknown
    try {
      const body = await response.text()
      if (body.trim()) {
        try {
          const parsed = JSON.parse(body) as unknown
          const streamError = geminiStreamError(parsed)
          if (streamError) {
            cause = streamError
          } else {
            const record = asRecord(parsed)
            const nested = asRecord(record?.error) ?? record
            const safe: Record<string, unknown> = {}
            for (const key of [
              'message',
              'type',
              'code',
              'status',
              'request_id',
            ]) {
              const value = nested?.[key]
              if (typeof value === 'string' || typeof value === 'number') {
                safe[key] = value
              }
            }
            if (Object.keys(safe).length > 0) cause = safe
          }
        } catch {
          // Never copy an arbitrary response body into a user-visible error.
        }
      }
    } catch (error) {
      cause = new Error(`Unable to read response body: ${errorMessage(error)}`)
    }
    cleanupRequest()
    throw new GeminiRequestError(
      `Gemini API request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''})`,
      response,
      cause,
    )
  }

  if (!response.body) {
    cleanupRequest()
    throw new GeminiStreamError('Gemini API returned no response body', {
      retryable: true,
      cause: undefined,
    })
  }

  const reader = response.body.getReader()
  const idleTimeoutMs = timeoutFromEnv(
    'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  )
  const decoder = new TextDecoder()
  let buffer = ''
  let hasTerminalEvent = false

  const parseFrame = (
    frame: { data?: string; event?: string },
    trailing: boolean,
  ): GeminiStreamChunk | null => {
    if (!frame.data) return null
    if (frame.data === '[DONE]') {
      hasTerminalEvent = true
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch (error) {
      throw new GeminiStreamError(
        `${trailing ? 'Failed to parse trailing' : 'Failed to parse'} Gemini SSE payload: ${errorMessage(error)}`,
        { retryable: true, cause: error },
      )
    }
    const streamError = geminiStreamError(parsed, frame.event)
    if (streamError) throw streamError
    const chunk = unwrapChunk(parsed)
    if (
      chunk?.candidates?.some(candidate => candidate.finishReason) ||
      chunk?.promptFeedback?.blockReason
    ) {
      hasTerminalEvent = true
    }
    return chunk
  }

  try {
    while (true) {
      const { done, value } = await readGeminiChunk(
        reader,
        controller,
        params.signal,
        idleTimeoutMs,
      )
      if (done) break

      buffer += decoder.decode(value, STREAM_DECODE_OPTS)
      const { frames, remaining } = parseSSEFrames(buffer)
      buffer = remaining

      for (const frame of frames) {
        const chunk = parseFrame(frame, false)
        if (chunk) yield chunk
      }
    }

    buffer += decoder.decode()
    const { frames, remaining } = parseSSEFrames(buffer)
    for (const frame of frames) {
      const chunk = parseFrame(frame, true)
      if (chunk) yield chunk
    }
    if (remaining.trim()) {
      const event = remaining.match(/(?:^|\n)event:\s*([^\r\n]+)/)?.[1]
      const data = remaining
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      const chunk = parseFrame({ data, event }, true)
      if (chunk) yield chunk
    }
    if (!hasTerminalEvent) {
      throw new GeminiStreamError(
        'Gemini stream ended before a terminal event',
        { retryable: true, cause: undefined },
      )
    }
  } finally {
    reader.releaseLock()
    cleanupRequest()
  }
}
