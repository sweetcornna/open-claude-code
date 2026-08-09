import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const API_ERROR_SOURCE = Symbol.for('occ.api.sourceError')

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 529])
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EADDRNOTAVAIL',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_NETWORK',
  'ERR_NETWORK_CHANGED',
])
const ABORT_ERROR_PATTERN =
  /(request was aborted|operation was aborted|aborterror|user abort)/i
const DETERMINISTIC_TLS_PATTERN =
  /(certificate|self[ -]signed|unable to verify|ssl routines|ssl\/tls alert|tls alert|handshake failure|wrong version number)/i
const TRANSIENT_ERROR_MESSAGE_PATTERN =
  /fetch failed|terminated|socket hang ?up|body timeout error|headers timeout error|premature close|network error|network changed|connection (?:error|closed|reset|refused|timeout)|other side closed|client network socket disconnected|sse stream disconnected|failed to reconnect sse stream|request timed out|read timeout|timeout error|stream idle timeout|without receiving any events|upstream request failed|upstream connect error|no healthy upstream|bad gateway|service unavailable|gateway time-?out|internal server error|temporarily unavailable|overloaded_error|server_error|try again later|econnreset|econnrefused|epipe|etimedout|enotfound|eai_again|ehostunreach|enetunreach|enetdown|ehostdown|eaddrnotavail|und_err_/i
const ADAPTER_HTTP_STATUS_PATTERN = /request failed \((\d{3})[\s):]/
const SDK_HTTP_STATUS_PATTERN = /^(?:API Error(?: \([^)]*\))?:\s*)?(\d{3})\s/

export type RetryableAPIErrorClassification = {
  category: SDKAssistantMessageError
  retryable: boolean
}

function asErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Walk only fields used by known SDK and SSE error envelopes. Avoid scanning
 * arbitrary response payloads: a permanent 400 body can legitimately mention a
 * 500-token limit, and that number must never become a retry signal.
 */
function collectErrorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  const pending: unknown[] = [error]
  const seen = new Set<object>()

  while (pending.length > 0 && records.length < 16) {
    const current = pending.shift()
    const record = asErrorRecord(current)
    if (!record || seen.has(record)) continue
    seen.add(record)
    records.push(record)
    for (const key of ['error', 'response', 'data', 'cause']) {
      if (record[key] !== undefined) pending.push(record[key])
    }
  }
  return records
}

function errorMessages(
  error: unknown,
  records: Record<string, unknown>[],
): string[] {
  const messages = typeof error === 'string' ? [error] : []
  for (const record of records) {
    if (typeof record.message === 'string') messages.push(record.message)
  }
  return messages
}

function httpStatusCategory(status: number): SDKAssistantMessageError {
  if (status === 401 || status === 403) return 'authentication_failed'
  if (status === 402) return 'billing_error'
  if (status === 429 || status === 529) return 'rate_limit'
  if (status === 408 || status === 409 || status === 425) return 'server_error'
  if (status >= 400 && status < 500) return 'invalid_request'
  if (status >= 500 && status < 600) return 'server_error'
  return 'unknown'
}

function classifyHttpStatus(status: number): RetryableAPIErrorClassification {
  return {
    category: httpStatusCategory(status),
    retryable:
      RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status < 600),
  }
}

function numericHttpStatus(
  value: unknown,
  allowNumericString: boolean,
): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (
    allowNumericString &&
    typeof value === 'string' &&
    /^\d{3}$/.test(value.trim())
  ) {
    return Number(value)
  }
  return undefined
}

function signalCategory(
  signal: string,
): RetryableAPIErrorClassification | undefined {
  const normalized = signal
    .trim()
    .toUpperCase()
    .replace(/[ .-]+/g, '_')
  if (!normalized) return undefined

  if (
    RETRYABLE_NETWORK_CODES.has(normalized) ||
    normalized.startsWith('UND_ERR_')
  ) {
    return { category: 'server_error', retryable: true }
  }
  if (
    /(?:^|_)(?:RESOURCE_EXHAUSTED|RATE_LIMIT|OVERLOAD(?:ED)?)(?:_|$)/.test(
      normalized,
    )
  ) {
    return { category: 'rate_limit', retryable: true }
  }
  if (
    /(?:^|_)(?:API_ERROR|SERVER|INTERNAL|UNAVAILABLE|DEADLINE|TIMEOUT)(?:_|$)/.test(
      normalized,
    )
  ) {
    return { category: 'server_error', retryable: true }
  }
  if (
    /(?:AUTH|UNAUTHENTICATED|API_KEY|PERMISSION|FORBIDDEN)/.test(normalized)
  ) {
    return { category: 'authentication_failed', retryable: false }
  }
  if (/(?:BILLING|PAYMENT|CREDIT_BALANCE)/.test(normalized)) {
    return { category: 'billing_error', retryable: false }
  }
  if (
    /(?:INVALID|BAD_REQUEST|NOT_FOUND|CONTEXT_LENGTH|TOO_LARGE|UNSUPPORTED)/.test(
      normalized,
    )
  ) {
    return { category: 'invalid_request', retryable: false }
  }
  return undefined
}

function statusFromMessage(message: string): number | undefined {
  for (const pattern of [
    ADAPTER_HTTP_STATUS_PATTERN,
    SDK_HTTP_STATUS_PATTERN,
  ]) {
    const matched = message.match(pattern)?.[1]
    if (matched !== undefined) return Number(matched)
  }
  return undefined
}

function knownErrorCategory(
  records: Record<string, unknown>[],
  messages: string[],
): SDKAssistantMessageError {
  for (const record of records) {
    const status = numericHttpStatus(record.status, true)
    if (status !== undefined) return httpStatusCategory(status)
  }
  for (const record of records) {
    for (const key of ['type', 'code', 'status'] as const) {
      const value = record[key]
      const numericCode =
        key === 'code' ? numericHttpStatus(value, true) : undefined
      if (numericCode !== undefined) return httpStatusCategory(numericCode)
      if (typeof value !== 'string') continue
      const classified = signalCategory(value)
      if (classified) return classified.category
    }
  }
  for (const message of messages) {
    const status = statusFromMessage(message)
    if (status !== undefined) return httpStatusCategory(status)
    const classified = signalCategory(message)
    if (classified) return classified.category
  }
  return 'unknown'
}

/**
 * Classify SDK errors, hand-written fetch errors, and SSE error envelopes.
 *
 * Precedence is part of the contract: abort > deterministic TLS > an explicit
 * retryable:false > HTTP status > type/code/status > retryable:true > message.
 * Unknown failures are permanent by default.
 */
export function classifyRetryableAPIError(
  error: unknown,
): RetryableAPIErrorClassification {
  const records = collectErrorRecords(error)
  const messages = errorMessages(error, records)
  const knownCategory = knownErrorCategory(records, messages)

  if (
    error instanceof APIUserAbortError ||
    records.some(record => record.name === 'AbortError') ||
    messages.some(message => ABORT_ERROR_PATTERN.test(message))
  ) {
    return { category: 'unknown', retryable: false }
  }

  const connectionDetails = extractConnectionErrorDetails(error)
  if (
    connectionDetails?.isSSLError ||
    connectionDetails?.code.startsWith('ERR_SSL_') ||
    (connectionDetails?.code === 'EPROTO' &&
      /ssl|tls|handshake/i.test(connectionDetails.message)) ||
    records.some(record =>
      typeof record.code === 'string'
        ? record.code.startsWith('ERR_SSL_') ||
          record.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
        : false,
    ) ||
    messages.some(message => DETERMINISTIC_TLS_PATTERN.test(message))
  ) {
    return { category: 'unknown', retryable: false }
  }

  if (records.some(record => record.retryable === false)) {
    return { category: knownCategory, retryable: false }
  }

  for (const record of records) {
    const status = numericHttpStatus(record.status, true)
    if (status !== undefined) return classifyHttpStatus(status)
  }

  for (const record of records) {
    for (const key of ['type', 'code', 'status'] as const) {
      const value = record[key]
      const numericCode =
        key === 'code' ? numericHttpStatus(value, true) : undefined
      if (numericCode !== undefined) return classifyHttpStatus(numericCode)
      if (typeof value !== 'string') continue
      const classified = signalCategory(value)
      if (classified) return classified
    }
  }

  if (records.some(record => record.retryable === true)) {
    return {
      category: knownCategory === 'unknown' ? 'server_error' : knownCategory,
      retryable: true,
    }
  }

  for (const message of messages) {
    const status = statusFromMessage(message)
    if (status !== undefined) return classifyHttpStatus(status)
  }
  if (messages.some(message => TRANSIENT_ERROR_MESSAGE_PATTERN.test(message))) {
    return { category: 'server_error', retryable: true }
  }

  return { category: knownCategory, retryable: false }
}

export function isRetryableAPIError(error: unknown): boolean {
  return classifyRetryableAPIError(error).retryable
}

export function categorizeRetryableAPIError(
  error: unknown,
): SDKAssistantMessageError {
  return classifyRetryableAPIError(error).category
}

/** Attach the raw producer error without exposing it to JSON or SDK schemas. */
export function attachAPIErrorSource<T extends object>(
  message: T,
  sourceError: unknown,
): T {
  Object.defineProperty(message, API_ERROR_SOURCE, {
    value: sourceError,
    configurable: true,
  })
  return message
}

export function getAPIErrorSource(message: unknown): unknown | undefined {
  const record = asErrorRecord(message) as
    | Record<PropertyKey, unknown>
    | undefined
  return record?.[API_ERROR_SOURCE]
}
