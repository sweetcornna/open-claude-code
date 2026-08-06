/**
 * Maps the outcome of a single turn onto the goal state machine.
 *
 * The rule this file exists to enforce: **a transient failure must not end a
 * goal.** The original behaviour paused the goal the first time an assistant
 * message came back as `API Error: fetch failed`, and nothing ever un-paused
 * it — a goal set at 09:05 in a real session sat paused for the following five
 * hours while the user kept driving by hand. A network blip is exactly the
 * situation "keep working until the objective is met" is supposed to survive.
 *
 * So failures are triaged instead:
 *
 * | classification | action                                                    |
 * | -------------- | --------------------------------------------------------- |
 * | transient      | count it; retry with backoff; pause only on the 3rd in a row |
 * | usage-limit    | stop now — more turns cannot buy quota                     |
 * | fatal          | stop now — auth/billing needs the user                     |
 * | benign         | leave the goal alone; the model can recover next turn      |
 *
 * and every successful turn clears the streak, lifting an automatic pause.
 */
import {
  getContinuationDelayMs,
  getGoal,
  markUsageLimited,
  pauseGoal,
  recordGoalTurnSuccess,
  recordTransientFailure,
  TRANSIENT_ERROR_PAUSE_THRESHOLD,
} from './goalState.js'
import { persistCurrentGoal } from './goalStorage.js'

/**
 * What the caller should tell the user. `null` means "nothing changed worth
 * mentioning" — the overwhelmingly common case, since most turns succeed and
 * most successes are no-ops.
 */
export type GoalOutcomeNotice =
  | { kind: 'retrying'; attempt: number; delayMs: number }
  | { kind: 'paused-transient' }
  | { kind: 'paused-fatal'; detail: string }
  | { kind: 'usage-limited' }
  | { kind: 'auto-resumed' }
  | null

type FailureClass = 'transient' | 'usage-limit' | 'fatal' | 'benign'

/**
 * Substrings that mark a network-layer failure. Third-party providers
 * (OpenAI/Gemini/Grok adapters) build their error messages by hand and do not
 * populate the structured `error` field, so text matching stays load-bearing
 * rather than being a fallback for Anthropic-only edge cases.
 */
const TRANSIENT_PATTERNS = [
  'connection error',
  'fetch failed',
  'network error',
  'terminated',
  'socket hang up',
  'enotfound',
  'econnreset',
  'econnrefused',
  'etimedout',
  'eai_again',
  'timeout',
  'stream idle',
  '502',
  '503',
  '504',
  'overloaded',
  'internal server error',
]

const USAGE_LIMIT_PATTERNS = [
  'usage limit',
  'rate limit',
  'quota',
  'insufficient_quota',
  '429',
]

const FATAL_PATTERNS = [
  'authentication',
  'invalid api key',
  'unauthorized',
  'credit balance',
  'billing',
]

/**
 * Classify an API-error assistant message. `errorKind` is the message's
 * structured `error` field when the first-party path set one — typed `unknown`
 * because AssistantMessage carries an index signature, so callers can hand it
 * straight over without a cast. `text` is the user-visible body, which is all
 * a third-party adapter gives us.
 */
export function classifyGoalFailure(
  text: string,
  errorKind?: unknown,
): FailureClass {
  if (errorKind === 'rate_limit') return 'usage-limit'
  if (errorKind === 'authentication_failed' || errorKind === 'billing_error') {
    return 'fatal'
  }
  if (errorKind === 'server_error') return 'transient'

  const lower = text.toLowerCase()
  // Usage limits are checked before transient: a 429 body frequently also
  // mentions retrying, and treating it as transient would burn the streak
  // budget on a wait the backoff is far too short to cover.
  if (USAGE_LIMIT_PATTERNS.some(p => lower.includes(p))) return 'usage-limit'
  if (FATAL_PATTERNS.some(p => lower.includes(p))) return 'fatal'
  if (TRANSIENT_PATTERNS.some(p => lower.includes(p))) return 'transient'

  // `invalid_request`, `max_output_tokens` and anything unrecognised: the turn
  // failed but the connection is fine, so the next continuation has a real
  // chance. Don't spend the goal's error budget on it.
  return 'benign'
}

/**
 * Fold a failed turn into the active goal. No-op when no goal is active.
 */
export function recordGoalApiFailure(
  text: string,
  errorKind?: unknown,
): GoalOutcomeNotice {
  const goal = getGoal()
  if (!goal || goal.status !== 'active') return null

  const classification = classifyGoalFailure(text, errorKind)

  if (classification === 'benign') return null

  if (classification === 'usage-limit') {
    markUsageLimited()
    persistCurrentGoal()
    return { kind: 'usage-limited' }
  }

  if (classification === 'fatal') {
    pauseGoal(undefined, 'fatal-error')
    persistCurrentGoal()
    return { kind: 'paused-fatal', detail: text.slice(0, 120) }
  }

  const result = recordTransientFailure()
  persistCurrentGoal()
  if (!result) return null
  if (result.paused) return { kind: 'paused-transient' }

  const live = getGoal()
  return {
    kind: 'retrying',
    attempt: result.consecutiveErrors,
    delayMs: live ? getContinuationDelayMs(live) : 0,
  }
}

/**
 * Fold a successful turn into the active goal: clears the failure streak and
 * revives a goal that an outage had auto-paused.
 */
export function recordGoalApiSuccess(): GoalOutcomeNotice {
  const outcome = recordGoalTurnSuccess()
  if (outcome === null) return null
  persistCurrentGoal()
  return outcome === 'resumed' ? { kind: 'auto-resumed' } : null
}

/** Human-readable text for a notice, or `null` when nothing should be shown. */
export function formatGoalOutcomeNotice(
  notice: GoalOutcomeNotice,
): string | null {
  switch (notice?.kind) {
    case 'retrying':
      return `Goal hit a connection error (${notice.attempt}/${TRANSIENT_ERROR_PAUSE_THRESHOLD}). Retrying in ${Math.round(notice.delayMs / 1000)}s — run /goal pause to stop.`
    case 'paused-transient':
      return `Goal auto-paused after ${TRANSIENT_ERROR_PAUSE_THRESHOLD} consecutive connection errors. It resumes on its own once a turn succeeds, or run /goal resume.`
    case 'paused-fatal':
      return `Goal paused — the request cannot be retried: ${notice.detail}`
    case 'usage-limited':
      return 'Goal stopped: provider usage limit reached. It resumes on its own once a turn succeeds, or run /goal resume.'
    case 'auto-resumed':
      return 'Connection recovered — goal resumed automatically.'
    default:
      return null
  }
}
