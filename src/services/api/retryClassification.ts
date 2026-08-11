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

/**
 * How much another attempt is worth.
 *
 * `transient` earns the full ladder — ten retries with exponential backoff.
 * `permanent` is the set that almost never answers differently: authentication,
 * permission, invalid request, billing, a deterministic TLS failure, and the
 * unclassifiable tail of a 4xx. occ retries those too (see
 * {@link isRetryEveryAPIErrorEnabled}), but on {@link PERMANENT_RETRY_MAX_RETRIES}
 * attempts of {@link PERMANENT_RETRY_DELAY_MS} rather than the ladder, so a bad
 * tool schema still surfaces in about the time a hard failure used to.
 */
type RetryPersistence = 'transient' | 'permanent'

export type RetryableAPIErrorClassification = {
  category: SDKAssistantMessageError
  retryable: boolean
  /**
   * Which retry budget this failure belongs in. `retryable: false` always
   * implies `permanent`; the reverse does not hold — under the default policy a
   * permanent class is retried, just cheaply.
   */
  persistence: RetryPersistence
}

/**
 * Single documented switch for the retry-everything policy.
 *
 * On by default: every classified API failure gets at least one more attempt,
 * including the classes that used to fail immediately — `authentication_failed`,
 * `invalid_request`, `billing_error`, permission, and the unclassified
 * fall-through. Set `CLAUDE_CODE_RETRY_ALL_ERRORS` to `0`, `false`, `off` or
 * `no` to restore the previous fast-fail behaviour, where only transient
 * failures were retried at all.
 *
 * Two things this switch deliberately does not reach, because neither is an API
 * failure:
 *
 *  - **User cancellation** (`APIUserAbortError`, an `AbortError`, an aborted
 *    signal). Retrying a cancellation defeats Esc.
 *  - **An explicit `retryable: false` from the producer.** That field is how the
 *    stream adapters say "this attempt's output already reached the terminal,
 *    ACP and `--include-partial-messages` stdout; there is no protocol for
 *    un-saying it". See `closesRetryWindow` in `openai/responsesAdapter.ts`.
 *    It is also what occ's own {@link NonRetryableError} sets for a local
 *    precondition no request was ever made for.
 */
export function isRetryEveryAPIErrorEnabled(): boolean {
  const raw = process.env.CLAUDE_CODE_RETRY_ALL_ERRORS?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

/**
 * Retries granted to a `permanent` failure, on top of the initial request.
 *
 * One, not the ladder's ten. These classes answer the same way the second time
 * in nearly every case; the single extra attempt exists for the few that do not
 * — a credential rotated between the request and its 401 (`withRetry` drops the
 * stale credential cache *before* it decides, so attempt two is built from a
 * fresh one), or a gateway that briefly rejects a body it goes on to accept. A
 * second retry would double the cost of the common case to buy almost nothing.
 */
export const PERMANENT_RETRY_MAX_RETRIES = 1

/**
 * Backoff between the two attempts above. Fixed rather than exponential: there
 * is no congestion to back off from, and the whole point of this lane is that a
 * 400 for a malformed tool schema still surfaces in well under a second. The
 * transient ladder's *first* step alone is 500ms and its last is 32s.
 */
export const PERMANENT_RETRY_DELAY_MS = 250

/**
 * Build a verdict from the one thing the error actually tells us — its class —
 * and let the policy decide whether `permanent` still earns an attempt.
 */
function classify(
  category: SDKAssistantMessageError,
  persistence: RetryPersistence,
): RetryableAPIErrorClassification {
  return {
    category,
    persistence,
    retryable: persistence === 'transient' || isRetryEveryAPIErrorEnabled(),
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
 * pinned permanent and `server_error` when it was transient made one bug look
 * like two.
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
  return classify(
    httpStatusCategory(status),
    RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status < 600)
      ? 'transient'
      : 'permanent',
  )
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
  if (
    /(?:INVALID|VALIDATION|BAD_REQUEST|NOT_FOUND|FAILED_PRECONDITION|OUT_OF_RANGE|CONTEXT_LENGTH|TOO_LARGE|UNSUPPORTED|UNIMPLEMENTED|MODEL_DISABLED)/.test(
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
      // Filtered on the lane, not on `retryable`: under the retry-everything
      // policy a permanent class is retryable, so reading the boolean here
      // would silently stop giving permanent signals their precedence.
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
 * signals > retryable:true > message.
 *
 * What that precedence now decides is mostly the *lane*, not whether to retry:
 * every class the classifier can name is retryable under the default policy
 * (see {@link isRetryEveryAPIErrorEnabled}), with permanent classes routed to
 * the small budget in {@link PERMANENT_RETRY_MAX_RETRIES}. The two exceptions
 * are the first two rungs — a user cancellation, and a producer that declared
 * `retryable: false` because its output already went downstream.
 */
export function classifyRetryableAPIError(
  error: unknown,
): RetryableAPIErrorClassification {
  if (
    error === null ||
    error === undefined ||
    (typeof error === 'string' && !error.trim())
  ) {
    // Not an API failure — there is nothing here to attempt again.
    return neverRetry('unknown')
  }

  const records = collectErrorRecords(error)
  const messages = errorMessages(error, records)
  const knownCategory = knownErrorCategory(records, messages)

  if (
    error instanceof APIUserAbortError ||
    records.some(record => record.name === 'AbortError') ||
    messages.some(message => ABORT_ERROR_PATTERN.test(message))
  ) {
    // The user pressed Esc. Never retried, under any policy — see
    // isRetryEveryAPIErrorEnabled.
    return neverRetry('unknown')
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
    // A bad certificate or a protocol mismatch answers the same way every
    // time, and `getSSLErrorHint`'s NODE_EXTRA_CA_CERTS advice is only useful
    // if it arrives quickly — hence the cheap lane rather than the ladder.
    // Reported as whatever the error itself said, usually `unknown`: a
    // handshake that never completed produced no provider payload to name.
    return classify(knownCategory, 'permanent')
  }

  // The producer's own verdict, and the only "do not retry" this file honours
  // besides a cancellation. It is how a stream adapter reports that the
  // attempt's output already reached the terminal / ACP / partial-message
  // stdout, where nothing can be un-said. Overriding it replays the user's
  // output. See closesRetryWindow in openai/responsesAdapter.ts.
  if (records.some(record => record.retryable === false)) {
    return neverRetry(apiBoundaryCategory(knownCategory))
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
    return classify(apiBoundaryCategory(knownCategory), 'transient')
  }

  for (const message of messages) {
    const status = statusFromMessage(message)
    if (status !== undefined) return classifyHttpStatus(status)
  }
  for (const message of messages) {
    const permanent = permanentMessageCategory(message)
    if (permanent) return classify(permanent, 'permanent')
  }
  if (
    knownCategory === 'authentication_failed' ||
    knownCategory === 'billing_error' ||
    knownCategory === 'invalid_request'
  ) {
    return classify(knownCategory, 'permanent')
  }
  if (messages.some(message => TRANSIENT_ERROR_MESSAGE_PATTERN.test(message))) {
    return classify('server_error', 'transient')
  }

  return classify(apiBoundaryCategory(knownCategory), 'transient')
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
