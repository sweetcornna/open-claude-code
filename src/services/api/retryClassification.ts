import { APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const API_ERROR_SOURCE = Symbol.for('occ.api.sourceError')

const RETRYABLE_HTTP_STATUSES = new Set([401, 408, 409, 429, 529])
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
  'ERR_SOCKET_CLOSED',
  'CONNECTIONCLOSED',
  'STREAMSUSPENDED',
])
const NON_RETRYABLE_CONNECTION_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'BEDROCKUNEXPECTEDCONTENTTYPE',
])
const ABORT_ERROR_PATTERN =
  /(request was aborted|operation was aborted|aborterror|user abort)/i
const DETERMINISTIC_TLS_PATTERN =
  /(certificate|self[ -]signed|unable to verify|ssl routines|ssl\/tls alert|tls alert|handshake failure|wrong version number)/i
const OVERLOADED_ERROR_PATTERN = /"type"\s*:\s*"overloaded_error"/i
const MAX_TOKENS_OVERFLOW_PATTERN =
  /input length and `max_tokens` exceed context limit/i
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

/** Classification lane retained for diagnostics and provider-shape precedence. */
type RetryPersistence = 'transient' | 'permanent'

export type RetryableAPIErrorClassification = {
  category: SDKAssistantMessageError
  retryable: boolean
  /** Retained for diagnostics; only retryable failures enter a delay lane. */
  persistence: RetryPersistence
}

/** Build a retryable verdict for an official transient class. */
function classify(
  category: SDKAssistantMessageError,
  persistence: RetryPersistence,
): RetryableAPIErrorClassification {
  return {
    category,
    persistence,
    retryable: true,
  }
}

/** A failure no policy retries: a user cancellation, or no error at all. */
function neverRetry(
  category: SDKAssistantMessageError,
): RetryableAPIErrorClassification {
  return { category, persistence: 'permanent', retryable: false }
}

/**
 * The category to report for a failure that came back from an API boundary.
 *
 * `unknown` is reserved for failures carrying no usable signal at all. Anything
 * that reached a provider and produced a payload we could not name is a
 * server-side failure and must be reported as one **regardless of the retry
 * verdict**. Reporting the same upstream failure as `unknown` when it was
 * non-retryable and `server_error` when transient would make one bug look like
 * two.
 */
function apiBoundaryCategory(
  category: SDKAssistantMessageError,
): SDKAssistantMessageError {
  return category === 'unknown' ? 'server_error' : category
}

/**
 * A failure occ constructs itself, for a local condition no retry can change —
 * "you are not logged in", "this account has no project". No request was ever
 * put on the wire, so there is nothing transient to outlast.
 *
 * The concrete class preserves the declared category even if the error is
 * wrapped before it reaches diagnostics.
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
  return RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status < 600)
    ? classify(httpStatusCategory(status), 'transient')
    : neverRetry(httpStatusCategory(status))
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
    return classify('server_error', 'transient')
  }
  if (
    /(?:^|_)(?:RESOURCE_EXHAUSTED|RATE_LIMIT|THROTTLING|OVERLOAD(?:ED)?)(?:_|$)/.test(
      normalized,
    )
  ) {
    return classify('rate_limit', 'transient')
  }
  // UPSTREAM_ERROR / STREAM_READ_ERROR are the Responses-API gateway's own
  // wording for a dropped upstream socket (`{"type":"response.failed",
  // "response":{"error":{"type":"upstream_error","code":"stream_read_error"}}}`).
  // Without them the pair named nothing, so the same failure was reported as
  // `server_error` when it reached the transient tail and `unknown` when it was
  // pinned permanent — see apiBoundaryCategory.
  if (
    /(?:^|_)(?:API_ERROR|SERVER|INTERNAL|UNAVAILABLE|ABORTED|DEADLINE|TIMEOUT|MODEL_STREAM_ERROR|UPSTREAM_ERROR|STREAM_READ_ERROR)(?:_|$)/.test(
      normalized,
    )
  ) {
    return classify('server_error', 'transient')
  }
  if (
    /(?:ACCESS_DENIED|UNRECOGNIZED_CLIENT|EXPIRED_TOKEN|INVALID_SIGNATURE|NOT_AUTHORIZED|PERMISSION_DENIED|AUTH|UNAUTHENTICATED|API_KEY|CREDENTIAL|PERMISSION|FORBIDDEN)/.test(
      normalized,
    )
  ) {
    return classify('authentication_failed', 'permanent')
  }
  if (/(?:BILLING|PAYMENT|CREDIT_BALANCE)/.test(normalized)) {
    return classify('billing_error', 'permanent')
  }
  // MODEL_DISABLED is a deployment saying "not this model", which arrives as a
  // 403 and would otherwise be classified from the status alone as
  // `authentication_failed` — sending the user to /login to repair a credential
  // that is working. OpenCode's `managed_inference_model_disabled` is the case
  // this was added for; the signal is read before the status, so the body's own
  // word wins over the HTTP class.
  //
  // MODELERROR is the same defect one gateway family further out. OpenCode's
  // Zen/Go gateway answers an id it does not serve with
  // `401 {"type":"error","error":{"type":"ModelError","message":"Model <id> is
  // not supported"}}` — measured against the live endpoint — and relays that
  // pass an upstream's body through verbatim reproduce it under their own
  // domain. 401 made it `authentication_failed`, so occ told the user their
  // credentials had failed for a key that had just authenticated well enough
  // for the gateway to look the model up and answer about it. `ModelError`
  // survives normalization with no separator, which is why the MODEL_DISABLED
  // alternative above does not already cover it.
  if (
    /(?:INVALID|VALIDATION|BAD_REQUEST|NOT_FOUND|FAILED_PRECONDITION|OUT_OF_RANGE|CONTEXT_LENGTH|TOO_LARGE|UNSUPPORTED|UNIMPLEMENTED|MODEL_DISABLED|MODEL_?ERROR)/.test(
      normalized,
    )
  ) {
    return classify('invalid_request', 'permanent')
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
      // Filtered on the lane so permanent provider signals keep precedence over
      // an outer transport-looking wrapper or HTTP status.
      if (
        classification &&
        (!permanentOnly || classification.persistence === 'permanent')
      ) {
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

function retryDirectiveFromRecords(
  records: Record<string, unknown>[],
): boolean | undefined {
  for (const record of records) {
    const headers = record.headers
    if (headers instanceof Headers) {
      const value = headers.get('x-should-retry')
      if (value === 'true') return true
      if (value === 'false') return false
      continue
    }
    const headerRecord = asErrorRecord(headers)
    const value =
      headerRecord?.['x-should-retry'] ?? headerRecord?.['X-Should-Retry']
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return undefined
}

function httpStatusFromRecordsOrMessages(
  records: Record<string, unknown>[],
  messages: string[],
): number | undefined {
  for (const record of records) {
    for (const key of ['status', 'statusCode', 'httpStatus']) {
      const status = numericHttpStatus(record[key], true)
      if (status !== undefined) return status
    }
  }
  for (const message of messages) {
    const status = statusFromMessage(message)
    if (status !== undefined) return status
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

function permanentStructuredCategory(
  records: Record<string, unknown>[],
): SDKAssistantMessageError | undefined {
  return structuredSignalClassification(records, true)?.category
}

function knownErrorCategory(
  records: Record<string, unknown>[],
  messages: string[],
): SDKAssistantMessageError {
  const declared = declaredCategory(records)
  if (declared) return declared

  const permanentSignal = structuredSignalClassification(records, true)
  if (permanentSignal) return permanentSignal.category

  const structuredSignal = structuredSignalClassification(records, false)
  if (structuredSignal) return structuredSignal.category

  for (const record of records) {
    const status = numericHttpStatus(record.status, true)
    if (status !== undefined) return httpStatusCategory(status)
  }

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
 * local {@link NonRetryableError} > permanent type/code/name > HTTP status > other
 * structured signals > retryable:true > message.
 *
 * The result mirrors the official CLI predicate: retryable transport failures,
 * 408/409/429/5xx, 401 credential refresh, explicit x-should-retry, and the
 * max_tokens adjustment case. Provider-specific type/code names only bridge
 * equivalent error shapes into that policy.
 */
export function classifyRetryableAPIError(
  error: unknown,
): RetryableAPIErrorClassification {
  if (
    error === null ||
    error === undefined ||
    (typeof error === 'string' && !error.trim())
  ) {
    return neverRetry('unknown')
  }

  const records = collectErrorRecords(error)
  const messages = errorMessages(error, records)
  const category = apiBoundaryCategory(knownErrorCategory(records, messages))
  const permanentCategory = permanentStructuredCategory(records)
  const explicitStatus = httpStatusFromRecordsOrMessages(records, messages)

  if (
    error instanceof APIUserAbortError ||
    records.some(record => record.name === 'AbortError') ||
    messages.some(message => ABORT_ERROR_PATTERN.test(message))
  ) {
    return neverRetry('unknown')
  }
  if (records.some(record => record instanceof NonRetryableError)) {
    return neverRetry(category)
  }

  const connectionDetails = extractConnectionErrorDetails(error)
  const connectionCode = connectionDetails?.code.toUpperCase()
  if (
    connectionDetails?.isSSLError ||
    (connectionCode !== undefined &&
      NON_RETRYABLE_CONNECTION_CODES.has(connectionCode)) ||
    connectionCode?.startsWith('ERR_SSL_') ||
    (connectionCode === 'EPROTO' &&
      /ssl|tls|handshake/i.test(connectionDetails?.message ?? '')) ||
    messages.some(message => DETERMINISTIC_TLS_PATTERN.test(message))
  ) {
    return neverRetry(category)
  }
  if (error instanceof APIConnectionError) {
    return classify('server_error', 'transient')
  }

  const retryDirective = retryDirectiveFromRecords(records)
  if (retryDirective !== undefined) {
    return retryDirective
      ? classify(category, 'transient')
      : neverRetry(category)
  }

  if (permanentCategory !== undefined) {
    return neverRetry(permanentCategory)
  }

  if (explicitStatus !== undefined) {
    const maxTokensOverflow = messages.some(message =>
      MAX_TOKENS_OVERFLOW_PATTERN.test(message),
    )
    return RETRYABLE_HTTP_STATUSES.has(explicitStatus) ||
      explicitStatus >= 500 ||
      maxTokensOverflow
      ? classify(category, 'transient')
      : neverRetry(category)
  }

  const structured = structuredSignalClassification(records, false)
  if (structured?.persistence === 'transient') {
    return classify(structured.category, 'transient')
  }

  if (
    messages.some(
      message =>
        OVERLOADED_ERROR_PATTERN.test(message) ||
        MAX_TOKENS_OVERFLOW_PATTERN.test(message) ||
        /fetch failed|terminated|socket hang ?up|body timeout error|headers timeout error|connection (?:error|closed|reset)|other side closed|premature close|stream idle timeout|without receiving any events|upstream request failed|no healthy upstream/i.test(
          message,
        ),
    )
  ) {
    return classify(category, 'transient')
  }

  if (records.some(record => record.retryable === true)) {
    return classify(category, 'transient')
  }

  return neverRetry(category)
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
  replayable: boolean
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
  const replayable = isAPIErrorReplayable(error)
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
    replayable,
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
  replayable: boolean
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
    details.replayable ? undefined : 'replayable=no',
  ].filter((value): value is string => value !== undefined)
  const content = `${label}: ${details.message ?? 'Request failed'} · ${metadata.join(' · ')}`

  return {
    content,
    errorDetails: JSON.stringify(details),
    category: details.category,
    retryable: details.retryable,
    replayable: details.replayable,
  }
}

export function isRetryableAPIError(error: unknown): boolean {
  return classifyRetryableAPIError(error).retryable
}

/** Whether repeating the current request can preserve exactly-once output. */
export function isAPIErrorReplayable(error: unknown): boolean {
  return !collectErrorRecords(error).some(record => record.replayable === false)
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
