/** Ten retries after the initial request (eleven total attempts). */
const OPENAI_MAX_RETRIES = 10
const DEFAULT_MAX_RETRIES = OPENAI_MAX_RETRIES
const BASE_DELAY_MS = 200
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
  readonly retryAfterMs: number | undefined

  constructor(
    message: string,
    options: {
      retryable: boolean
      retryAfterMs?: number
      cause?: unknown
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'OpenAIRequestError'
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
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

function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(Number.parseFloat(trimmed) * 1000, RETRY_AFTER_MAX_MS)
  }
  const retryAt = Date.parse(trimmed)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.min(Math.max(0, retryAt - nowMs), RETRY_AFTER_MAX_MS)
}

export async function createOpenAIResponseError(
  response: Response,
  label: string,
): Promise<OpenAIRequestError> {
  const body = await response.text().catch(() => '')
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
  const retryable =
    response.status === 408 ||
    response.status === 409 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  return new OpenAIRequestError(
    `${label} request failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ''}`,
    { retryable, retryAfterMs },
  )
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function shouldRetry(error: unknown): boolean {
  if (isAbortError(error)) return false
  if (error instanceof OpenAIRequestError) return error.retryable

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined
  if (typeof status === 'number') {
    return (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    )
  }

  if (!(error instanceof Error)) return false
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : ''
  return (
    error instanceof TypeError ||
    /^(?:ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/i.test(
      code,
    ) ||
    /fetch failed|terminated|socket hang ?up|network error|connection (?:error|closed|reset|refused|timeout)|request timed out|timeout error|premature close|upstream request failed|no healthy upstream|bad gateway|service unavailable|gateway time-?out/i.test(
      error.message,
    )
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
  if (error instanceof OpenAIRequestError) return error.retryAfterMs
  const headers =
    typeof error === 'object' && error !== null && 'headers' in error
      ? (error as { headers?: unknown }).headers
      : undefined
  if (!(headers instanceof Headers)) return undefined

  const retryAfterMs = headers.get('retry-after-ms')
  if (retryAfterMs !== null) {
    const parsed = Number(retryAfterMs)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed, RETRY_AFTER_MAX_MS)
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
      const retryable = shouldRetry(error)
      if (options.signal.aborted || !retryable) {
        throw error
      }
      if (attempt >= maxRetries) {
        markRetryBudgetExhausted(error)
        throw error
      }
      const retryAfterMs = retryAfterMsFromError(error)
      await delay(retryAfterMs ?? retryDelayMs(attempt, random), options.signal)
      attempt++
    }
  }
}
