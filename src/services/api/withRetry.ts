import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/auth/aws.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { logError } from 'src/utils/telemetry/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth/auth.js'
import { isEnvTruthy } from '../../utils/config/envUtils.js'
import { errorMessage } from '../../utils/runtime/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/model/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/network/proxy.js'
import { sleep } from '../../utils/process/sleep.js'
import type { ThinkingConfig } from '../../utils/model/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const abortError = () => new APIUserAbortError()

/** Ten retries after the initial request (eleven total attempts). */
const MAX_API_RETRIES = 10
const DEFAULT_MAX_RETRIES = MAX_API_RETRIES
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  // Workflow sub-agents: the user is blocked on the Workflow tool result, same
  // as Agent-tool subagents above. Without this, a 529 bails instantly, bubbles
  // up as agent death, and the engine's single retry re-fires into the same
  // congestion — one backed-off retry here is strictly less amplification.
  'workflow',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is ant-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (ant-only). Retries 429/529
// with higher backoff and periodic keep-alive yields so the host environment
// does not mark the session idle mid-wait. It shares the same ten-retry cap.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  // Bare transport failures (TypeError: fetch failed / Error: terminated) are
  // never APIConnectionError but carry the same ECONNRESET/EPIPE cause, and
  // they need the same keep-alive teardown before the retry reconnects.
  if (
    !(error instanceof APIConnectionError) &&
    !isTransientNetworkError(error)
  ) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

// ---------------------------------------------------------------------------
// Transient network error classification
//
// The Anthropic SDK only wraps failures it recognizes in `APIError`. Bun/undici
// transport failures escape as bare `TypeError: fetch failed` / `Error:
// terminated`, and non-conforming gateways can return a body the SDK never
// classifies at all. Those used to hit the `!(error instanceof APIError)` guard
// in the retry loop below and bail with zero retries — a single dropped socket
// killed the whole turn. Everything here exists to recognize that class so it
// gets the same 10-attempt exponential backoff as a first-party 500.
// ---------------------------------------------------------------------------

/**
 * Node/undici/libuv error codes that mean "the transport failed", not "the
 * request was wrong". Sourced from the two verified lists already in the repo
 * (`services/mcp/client.ts` terminal-connection errors and REPL.tsx's
 * connectivity-failure check) plus the undici `UND_ERR_*` family, which is
 * matched by prefix rather than enumerated.
 */
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
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
  // NOT EPROTO: in an HTTPS client that is almost always a TLS alert
  // ("write EPROTO ... ssl/tls alert handshake failure"), which is
  // deterministic. See isTlsError below.
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_NETWORK',
  'ERR_NETWORK_CHANGED',
])

/**
 * Fallback for errors whose cause chain carries no `code` (Bun's `fetch failed`
 * frequently has none). Matched case-insensitively against the error message.
 */
const TRANSIENT_NETWORK_MESSAGE_PATTERN = new RegExp(
  [
    'fetch failed',
    'terminated',
    'socket hang ?up',
    'body timeout error',
    'headers timeout error',
    'premature close',
    'network error',
    'network changed',
    'connection error',
    'connection closed',
    'connection reset',
    'connection refused',
    'connection timeout',
    'other side closed',
    'client network socket disconnected',
    'sse stream disconnected',
    'failed to reconnect sse stream',
    'request timed out',
    'read timeout',
    'timeout error',
    // Stream deaths thrown by claude.ts itself (the idle watchdog and the
    // "proxy answered 200 with a non-SSE body" guard). With
    // CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 these are the only signal a
    // turn ever gets, and nothing else here matches their wording.
    'stream idle timeout',
    'without receiving any events',
    'econnreset',
    'econnrefused',
    'epipe',
    'etimedout',
    'enotfound',
    'eai_again',
    'ehostunreach',
    'enetunreach',
    'enetdown',
    'ehostdown',
    'eaddrnotavail',
    'und_err_',
  ].join('|'),
  'i',
)

/**
 * Abort wording that must never be treated as transient — retrying a user
 * cancellation would resurrect a turn the user explicitly killed.
 */
const ABORT_MESSAGE_PATTERN =
  /(request was aborted|operation was aborted|aborterror|user abort)/i

/**
 * Gateway/proxy wording seen in front of third-party providers. These never
 * reach the SDK as an `APIError` because the proxy answers with its own body
 * (sometimes even with a 200), so only the text is available.
 */
const TRANSIENT_GATEWAY_MESSAGE_PATTERN = new RegExp(
  [
    'upstream request failed',
    'upstream connect error',
    'no healthy upstream',
    'bad gateway',
    'service unavailable',
    'gateway time-?out',
    'internal server error',
    'temporarily unavailable',
    'overloaded_error',
    'server_error',
    'try again later',
  ].join('|'),
  'i',
)

/** HTTP statuses worth another attempt. All other 4xx responses are permanent. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429])

function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status) || status >= 500
}

function getErrorHttpStatus(error: unknown): number | undefined {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined
  return typeof status === 'number' && Number.isInteger(status)
    ? status
    : undefined
}

/**
 * Status codes are only read from positions a known producer actually writes
 * them. Free-scanning the text for a delimited 3-digit number reads response
 * *bodies* too, so a permanent 400 whose body says "exceeded the 500 output
 * token maximum" would be retried ten times before failing. The two anchors:
 *
 *   - `<label> request failed (<status>)` / `(<status> <statusText>)` — every
 *     3P adapter that hand-rolls fetch (responsesAdapter.ts, gemini/client.ts,
 *     chatgptAuth.ts).
 *   - a leading `<status> ` — how both the Anthropic and OpenAI SDKs stringify
 *     an APIError, optionally behind our own `API Error[ (model)]: ` prefix.
 */
const ADAPTER_STATUS_PATTERN = /request failed \((\d{3})[\s):]/
const SDK_STATUS_PATTERN = /^(?:API Error(?: \([^)]*\))?:\s*)?(\d{3})\s/

function getHttpStatusFromText(text: string): number | undefined {
  for (const pattern of [ADAPTER_STATUS_PATTERN, SDK_STATUS_PATTERN]) {
    const status = text.match(pattern)?.[1]
    if (status !== undefined) return Number(status)
  }
  return undefined
}

function hasTransientNetworkCode(code: string): boolean {
  return TRANSIENT_NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')
}

/**
 * TLS/certificate failures are deterministic: the handshake will fail again
 * identically, and the user needs `getSSLErrorHint`'s NODE_EXTRA_CA_CERTS
 * advice now, not in three minutes. `SSL_ERROR_CODES` misses some OpenSSL
 * codes (e.g. ERR_SSL_PACKET_LENGTH_TOO_LONG), hence the prefix check.
 */
function isTlsError(details: {
  code: string
  message: string
  isSSLError: boolean
}): boolean {
  return (
    details.isSSLError ||
    details.code.startsWith('ERR_SSL_') ||
    // EPROTO out of an HTTPS client is a TLS alert in practice. It has to be
    // caught here rather than merely dropped from the transient-code set: an
    // outer `TypeError: fetch failed` wrapper would otherwise match on message
    // alone and retry the handshake ten times.
    (details.code === 'EPROTO' && /ssl|tls|handshake/i.test(details.message))
  )
}

/**
 * True when `error` is a transport-level blip that deserves a retry.
 *
 * Order matters: the abort check runs first (an aborted fetch surfaces as a
 * DOMException whose message would otherwise match the timeout patterns), then
 * the `cause` chain is walked for a real errno, and only then does the message
 * regex get a say.
 *
 * Exported for tests.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false
  }
  if (error instanceof APIUserAbortError) {
    return false
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return false
  }
  if (error instanceof FallbackTriggeredError) {
    return false
  }

  const message = error instanceof Error ? error.message : String(error)
  if (ABORT_MESSAGE_PATTERN.test(message)) {
    return false
  }

  const status = getErrorHttpStatus(error)
  if (status !== undefined) {
    if (isTransientHttpStatus(status)) return true
    if (status >= 400 && status < 500) return false
  }

  const syntheticRetryable =
    typeof error === 'object' && error !== null && 'retryable' in error
      ? (error as { retryable?: unknown }).retryable
      : undefined
  if (syntheticRetryable === false) return false
  if (syntheticRetryable === true) return true

  const details = extractConnectionErrorDetails(error)
  if (details) {
    // TLS check runs BEFORE the transient-code check: a handshake failure must
    // fail in seconds with getSSLErrorHint's advice, never after 10 backoffs.
    if (isTlsError(details)) {
      return false
    }
    if (hasTransientNetworkCode(details.code)) {
      return true
    }
  }

  // Unwrap CannotRetryError so callers can classify what actually failed.
  if (error instanceof CannotRetryError) {
    return isTransientNetworkError(error.originalError)
  }

  if (
    TRANSIENT_NETWORK_MESSAGE_PATTERN.test(message) ||
    TRANSIENT_GATEWAY_MESSAGE_PATTERN.test(message)
  ) {
    return true
  }

  // Walk the cause chain's messages too — undici nests the useful text.
  let cause: unknown = error instanceof Error ? error.cause : undefined
  for (let depth = 0; cause instanceof Error && depth < 5; depth++) {
    if (ABORT_MESSAGE_PATTERN.test(cause.message)) {
      return false
    }
    if (
      TRANSIENT_NETWORK_MESSAGE_PATTERN.test(cause.message) ||
      TRANSIENT_GATEWAY_MESSAGE_PATTERN.test(cause.message)
    ) {
      return true
    }
    cause = cause.cause
  }

  return false
}

/**
 * Message-text counterpart of {@link isTransientNetworkError}, for the one
 * place where only text survives: `queryModel` never throws — it converts every
 * failure into an `isApiErrorMessage` assistant message whose only payload is
 * `API Error: <text>`. Deliberately broader than the error-object classifier
 * because it also has to catch gateway prose and stringified 5xx statuses.
 *
 * Exported for tests.
 */
export function isTransientNetworkErrorText(text: string): boolean {
  if (!text) {
    return false
  }
  if (ABORT_MESSAGE_PATTERN.test(text)) {
    return false
  }
  const status = getHttpStatusFromText(text)
  if (status !== undefined) {
    if (isTransientHttpStatus(status)) return true
    if (status >= 400 && status < 500) return false
  }
  return (
    TRANSIENT_NETWORK_MESSAGE_PATTERN.test(text) ||
    TRANSIENT_GATEWAY_MESSAGE_PATTERN.test(text)
  )
}

/**
 * `createSystemAPIErrorMessage` (and the UI/SDK consumers behind it) are typed
 * on `APIError`. Bare transport failures aren't one, so wrap them — the retry
 * countdown row would otherwise be silent for exactly the errors this file was
 * changed to retry.
 */
function toRetryDisplayError(error: unknown): APIError {
  if (error instanceof APIError) {
    return error
  }
  const cause = error instanceof Error ? error : undefined
  return new APIConnectionError({
    message: cause ? cause.message : String(error),
    ...(cause ? { cause } : {}),
  })
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Check for mock rate limits (used by /mock-limits command for Ant employees)
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // Get a fresh client on the first attempt or after a stale keep-alive
      // socket. Authentication and permission failures are permanent for this
      // request and never reach another attempt — their credential caches are
      // dropped in the catch block instead, for the benefit of the next one.
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (client === null || isStaleConnection) {
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Before any retry decision: an auth failure ends this request either
      // way, but the stale credential behind it must not survive into the next
      // one. See recoverCredentialsForNextRequest.
      await recoverCredentialsForNextRequest(error)

      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Short retry-after: wait and retry with fast mode still active
          // to preserve prompt cache (same model name on retry).
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Long or unknown retry-after: enter cooldown (switches to standard
        // speed model), with a minimum floor to avoid flip-flopping.
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Claude Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, retryContext)
      }

      // Non-APIError used to bail here unconditionally, which meant a bare
      // `TypeError: fetch failed` (Bun/undici transport failure, or a gateway
      // body the SDK never classified) got zero retries while a first-party
      // 500 got ten. Transient transport failures now take the same ladder;
      // authentication and other permanent failures still fail immediately.
      const isRetriableBareError =
        !(error instanceof APIError) && isTransientNetworkError(error)
      if (
        !isRetriableBareError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // Ensure we have enough tokens for thinking + at least 1 output token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          if (minRequired > availableContext) {
            logError(
              new Error(
                `thinking minimum ${minRequired} exceeds available context ${availableContext}`,
              ),
            )
            throw error
          }
          // availableContext is already above the output floor and is the
          // largest value the retry can request without repeating the same
          // context overflow.
          const adjustedMaxTokens = availableContext
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getBoundedRetryDelay(attempt, retryAfter)
      }

      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          yield createSystemAPIErrorMessage(
            toRetryDisplayError(error),
            remaining,
            reportedAttempt,
            maxRetries,
          )
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
      } else {
        // Widened from `error instanceof APIError`: bare transport failures now
        // reach this point (see the guard above) and would otherwise retry in
        // complete silence — no countdown row in the REPL, no `api_retry` event
        // on the SDK stream.
        yield createSystemAPIErrorMessage(
          toRetryDisplayError(error),
          delayMs,
          attempt,
          maxRetries,
        )
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000
    }
    const retryAt = Date.parse(retryAfterHeader)
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now())
    }
  }

  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs)
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

/**
 * Ceiling on a server-supplied `Retry-After`.
 *
 * `getRetryDelay` deliberately lets the header bypass its exponential
 * `maxDelayMs` — obeying the server is the correct default — but nothing on the
 * wire is validated, and a gateway answering `Retry-After: 7200` would park the
 * turn for two hours behind a countdown row the user cannot shorten. One minute
 * is the same bound `openai/retry.ts` applies to the identical header.
 *
 * The unattended (`CLAUDE_CODE_UNATTENDED_RETRY`) branch keeps its own, far
 * larger cap on purpose: nobody is watching that session, and waiting out a
 * window-based rate limit is exactly what it is for.
 */
const RETRY_AFTER_MAX_MS = 60_000

/** {@link getRetryDelay} with the Retry-After escape hatch bounded. */
function getBoundedRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
): number {
  return Math.min(getRetryDelay(attempt, retryAfterHeader), RETRY_AFTER_MAX_MS)
}

function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // The SDK sometimes loses the 529 status during streaming. Never let text
    // in a permanent 4xx body override that explicit status.
    (error.status === undefined &&
      (error.message?.includes('"type":"overloaded_error"') ?? false))
  )
}

// ---------------------------------------------------------------------------
// Credential recovery
//
// "Do not retry this request" and "do not refresh the credential" are two
// different decisions, and only the first one is wanted here. `shouldRetry`
// fails a 401/403 immediately — repeating a rejected credential ten times just
// makes the user wait — but every credential source behind this client is
// memoized for the process, so without the side effects below the NEXT request
// is built from the same dead value:
//
//   - Claude.ai OAuth: another process (a second CLI, a browser login) rotates
//     the token in the keychain. `getAnthropicClient` only ever calls the
//     non-forcing `checkAndRefreshOAuthTokenIfNeeded()`, which trusts the
//     in-memory copy's expiry and therefore never re-reads. Every request 401s
//     until the CLI is restarted.
//   - apiKeyHelper: helpers that mint short-lived keys are cached until the
//     cache is explicitly dropped.
//   - Bedrock STS / Vertex: expired session tokens and failed credential
//     refreshes stay cached the same way.
// ---------------------------------------------------------------------------

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    return false
  }
  // AWS libs reject without an API call if .aws holds a past Expiration value;
  // otherwise, API calls that receive expired tokens give a generic 403
  // "The security token included in the request is invalid".
  return (
    isAwsCredentialsProviderError(error) ||
    (error instanceof APIError && error.status === 403)
  )
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    return false
  }
  return (
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    isGoogleAuthLibraryCredentialError(error) ||
    // Server-side: Vertex returns 401 for expired/invalid tokens
    (error instanceof APIError && error.status === 401)
  )
}

/**
 * Invalidate whatever credential cache this failure implicates, so the next
 * request is built from a fresh one. Never rethrows and never influences the
 * retry decision — the request that just failed still fails.
 */
async function recoverCredentialsForNextRequest(error: unknown): Promise<void> {
  try {
    const isUnauthorized = error instanceof APIError && error.status === 401
    const isRevoked = isOAuthTokenRevokedError(error)

    if (isUnauthorized) {
      clearApiKeyHelperCache()
    }
    if (isUnauthorized || isRevoked) {
      // Re-reads the keychain (another process may already hold a good token)
      // and force-refreshes when the rejected one is still the current one.
      const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
      if (failedAccessToken) {
        await handleOAuth401Error(failedAccessToken)
      }
    }
    if (isBedrockAuthError(error)) {
      clearAwsCredentialsCache()
    }
    if (isVertexAuthError(error)) {
      clearGcpCredentialsCache()
    }
  } catch (recoveryError) {
    // A keychain read that itself fails must not replace the API error the
    // caller is about to see.
    logForDebugging(
      `Credential recovery after an auth failure did not complete: ${errorMessage(recoveryError)}`,
      { level: 'warn' },
    )
  }
}

function shouldRetry(error: APIError): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // The SDK sometimes loses the 529 status during streaming, so statusless
  // overloaded errors are recoverable. An explicit permanent 4xx still wins.
  if (
    error.status === undefined &&
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return true
  }

  // Check for max tokens context overflow errors that we can handle
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  if (
    error.status === undefined &&
    TRANSIENT_GATEWAY_MESSAGE_PATTERN.test(error.message ?? '')
  ) {
    return true
  }

  // Authentication, permission, invalid-request, model-not-found, and every
  // other permanent 4xx fail once even if a proxy sets x-should-retry:true.
  if (
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    !TRANSIENT_HTTP_STATUSES.has(error.status)
  ) {
    return false
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // Ants can ignore x-should-retry: false for 5xx server errors only.
  // For other status codes (401, 403, 400, 429, etc.), respect the header.
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts and Too Early responses.
  if (error.status === 409 || error.status === 425) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

export function clampMaxRetries(
  value: number,
  fallback = DEFAULT_MAX_RETRIES,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_API_RETRIES, Math.max(0, Math.trunc(value)))
}

export function getDefaultMaxRetries(): number {
  const raw = process.env.CLAUDE_CODE_MAX_RETRIES
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_MAX_RETRIES
  }
  return clampMaxRetries(Number.parseInt(raw, 10))
}

function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries === undefined
    ? getDefaultMaxRetries()
    : clampMaxRetries(options.maxRetries)
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}

// ---------------------------------------------------------------------------
// queryModel-level transient retry (covers what `withRetry` structurally can't)
//
// `withRetry` only wraps *stream creation* on the first-party path. Two gaps
// remain, and they are the ones agents actually die on:
//
//   1. Third-party providers (OpenAI / Gemini / Grok) branch out of `queryModel`
//      before `withRetry` is ever reached, and each has a single catch-all that
//      turns any failure into an error message — zero retries.
//   2. A stream that dies *mid-iteration* escapes the `withRetry` operation
//      entirely; it lands in the non-streaming fallback, or dies outright when
//      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK is set.
//
// `queryModel` never throws for either case — it yields an assistant message
// with `isApiErrorMessage: true`. So the wrapper below re-runs the whole
// generator, matching on that message rather than on a thrown error.
// ---------------------------------------------------------------------------

type QueryModelOutput = StreamEvent | AssistantMessage | SystemAPIErrorMessage

/**
 * Marker set by `claude.ts` on error messages produced from a `CannotRetryError`
 * — i.e. the inner `withRetry` ladder already burned its ten attempts on this
 * failure. Without it the two layers compose into 10x10 attempts and roughly
 * half an hour of backoff for a genuinely-down network.
 *
 * A Symbol, not a string key: assistant messages get JSON-serialized into the
 * session transcript JSONL, and `JSON.stringify` skips symbol-keyed properties.
 * `Symbol.for` rather than `Symbol()` so the marker survives the module being
 * instantiated twice (Vite splits this bundle into 600+ chunks).
 */
const TRANSIENT_RETRIES_EXHAUSTED = Symbol.for(
  'occ.api.transientRetriesExhausted',
)

export function markTransientRetriesExhausted<T extends object>(message: T): T {
  return Object.assign(message, { [TRANSIENT_RETRIES_EXHAUSTED]: true })
}

function hasExhaustedTransientRetries(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  if (
    (message as Record<symbol, unknown>)[TRANSIENT_RETRIES_EXHAUSTED] === true
  ) {
    return true
  }
  return hasExhaustedTransientRetries((message as { error?: unknown }).error)
}

function isApiErrorAssistantMessage(item: QueryModelOutput): boolean {
  return (
    item.type === 'assistant' &&
    (item as AssistantMessage).isApiErrorMessage === true
  )
}

function getMessageText(item: QueryModelOutput): string {
  const content = (item as AssistantMessage).message?.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'text'
      ) {
        return String((block as { text?: unknown }).text ?? '')
      }
      return ''
    })
    .join('\n')
}

function getRetrySourceError(item: QueryModelOutput): unknown | undefined {
  const error = (item as AssistantMessage).error as unknown
  return error instanceof Error ? error : undefined
}

/**
 * "Did the model already say something the caller acted on?" Once true the
 * wrapper stops retrying forever: re-running `queryModel` after a partial
 * stream re-emits the same `tool_use` block and the tool runs twice (inc-4258).
 *
 * The bar is *observable model output*, not "any bytes arrived". Protocol-only
 * events such as message_start do not commit an attempt, but text, tool JSON,
 * thinking, and signatures do: all are yielded outside the API layer, and
 * replaying after any of them risks duplicate output or tool execution.
 */
function isModelContentOutput(item: QueryModelOutput): boolean {
  if (item.type === 'assistant') {
    return (item as AssistantMessage).isApiErrorMessage !== true
  }
  if (item.type !== 'stream_event') {
    return false
  }
  const event = (item as { event?: { type?: string; delta?: unknown } }).event
  if (event?.type !== 'content_block_delta') {
    return false
  }
  const delta = (event.delta ?? {}) as Record<string, unknown>
  return Boolean(
    delta.text || delta.partial_json || delta.thinking || delta.signature,
  )
}

interface TransientNetworkRetryOptions {
  signal?: AbortSignal
  /** Defaults to CLAUDE_CODE_MAX_RETRIES, else 10 — same source as withRetry. */
  maxRetries?: number
  model?: string
  querySource?: QuerySource
}

/**
 * Re-runs `run()` when an attempt produced nothing but a transient-looking API
 * error message. Applies to every agent alike: main loop, Agent-tool subagents
 * and workflow agents all funnel through `queryModelWith{,out}Streaming`.
 *
 * Never retries once content has been emitted, once the signal is aborted, or
 * once the inner ladder has already given up (see
 * {@link markTransientRetriesExhausted}).
 */
export async function* withTransientNetworkRetry(
  run: () => AsyncGenerator<QueryModelOutput, void>,
  options: TransientNetworkRetryOptions = {},
): AsyncGenerator<QueryModelOutput, void> {
  const maxRetries =
    options.maxRetries === undefined
      ? getDefaultMaxRetries()
      : clampMaxRetries(options.maxRetries)
  if (!(maxRetries > 0)) {
    yield* run()
    return
  }

  let hasEmittedContent = false

  for (let attempt = 1; ; attempt++) {
    const canRetry = (): boolean =>
      !hasEmittedContent && attempt <= maxRetries && !options.signal?.aborted

    let retryError: unknown
    let heldErrorMessage: QueryModelOutput | undefined

    try {
      for await (const item of run()) {
        if (isApiErrorAssistantMessage(item)) {
          const text = getMessageText(item)
          const sourceError = getRetrySourceError(item)
          // The error OBJECT wins whenever there is one: it carries the
          // producer's own verdict (`retryable`, a real status, an errno),
          // whereas the text is a last resort for the producers that only ever
          // yield prose. Or-ing the two let a message containing wording like
          // "stream idle timeout" overrule an explicit `retryable: false` and
          // replay a request the adapter had already ruled permanent.
          if (
            canRetry() &&
            !hasExhaustedTransientRetries(item) &&
            (sourceError !== undefined
              ? isTransientNetworkError(sourceError)
              : isTransientNetworkErrorText(text))
          ) {
            // Current producers yield at most one error message per attempt,
            // but if a second ever arrives the first must not vanish — emit it
            // rather than letting the assignment below swallow it.
            if (heldErrorMessage) {
              yield heldErrorMessage
            }
            heldErrorMessage = item
            retryError =
              sourceError ?? new APIConnectionError({ message: text })
            continue
          }
          yield item
          continue
        }
        if (isModelContentOutput(item)) {
          hasEmittedContent = true
        }
        yield item
      }
    } catch (error) {
      // queryModel normally converts failures to messages, but user aborts and
      // FallbackTriggeredError still propagate — neither is retriable, and
      // isTransientNetworkError rejects both.
      if (!canRetry() || !isTransientNetworkError(error)) {
        throw error
      }
      retryError = error
      heldErrorMessage = undefined
    }

    if (retryError === undefined) {
      return
    }

    // Content that arrived after the held error (possible when the fallback
    // path yields late) retroactively disqualifies the retry.
    if (hasEmittedContent || options.signal?.aborted) {
      if (heldErrorMessage) {
        yield heldErrorMessage
      }
      return
    }

    const delayMs = getBoundedRetryDelay(attempt, getRetryAfter(retryError))
    logForDebugging(
      `Transient network failure (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms: ${errorMessage(retryError)}`,
      { level: 'warn' },
    )
    logEvent('tengu_api_transient_network_retry', {
      attempt,
      delayMs,
      maxRetries,
      provider: getAPIProviderForStatsig(),
      query_source:
        options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    yield createSystemAPIErrorMessage(
      toRetryDisplayError(retryError),
      delayMs,
      attempt,
      maxRetries,
    )
    // Throws APIUserAbortError on abort so the whole turn unwinds immediately.
    await sleep(delayMs, options.signal, { abortError })
  }
}
