import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
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
import { classifyRetryableAPIError } from './retryClassification.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const abortError = () => new APIUserAbortError()

/** Ten retries by default; the official CLI allows explicit values up to 15. */
const DEFAULT_MAX_RETRIES = 10
const WATCHDOG_DEFAULT_MAX_RETRIES = 300
const MAX_API_RETRIES = 15
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// CLAUDE_CODE_RETRY_WATCHDOG matches the official unattended capacity mode:
// 300 retries for 429/529, higher backoff, and periodic keep-alive yields.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_RETRY_WATCHDOG)
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

const FOREGROUND_529_RETRY_SOURCES = new Set([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Proactive',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'workflow',
  'hook_agent',
  'hook_prompt',
  'side_question',
  'web_search_tool',
  'web_fetch_apply',
  'repl_sampling',
  'auto_mode',
  'compact_fab_check',
  'auto_mode_critique',
  'auto_mode_setup_propose',
  'chrome_mcp',
])

function shouldRetryForeground529(
  querySource: QuerySource | undefined,
): boolean {
  return (
    querySource === undefined ||
    querySource.startsWith('agent:') ||
    FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

const STALE_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'CONNECTIONCLOSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ERR_SOCKET_CLOSED',
  'STREAMSUSPENDED',
  'UND_ERR_SOCKET',
])

function isStaleConnectionError(error: unknown): boolean {
  if (
    !(error instanceof APIConnectionError) &&
    !isTransientNetworkError(error)
  ) {
    return false
  }
  const code = extractConnectionErrorDetails(error)?.code.toUpperCase()
  return code !== undefined && STALE_CONNECTION_CODES.has(code)
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

/** The classifier's verdict shape, without importing its (unused) type name. */
type RetryVerdict = ReturnType<typeof classifyRetryableAPIError>

const NEVER_RETRY: RetryVerdict = {
  category: 'unknown',
  retryable: false,
  persistence: 'permanent',
}

function transiently(verdict: RetryVerdict): RetryVerdict {
  return { ...verdict, retryable: true, persistence: 'transient' }
}

/**
 * The single verdict every retry decision in this file is taken from.
 *
 * `classifyRetryableAPIError` answers for the error itself; this adds the two
 * things it cannot see — control-flow errors occ throws through the same catch,
 * and the `APIError`-only gates in {@link apiErrorVerdict}. Routing both loops
 * through one function is what keeps the classifier and the ladder from
 * disagreeing: before this, `shouldRetry` re-derived its own boolean and could
 * silently veto a class the classifier had just called retryable.
 */
function retryVerdict(error: unknown): RetryVerdict {
  // Not a failure: the caller asked for a different model, so this loop is
  // done and the fallback loop takes over.
  if (error instanceof FallbackTriggeredError) return NEVER_RETRY
  if (error instanceof CannotRetryError) {
    return retryVerdict(error.originalError)
  }
  if (error instanceof APIError) return apiErrorVerdict(error)
  return classifyRetryableAPIError(error)
}

/**
 * True when `error` deserves another attempt at all.
 *
 * Mirrors the official retry predicate after bridging provider error shapes.
 *
 * Exported for tests.
 */
export function isTransientNetworkError(error: unknown): boolean {
  return retryVerdict(error).retryable
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
  return classifyRetryableAPIError(text).retryable
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
  onError?: (error: unknown) => string | undefined | Promise<string | undefined>
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
    public readonly reason:
      | 'model_not_found'
      | 'permission_denied'
      | 'server_error'
      | 'overloaded' = 'overloaded',
    public readonly originalError?: unknown,
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
  let oauthRecoveryAttempts = 0
  let awsRecoveryAttempts = 0
  let gcpRecoveryAttempts = 0
  const appliedErrorTransforms = new Set<string>()
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
      // socket. Retryable credential failures drop their caches in the catch
      // block so a rotated credential can recover within this request.
      const isStaleConnection = isStaleConnectionError(lastError)
      const mustRebuildClient =
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
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

      if (client === null || mustRebuildClient) {
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      const transform = await options.onError?.(error)
      if (transform && !appliedErrorTransforms.has(transform)) {
        appliedErrorTransforms.add(transform)
        attempt--
        continue
      }

      const fallbackReason = modelFallbackReason(error)
      if (
        fallbackReason &&
        options.fallbackModel &&
        options.fallbackModel !== options.model &&
        !isPersistentRetryEnabled()
      ) {
        throw new FallbackTriggeredError(
          options.model,
          options.fallbackModel,
          fallbackReason,
          error,
        )
      }

      const oauthFailure =
        (error instanceof APIError && error.status === 401) ||
        isOAuthTokenRevokedError(error)
      const awsFailure = isBedrockAuthError(error)
      const gcpFailure = isVertexAuthError(error)
      if (oauthFailure && oauthRecoveryAttempts >= 2) {
        throw new CannotRetryError(error, retryContext)
      }
      if (awsFailure && awsRecoveryAttempts >= 2) {
        throw new CannotRetryError(error, retryContext)
      }
      if (gcpFailure && gcpRecoveryAttempts >= 2) {
        throw new CannotRetryError(error, retryContext)
      }
      if (oauthFailure) oauthRecoveryAttempts++
      if (awsFailure) awsRecoveryAttempts++
      if (gcpFailure) gcpRecoveryAttempts++
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

      if (
        is529Error(error) &&
        !isPersistentRetryEnabled() &&
        !shouldRetryForeground529(options.querySource)
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          options.fallbackModel !== undefined ||
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
              'overloaded',
              error,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)

      // One verdict for every shape that reaches this catch — SDK errors, bare
      // transport failures and provider-synthesised errors alike.
      const verdict = retryVerdict(error)
      if (!verdict.retryable) {
        throw new CannotRetryError(error, retryContext)
      }
      const attemptBudget = maxRetries
      if (!persistent && attempt > attemptBudget) {
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
          // Ensure we have enough tokens for thinking + at least 1 output token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
          } else if (minRequired > availableContext) {
            logError(
              new Error(
                `thinking minimum ${minRequired} exceeds available context ${availableContext}`,
              ),
            )
          } else {
            // availableContext is already above the output floor and is the
            // largest value the retry can request without repeating the same
            // context overflow.
            const adjustedMaxTokens = availableContext
            if (
              retryContext.maxTokensOverride !== undefined &&
              adjustedMaxTokens >= retryContext.maxTokensOverride
            ) {
              logError(
                new Error('max_tokens overflow adjustment made no progress'),
              )
              throw new CannotRetryError(error, retryContext)
            }
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
        delayMs = getRetryDelay(attempt, retryAfter)
        if (delayMs > RETRY_AFTER_MAX_MS) {
          throw new CannotRetryError(error, retryContext)
        }
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
            attemptBudget,
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
          attemptBudget,
        )
        await sleep(delayMs, options.signal, { abortError })
      }
      if (persistent && attempt >= maxRetries) {
        attempt = maxRetries - 1
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
  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs)
  const backoff = Math.round(baseDelay + Math.random() * 0.25 * baseDelay)
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(seconds)) {
      return Math.max(seconds * 1000, backoff)
    }
  }
  return backoff
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
 * The official retry-watchdog branch keeps its own larger cap because waiting
 * out a window-based capacity limit is exactly what it is for.
 */
const RETRY_AFTER_MAX_MS = 60_000

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

function modelFallbackReason(
  error: unknown,
): 'model_not_found' | 'permission_denied' | 'server_error' | undefined {
  if (!(error instanceof APIError)) return undefined
  const message = error.message ?? ''
  const isModelError = message.includes('model:') || /\bmodel\b/i.test(message)
  if (
    error.status === 404 &&
    isModelError &&
    (error.type === 'not_found_error' ||
      message.includes('"type":"not_found_error"'))
  ) {
    return 'model_not_found'
  }
  if (
    error.status === 403 &&
    isModelError &&
    (error.type === 'permission_error' ||
      message.includes('"type":"permission_error"'))
  ) {
    return 'permission_denied'
  }
  if (
    error.status !== undefined &&
    error.status >= 500 &&
    error.status < 600 &&
    error.status !== 529
  ) {
    return 'server_error'
  }
  return undefined
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
// "Retry this request" and "refresh the credential" are two different
// decisions. The official policy retries 401 to refresh credentials, while
// every credential source behind this client is memoized for the process. Without the
// side effects below, every attempt and the next request would be built from the
// same dead value:
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

/**
 * The classifier's verdict for an `APIError`, plus the decisions that depend on
 * things the error text cannot express.
 */
function apiErrorVerdict(error: APIError): RetryVerdict {
  const classified = classifyRetryableAPIError(error)

  // /mock-limits fabricates this to reproduce the rate-limit UI on demand.
  // It is not a request that failed, so there is nothing to attempt again.
  if (isMockRateLimitError(error)) {
    return { ...classified, retryable: false, persistence: 'permanent' }
  }

  // Persistent capacity mode intentionally overrides the server's long-lived
  // x-should-retry:false response and waits for the advertised reset window.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return transiently(classified)
  }

  return classified
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
  if (options.maxRetries !== undefined)
    return clampMaxRetries(options.maxRetries)
  return isPersistentRetryEnabled()
    ? WATCHDOG_DEFAULT_MAX_RETRIES
    : getDefaultMaxRetries()
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
