const DEFAULT_MAX_RETRIES = 4
const BASE_DELAY_MS = 200
const RETRY_AFTER_MAX_MS = 60_000

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

function resolveOpenAIMaxRetries(
  raw = process.env.OPENAI_REQUEST_MAX_RETRIES,
): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_MAX_RETRIES
  }
  return Number.parseInt(raw, 10)
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
    response.status >= 500 ||
    (response.status === 429 && retryAfterMs !== undefined)
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
  if (error instanceof OpenAIRequestError) return error.retryable
  return !isAbortError(error)
}

function retryDelayMs(retryIndex: number, random: () => number): number {
  const exponential = BASE_DELAY_MS * 2 ** retryIndex
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
  const maxRetries = options.maxRetries ?? resolveOpenAIMaxRetries()
  const delay = options.delay ?? defaultDelay
  const random = options.random ?? Math.random
  let attempt = 0

  while (true) {
    if (options.signal.aborted) throw abortReason(options.signal)
    try {
      return await operation(attempt)
    } catch (error) {
      if (
        options.signal.aborted ||
        attempt >= maxRetries ||
        !shouldRetry(error)
      ) {
        throw error
      }
      const retryAfterMs =
        error instanceof OpenAIRequestError ? error.retryAfterMs : undefined
      await delay(retryAfterMs ?? retryDelayMs(attempt, random), options.signal)
      attempt++
    }
  }
}
