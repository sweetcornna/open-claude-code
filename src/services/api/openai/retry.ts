import {
  classifyRetryableAPIError,
  getAPIErrorDiagnostics,
  isAPIErrorReplayable,
  PERMANENT_RETRY_DELAY_MS,
} from '../retryClassification.js'

/** Ten retries after the initial request (eleven total attempts). */
const OPENAI_MAX_RETRIES = 10
const DEFAULT_MAX_RETRIES = OPENAI_MAX_RETRIES
const BASE_DELAY_MS = 200
/**
 * Longest server-directed wait for one retry. Longer Retry-After values are
 * capped so every API error can consume the configured budget without one
 * malformed or multi-hour header parking the process indefinitely.
 */
const RETRY_AFTER_MAX_MS = 60_000
/**
 * Ceiling on one exponential backoff step, matching `getRetryDelay` in
 * withRetry.ts. Uncapped, `200 * 2^n` over the ten-retry budget spends its last
 * three waits at ~26s, ~51s and ~102s — nearly three minutes of the total sat
 * in a single sleep, for a ladder whose point is to outlast a blip.
 */
const MAX_BACKOFF_MS = 32_000
const TRANSIENT_RETRIES_EXHAUSTED = Symbol.for(
  'occ.api.transientRetriesExhausted',
)

type OpenAIRetryDelay = (delayMs: number, signal: AbortSignal) => Promise<void>

export class OpenAIRequestError extends Error {
  readonly retryable: boolean
  readonly replayable: boolean
  readonly retryAfterMs: number | undefined
  readonly type: string | undefined
  readonly code: string | number | undefined
  readonly status: string | number | undefined
  readonly headers: Headers | undefined

  constructor(
    message: string,
    options: {
      retryable: boolean
      replayable?: boolean
      retryAfterMs?: number
      type?: string
      code?: string | number
      status?: string | number
      headers?: Headers
      cause?: unknown
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'OpenAIRequestError'
    this.retryable = options.retryable
    this.replayable = options.replayable !== false
    this.retryAfterMs = options.retryAfterMs
    this.type = options.type
    this.code = options.code
    this.status = options.status
    this.headers = options.headers
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

function defaultDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function clampOpenAIMaxRetries(
  value: number,
  fallback = DEFAULT_MAX_RETRIES,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(OPENAI_MAX_RETRIES, Math.max(0, Math.trunc(value)))
}

export function resolveOpenAIMaxRetries(
  raw = process.env.OPENAI_REQUEST_MAX_RETRIES,
): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_MAX_RETRIES
  }
  return clampOpenAIMaxRetries(Number.parseInt(raw, 10))
}

/**
 * The header's own value, deliberately unclamped — {@link retryOpenAIRequest}
 * needs to tell "wait 5s" apart from "wait 5 hours", and a clamp here erases
 * exactly that difference.
 */
function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1000
  }
  const retryAt = Date.parse(trimmed)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, retryAt - nowMs)
}

/**
 * `Please try again in 1.5s` — the only place a mid-stream rate limit states
 * how long to wait.
 *
 * An SSE `response.failed` event carries no HTTP headers, so `Retry-After` is
 * structurally unavailable there and the ladder falls back to its 200ms first
 * step: it re-asks a limiter that just said "1.5s" roughly eight times before
 * the backoff even reaches the stated wait, and can burn the whole budget on a
 * limit that would have cleared. OpenAI's own client reads the number out of
 * the prose for exactly this reason (codex-rs/codex-api/src/sse/responses.rs
 * `try_parse_retry_after`, lines 602-626).
 *
 * Gated on the rate-limit code like Codex's is: prose in any other error class
 * is not a scheduling instruction, and a stray "try again in" in, say, a 400
 * body must not be able to stall the ladder.
 */
export function parseRetryAfterFromErrorPayload(
  error: Record<string, unknown>,
): number | undefined {
  const code = error.code
  if (typeof code !== 'string' || code !== 'rate_limit_exceeded')
    return undefined
  const message = error.message
  if (typeof message !== 'string') return undefined
  const matched = message.match(
    /try again in\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i,
  )
  if (!matched?.[1] || !matched[2]) return undefined
  const value = Number.parseFloat(matched[1])
  if (!Number.isFinite(value) || value < 0) return undefined
  const unit = matched[2].toLowerCase()
  return unit === 'ms' || unit.startsWith('milli') ? value : value * 1000
}

function parsedResponseError(
  body: string,
): Record<string, unknown> | undefined {
  if (!body.trim()) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const nested =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : record
    const result: Record<string, unknown> = {}
    for (const key of ['message', 'type', 'code', 'status', 'request_id']) {
      const value = nested[key] ?? record[key]
      if (typeof value === 'string' || typeof value === 'number') {
        result[key] = value
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    return undefined
  }
}

export async function createOpenAIResponseError(
  response: Response,
  label: string,
): Promise<OpenAIRequestError> {
  const body = await response.text().catch(() => '')
  const details = parsedResponseError(body)
  const safeMessage = details
    ? getAPIErrorDiagnostics(details).message
    : undefined
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
  // Deliberately not a hand-rolled status list any more. This function knows
  // the status and nothing else, so it asks the same classifier the ladders
  // read. Replay safety is decided separately by the stream producer once
  // output has crossed the commitment boundary.
  const retryable = classifyRetryableAPIError({
    ...(details ?? {}),
    status: response.status,
  }).retryable
  return new OpenAIRequestError(
    `${label} request failed (${response.status})${safeMessage ? `: ${safeMessage}` : ''}`,
    {
      retryable,
      retryAfterMs,
      status: response.status,
      headers: response.headers,
      ...(details ? { cause: details } : {}),
    },
  )
}

function markRetryBudgetExhausted(error: unknown): void {
  if (typeof error !== 'object' || error === null) return
  try {
    Object.defineProperty(error, TRANSIENT_RETRIES_EXHAUSTED, {
      value: true,
      configurable: true,
    })
  } catch {
    // A frozen third-party error cannot carry the marker. The original error is
    // still rethrown; this only affects the outer de-duplication guard.
  }
}

function retryAfterMsFromError(error: unknown): number | undefined {
  // An OpenAIRequestError may carry the parsed value, the raw headers, or both:
  // `createOpenAIResponseError` only pre-parses `retry-after`, so a response
  // that used `retry-after-ms` alone still has to be read off the headers.
  if (error instanceof OpenAIRequestError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs
  }
  const headers =
    typeof error === 'object' && error !== null && 'headers' in error
      ? (error as { headers?: unknown }).headers
      : undefined
  if (!(headers instanceof Headers)) return undefined

  const retryAfterMs = headers.get('retry-after-ms')
  if (retryAfterMs !== null) {
    const parsed = Number(retryAfterMs)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return parseRetryAfterMs(headers.get('retry-after'))
}

function retryDelayMs(retryIndex: number, random: () => number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** retryIndex, MAX_BACKOFF_MS)
  return Math.round(exponential * (0.9 + random() * 0.2))
}

export async function retryOpenAIRequest<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    signal: AbortSignal
    maxRetries?: number
    delay?: OpenAIRetryDelay
    random?: () => number
  },
): Promise<T> {
  const maxRetries =
    options.maxRetries === undefined
      ? resolveOpenAIMaxRetries()
      : clampOpenAIMaxRetries(options.maxRetries)
  const delay = options.delay ?? defaultDelay
  const random = options.random ?? Math.random
  let attempt = 0

  while (true) {
    if (options.signal.aborted) throw abortReason(options.signal)
    try {
      return await operation(attempt)
    } catch (error) {
      const verdict = classifyRetryableAPIError(error)
      if (
        options.signal.aborted ||
        !verdict.retryable ||
        !isAPIErrorReplayable(error)
      ) {
        throw error
      }
      if (attempt >= maxRetries) {
        markRetryBudgetExhausted(error)
        throw error
      }
      const retryAfterMs = retryAfterMsFromError(error)
      const backoffMs =
        verdict.persistence === 'permanent'
          ? PERMANENT_RETRY_DELAY_MS
          : retryDelayMs(attempt, random)
      await delay(
        retryAfterMs === undefined
          ? backoffMs
          : Math.min(retryAfterMs, RETRY_AFTER_MAX_MS),
        options.signal,
      )
      attempt++
    }
  }
}
