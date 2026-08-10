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
/**
 * Wording that can only describe a permanently-broken request or local setup.
 *
 * The trailing group is the defence-in-depth half of {@link NonRetryableError}:
 * occ throws these itself for a missing login or an unprovisioned account, and
 * they must stay permanent even when the object loses its `retryable` field on
 * the way here (re-wrapped by a caller, serialized, or reconstructed from text
 * alone). Keep additions to phrasing no transient failure can produce — "run
 * /login" is safe, a bare "retry" or "unavailable" is not.
 */
const PERMANENT_ERROR_MESSAGE_PATTERN =
  /prompt is too long|maximum output length|max(?:imum)?[_\s`-]*tokens?.*(?:exceed|limit)|context (?:length|window|limit).*(?:exceed|limit|too long)|exceed.*context limit|invalid (?:api key|argument|model|request)|model.{0,40}(?:not found|does not exist|unknown)|(?:not found|unknown).{0,40}model|permission denied|not authorized|authentication failed|refresh access token|default credentials|invalid_grant|credit balance|billing error|payment required|unsupported (?:model|request|parameter)|image.{0,40}(?:exceed|too large)|maximum of \d+ pdf pages|pdf.{0,40}password protected|is not logged in|run \/login|returned no project/i
const ADAPTER_HTTP_STATUS_PATTERN = /request failed \((\d{3})[\s):]/
const SDK_HTTP_STATUS_PATTERN = /^(?:API Error(?: \([^)]*\))?:\s*)?(\d{3})\s/

export type RetryableAPIErrorClassification = {
  category: SDKAssistantMessageError
  retryable: boolean
}

/**
 * A failure occ constructs itself, for a local condition no retry can change —
 * "you are not logged in", "this account has no project". No request was ever
 * put on the wire, so there is nothing transient to outlast.
 *
 * The `retryable: false` field is what earns that: it is the classifier's
 * highest-precedence signal below abort/TLS (see
 * {@link classifyRetryableAPIError}), the same one `responsesAdapter.ts` uses to
 * pin a committed stream failure as permanent. Without it these land in the
 * default-retry tail — a plain `new Error('… Run /login …')` matches no
 * transient pattern and no permanent keyword, so the ladder spends eleven
 * attempts and ~2 minutes re-reading the same empty credentials file.
 *
 * `category` is explicit rather than inferred, so the SDK error surface does not
 * hinge on the prose ever matching a regex.
 */
export class NonRetryableError extends Error {
  readonly retryable = false
  readonly category: SDKAssistantMessageError

  constructor(
    message: string,
    options: { category: SDKAssistantMessageError; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'NonRetryableError'
    this.category = options.category
  }
}

const SDK_ERROR_CATEGORIES = new Set<string>([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
  'unknown',
  'max_output_tokens',
])

/**
 * A category the thrower stated outright (see {@link NonRetryableError}).
 * Only exact enum members count, so a provider payload that happens to carry an
 * unrelated `category` string cannot steer the classification.
 */
function declaredCategory(
  records: Record<string, unknown>[],
): SDKAssistantMessageError | undefined {
  for (const record of records) {
    const value = record.category
    if (typeof value === 'string' && SDK_ERROR_CATEGORIES.has(value)) {
      return value as SDKAssistantMessageError
    }
  }
  return undefined
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
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
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
    /(?:^|_)(?:RESOURCE_EXHAUSTED|RATE_LIMIT|THROTTLING|OVERLOAD(?:ED)?)(?:_|$)/.test(
      normalized,
    )
  ) {
    return { category: 'rate_limit', retryable: true }
  }
  if (
    /(?:^|_)(?:API_ERROR|SERVER|INTERNAL|UNAVAILABLE|ABORTED|DEADLINE|TIMEOUT|MODEL_STREAM_ERROR)(?:_|$)/.test(
      normalized,
    )
  ) {
    return { category: 'server_error', retryable: true }
  }
  if (
    /(?:ACCESS_DENIED|UNRECOGNIZED_CLIENT|EXPIRED_TOKEN|INVALID_SIGNATURE|NOT_AUTHORIZED|PERMISSION_DENIED|AUTH|UNAUTHENTICATED|API_KEY|CREDENTIAL|PERMISSION|FORBIDDEN)/.test(
      normalized,
    )
  ) {
    return { category: 'authentication_failed', retryable: false }
  }
  if (/(?:BILLING|PAYMENT|CREDIT_BALANCE)/.test(normalized)) {
    return { category: 'billing_error', retryable: false }
  }
  if (
    /(?:INVALID|VALIDATION|BAD_REQUEST|NOT_FOUND|FAILED_PRECONDITION|OUT_OF_RANGE|CONTEXT_LENGTH|TOO_LARGE|UNSUPPORTED|UNIMPLEMENTED)/.test(
      normalized,
    )
  ) {
    return { category: 'invalid_request', retryable: false }
  }
  return undefined
}

function structuredSignalClassification(
  records: Record<string, unknown>[],
  permanentOnly: boolean,
): RetryableAPIErrorClassification | undefined {
  for (const record of records) {
    for (const key of ['type', 'code', 'status', 'name'] as const) {
      const value = record[key]
      const numericCode =
        key === 'code' ? numericHttpStatus(value, true) : undefined
      const classification =
        numericCode !== undefined
          ? classifyHttpStatus(numericCode)
          : typeof value === 'string'
            ? signalCategory(value)
            : undefined
      if (classification && (!permanentOnly || !classification.retryable)) {
        return classification
      }
    }
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

function permanentMessageCategory(
  message: string,
): SDKAssistantMessageError | undefined {
  if (!PERMANENT_ERROR_MESSAGE_PATTERN.test(message)) return undefined
  if (
    /api key|not authorized|authentication|permission denied|refresh access token|default credentials|invalid_grant|is not logged in|run \/login/i.test(
      message,
    )
  ) {
    return 'authentication_failed'
  }
  if (/credit balance|billing|payment required/i.test(message)) {
    return 'billing_error'
  }
  return 'invalid_request'
}

function knownErrorCategory(
  records: Record<string, unknown>[],
  messages: string[],
): SDKAssistantMessageError {
  const declared = declaredCategory(records)
  if (declared) return declared

  const permanentSignal = structuredSignalClassification(records, true)
  if (permanentSignal) return permanentSignal.category

  for (const record of records) {
    const status = numericHttpStatus(record.status, true)
    if (status !== undefined) return httpStatusCategory(status)
  }
  const structuredSignal = structuredSignalClassification(records, false)
  if (structuredSignal) return structuredSignal.category

  for (const message of messages) {
    const status = statusFromMessage(message)
    if (status !== undefined) return httpStatusCategory(status)
    const classified = signalCategory(message)
    if (classified) return classified.category
    const permanent = permanentMessageCategory(message)
    if (permanent) return permanent
  }
  return 'unknown'
}

/**
 * Classify SDK errors, hand-written fetch errors, and SSE error envelopes.
 *
 * Precedence is part of the contract: abort > deterministic TLS > an explicit
 * retryable:false > permanent type/code/name > HTTP status > other structured
 * signals > retryable:true > message. Unknown values at an API boundary retry
 * by default; nullish non-errors do not.
 */
export function classifyRetryableAPIError(
  error: unknown,
): RetryableAPIErrorClassification {
  if (
    error === null ||
    error === undefined ||
    (typeof error === 'string' && !error.trim())
  ) {
    return { category: 'unknown', retryable: false }
  }

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

  const permanentSignal = structuredSignalClassification(records, true)
  if (permanentSignal) return permanentSignal

  for (const record of records) {
    const status = numericHttpStatus(record.status, true)
    if (status !== undefined) return classifyHttpStatus(status)
  }

  const structuredSignal = structuredSignalClassification(records, false)
  if (structuredSignal) return structuredSignal

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
  for (const message of messages) {
    const permanent = permanentMessageCategory(message)
    if (permanent) return { category: permanent, retryable: false }
  }
  if (
    knownCategory === 'authentication_failed' ||
    knownCategory === 'billing_error' ||
    knownCategory === 'invalid_request'
  ) {
    return { category: knownCategory, retryable: false }
  }
  if (messages.some(message => TRANSIENT_ERROR_MESSAGE_PATTERN.test(message))) {
    return { category: 'server_error', retryable: true }
  }

  return {
    category: knownCategory === 'unknown' ? 'server_error' : knownCategory,
    retryable: true,
  }
}

export type APIErrorDiagnostics = {
  provider?: string
  wire?: string
  status?: string | number
  code?: string | number
  type?: string
  requestId?: string
  name?: string
  message?: string
  category: SDKAssistantMessageError
  retryable: boolean
}

export type APIErrorDiagnosticContext = {
  provider?: string
  wire?: string
  message?: string
}

function sanitizeDiagnosticText(value: string, maxLength: number): string {
  let sanitized = value.replace(
    /\b(?:https?|wss?):\/\/[^\s"'<>}\]]+/gi,
    candidate => {
      try {
        const url = new URL(candidate)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[URL]'
      }
    },
  )
  sanitized = sanitized
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
    .replace(
      /(["']?(?:(?:proxy[-_ ]?)?authorization|cookie|credential|password|secret|token|api[-_]?key)["']?\s*(?::|=|\b(?:is|was)\b)\s*)[\s\S]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(["']?(?:prompt|input|messages|request(?:[-_ ]?body|[-_ ]?payload)|body|payload)["']?\s*(?::|=|\b(?:is|was)\b)\s*)[\s\S]*/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|xai|AIza)[-_A-Za-z0-9]{8,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized.length > maxLength
    ? `${sanitized.slice(0, maxLength - 1)}…`
    : sanitized
}

function embeddedErrorRecords(messages: string[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const message of messages) {
    const start = message.indexOf('{')
    const end = message.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      records.push(
        ...collectErrorRecords(JSON.parse(message.slice(start, end + 1))),
      )
    } catch {
      // The original message remains available below.
    }
  }
  return records
}

function firstScalar(
  records: Record<string, unknown>[],
  keys: readonly string[],
): string | number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim()) {
        return sanitizeDiagnosticText(value, 160)
      }
    }
  }
  return undefined
}

function requestIdFromHeaders(
  records: Record<string, unknown>[],
): string | undefined {
  const names = [
    'x-request-id',
    'request-id',
    'openai-request-id',
    'x-goog-request-id',
  ]
  for (const record of records) {
    const headers = record.headers
    if (headers instanceof Headers) {
      for (const name of names) {
        const value = headers.get(name)
        if (value) return sanitizeDiagnosticText(value, 160)
      }
      continue
    }
    const headerRecord = asErrorRecord(headers)
    if (!headerRecord) continue
    for (const name of names) {
      const value = headerRecord[name]
      if (typeof value === 'string' && value.trim()) {
        return sanitizeDiagnosticText(value, 160)
      }
    }
  }
  return undefined
}

function diagnosticMessage(
  error: unknown,
  records: Record<string, unknown>[],
  messages: string[],
): string | undefined {
  const expanded = [...records, ...embeddedErrorRecords(messages)]
  for (let index = expanded.length - 1; index >= 0; index--) {
    const message = expanded[index]?.message
    if (typeof message !== 'string' || !message.trim()) continue
    const sanitized = sanitizeDiagnosticText(message, 500)
    if (sanitized) return sanitized
  }
  if (typeof error === 'string') {
    const sanitized = sanitizeDiagnosticText(error, 500)
    return sanitized || undefined
  }
  return undefined
}

export function getAPIErrorDiagnostics(
  error: unknown,
  context: APIErrorDiagnosticContext = {},
): APIErrorDiagnostics {
  const records = collectErrorRecords(error)
  const messages = errorMessages(error, records)
  const classification = classifyRetryableAPIError(error)
  const status = firstScalar(records, ['status', 'statusCode', 'httpStatus'])
  const code = firstScalar(records, ['code'])
  const type = firstScalar(records, ['type'])
  const requestId =
    firstScalar(records, [
      'requestID',
      'requestId',
      'request_id',
      '_request_id',
    ]) ?? requestIdFromHeaders(records)
  const name = firstScalar(records, ['name'])
  const message = context.message
    ? sanitizeDiagnosticText(context.message, 500)
    : diagnosticMessage(error, records, messages)

  return {
    ...(context.provider
      ? { provider: sanitizeDiagnosticText(context.provider, 80) }
      : {}),
    ...(context.wire ? { wire: sanitizeDiagnosticText(context.wire, 80) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined && code !== status ? { code } : {}),
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
    ...(typeof name === 'string' && name !== 'Error' ? { name } : {}),
    ...(message ? { message } : {}),
    category: classification.category,
    retryable: classification.retryable,
  }
}

export function describeAPIError(
  error: unknown,
  context: APIErrorDiagnosticContext = {},
): {
  content: string
  errorDetails: string
  category: SDKAssistantMessageError
  retryable: boolean
} {
  const details = getAPIErrorDiagnostics(error, context)
  const label = details.provider
    ? `API Error [${details.provider}]`
    : 'API Error'
  const metadata = [
    details.wire ? `wire=${details.wire}` : undefined,
    details.status !== undefined ? `status=${details.status}` : undefined,
    details.code !== undefined ? `code=${details.code}` : undefined,
    details.type ? `type=${details.type}` : undefined,
    details.requestId ? `request_id=${details.requestId}` : undefined,
    details.name ? `name=${details.name}` : undefined,
    `category=${details.category}`,
    `retryable=${details.retryable ? 'yes' : 'no'}`,
  ].filter((value): value is string => value !== undefined)
  const content = `${label}: ${details.message ?? 'Request failed'} · ${metadata.join(' · ')}`

  return {
    content,
    errorDetails: JSON.stringify(details),
    category: details.category,
    retryable: details.retryable,
  }
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
