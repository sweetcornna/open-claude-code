/**
 * Per-session goal state machine. Pure in-memory management — no FS,
 * no network. Persistence is handled by goalStorage.ts.
 *
 * Uses Map<string, GoalState> keyed by sessionId so concurrent
 * sub-sessions (agents, worktrees) don't leak into each other.
 */
import type {
  GoalPauseReason,
  GoalState,
  GoalStatus,
} from '../../types/logs.js'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import { setGoalPresent } from './goalPresence.js'

export const BLOCKED_CONSECUTIVE_THRESHOLD = 3
export const MAX_GOAL_TURNS = 150

/**
 * Consecutive transient API failures tolerated before the continuation loop
 * gives up and pauses. Mirrors BLOCKED_CONSECUTIVE_THRESHOLD: one bad turn is
 * noise, three in a row is a real outage.
 *
 * Before this existed, a single `fetch failed` paused the goal outright and
 * nothing ever resumed it — a goal set at 09:05 sat paused for the next five
 * hours of the session while the user kept working by hand.
 */
export const TRANSIENT_ERROR_PAUSE_THRESHOLD = 3

/**
 * Backoff before re-enqueuing a continuation turn, indexed by how many
 * consecutive failures precede it. The API layer already runs its own retry
 * ladder inside a turn; this spaces out whole turns so a dead network doesn't
 * burn the turn budget in a tight loop.
 */
const RETRY_BACKOFF_MS = [10_000, 30_000] as const

const goals = new Map<string, GoalState>()

function syncPresence(): void {
  setGoalPresent(goals.size > 0)
}

function goalLog(
  tag: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : ''
  logForDebugging(`[goal] ${tag}: ${msg}${suffix}`)
}

function resolveSessionId(sessionId?: string): string {
  return sessionId ?? getSessionId()
}

export function setGoal(
  objective: string,
  options?: { tokenBudget?: number; sessionId?: string },
): GoalState {
  const id = resolveSessionId(options?.sessionId)
  const budget =
    options?.tokenBudget !== undefined &&
    Number.isFinite(options.tokenBudget) &&
    options.tokenBudget > 0
      ? options.tokenBudget
      : null
  const now = Date.now()
  const state: GoalState = {
    objective,
    status: 'active',
    tokenBudget: budget,
    tokensUsed: 0,
    startTime: now,
    pausedAt: null,
    accumulatedActiveMs: 0,
    blockedAttempts: 0,
    lastBlockReason: null,
    createdAt: now,
    updatedAt: now,
    turnsExecuted: 0,
    consecutiveErrors: 0,
    pauseReason: null,
  }
  goals.set(id, state)
  syncPresence()
  goalLog('SET', `objective="${objective.slice(0, 80)}"`, {
    tokenBudget: state.tokenBudget,
  })
  return state
}

export function getGoal(sessionId?: string): GoalState | null {
  return goals.get(resolveSessionId(sessionId)) ?? null
}

export function clearGoal(sessionId?: string): boolean {
  const had = goals.has(resolveSessionId(sessionId))
  const result = goals.delete(resolveSessionId(sessionId))
  syncPresence()
  if (had) goalLog('CLEAR', 'goal removed')
  return result
}

/**
 * Halt auto-continuation. `reason` records who stopped it: a `'user'` pause
 * (`/goal pause`, Ctrl+C) is permanent until the user says otherwise, while a
 * `'transient-error'` pause is undone automatically by the next successful
 * turn — see {@link recordGoalTurnSuccess}.
 */
export function pauseGoal(
  sessionId?: string,
  reason: Exclude<GoalPauseReason, null> = 'user',
): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const now = Date.now()
  goal.accumulatedActiveMs += now - goal.startTime
  goal.pausedAt = now
  goal.status = 'paused'
  goal.pauseReason = reason
  goal.updatedAt = now
  goalLog(
    'PAUSE',
    `paused after ${Math.round(goal.accumulatedActiveMs / 1000)}s active`,
    { reason },
  )
  return goal
}

export function resumeGoal(sessionId?: string): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return null
  if (goal.status !== 'paused') {
    return null
  }
  const now = Date.now()
  goal.startTime = now
  goal.pausedAt = null
  goal.status = 'active'
  goal.pauseReason = null
  goal.updatedAt = now
  goalLog('RESUME', 'goal resumed, blockedAttempts reset')
  goal.blockedAttempts = 0
  goal.lastBlockReason = null
  goal.consecutiveErrors = 0
  return goal
}

/**
 * Record that a continuation turn died on a transient API failure (network
 * reset, `fetch failed`, 5xx). Keeps the goal `active` for the first
 * {@link TRANSIENT_ERROR_PAUSE_THRESHOLD} - 1 failures so the loop can retry
 * with backoff, then pauses with `pauseReason: 'transient-error'`.
 *
 * Returns the outcome, or `null` when there is no active goal to charge the
 * failure to.
 */
export function recordTransientFailure(
  sessionId?: string,
): { consecutiveErrors: number; paused: boolean } | null {
  const goal = goals.get(resolveSessionId(sessionId))
  if (!goal || goal.status !== 'active') return null
  goal.consecutiveErrors += 1
  goal.updatedAt = Date.now()
  if (goal.consecutiveErrors >= TRANSIENT_ERROR_PAUSE_THRESHOLD) {
    pauseGoal(sessionId, 'transient-error')
    goalLog(
      'TRANSIENT_PAUSE',
      `paused after ${goal.consecutiveErrors} consecutive API failures`,
    )
    return { consecutiveErrors: goal.consecutiveErrors, paused: true }
  }
  goalLog(
    'TRANSIENT_FAILURE',
    `attempt ${goal.consecutiveErrors}/${TRANSIENT_ERROR_PAUSE_THRESHOLD}, will retry with backoff`,
  )
  return { consecutiveErrors: goal.consecutiveErrors, paused: false }
}

/**
 * Record that a turn reached the model successfully. Clears the transient
 * failure streak and — the point of the pauseReason bookkeeping — lifts an
 * automatic pause so a recovered network resumes the goal on its own. A pause
 * the *user* asked for is never undone here.
 *
 * Returns `'resumed'` when this call revived a paused goal, so the caller can
 * tell the user what happened.
 */
export function recordGoalTurnSuccess(
  sessionId?: string,
): 'resumed' | 'cleared' | null {
  const goal = goals.get(resolveSessionId(sessionId))
  if (!goal) return null

  if (goal.status === 'paused' && goal.pauseReason === 'transient-error') {
    goal.consecutiveErrors = 0
    resumeGoal(sessionId)
    goalLog('AUTO_RESUME', 'connectivity recovered, goal resumed')
    return 'resumed'
  }

  if (goal.status === 'usage_limited') {
    resumeFromUsageLimit(sessionId)
    return 'resumed'
  }

  if (goal.consecutiveErrors === 0) return null
  goal.consecutiveErrors = 0
  goal.updatedAt = Date.now()
  goalLog('TRANSIENT_RECOVERED', 'failure streak cleared')
  return 'cleared'
}

/**
 * How long the continuation loop should wait before the next turn. Zero on a
 * healthy goal; a widening backoff while a failure streak is in progress.
 */
export function getContinuationDelayMs(goal: GoalState): number {
  if (goal.consecutiveErrors <= 0) return 0
  const idx = Math.min(goal.consecutiveErrors - 1, RETRY_BACKOFF_MS.length - 1)
  return RETRY_BACKOFF_MS[idx] ?? 0
}

/**
 * Transition an active goal into max_turns once continuation cap is hit.
 * Idempotent: repeated calls while already max_turns are no-ops.
 */
export function markGoalMaxTurnsReached(sessionId?: string): GoalState | null {
  const goal = getGoal(sessionId)
  if (!goal || goal.status !== 'active') return null
  if (goal.turnsExecuted < MAX_GOAL_TURNS) return null
  goal.status = 'max_turns'
  goal.updatedAt = Date.now()
  goalLog('MAX_TURNS', `reached ${MAX_GOAL_TURNS} turns`)
  return goal
}

/**
 * Reset continuation turn counter after a max_turns stop and resume work.
 * This is a deliberate user action (`/goal continue`) to prevent silent
 * runaway loops.
 */
export function continueGoalFromMaxTurns(sessionId?: string): GoalState | null {
  const goal = getGoal(sessionId)
  if (!goal || goal.status !== 'max_turns') return null
  const now = Date.now()
  goal.turnsExecuted = 0
  goal.status = 'active'
  goal.startTime = now
  goal.pausedAt = null
  goal.pauseReason = null
  goal.blockedAttempts = 0
  goal.lastBlockReason = null
  goal.consecutiveErrors = 0
  goal.updatedAt = now
  goalLog(
    'CONTINUE',
    `turn counter reset, status active (max=${MAX_GOAL_TURNS})`,
  )
  return goal
}

export function completeGoal(sessionId?: string): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return null
  const now = Date.now()
  if (goal.status === 'active' && goal.pausedAt === null) {
    goal.accumulatedActiveMs += now - goal.startTime
  }
  goal.status = 'complete'
  goal.updatedAt = now
  goalLog('COMPLETE', `goal achieved`, {
    tokensUsed: goal.tokensUsed,
    turns: goal.turnsExecuted,
  })
  return goal
}

export function updateGoalTokens(
  delta: number,
  sessionId?: string,
): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return null
  if (goal.status !== 'active') return null
  if (!Number.isFinite(delta) || delta <= 0) return goal
  const sanitized = delta
  goal.tokensUsed += sanitized
  goal.updatedAt = Date.now()
  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    goal.status = 'budget_limited'
    goalLog(
      'BUDGET_LIMITED',
      `tokens ${goal.tokensUsed} >= budget ${goal.tokenBudget}`,
    )
  } else if (sanitized > 0) {
    goalLog(
      'TOKENS',
      `+${sanitized} → total ${goal.tokensUsed}${goal.tokenBudget ? `/${goal.tokenBudget}` : ''}`,
    )
  }
  return goal
}

/**
 * Provider said no on quota (429 / usage limit). Distinct from a transient
 * failure: retrying sooner cannot help, so this stops the loop immediately
 * rather than spending two more turns proving the point.
 */
export function markUsageLimited(sessionId?: string): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const now = Date.now()
  if (goal.pausedAt === null) {
    goal.accumulatedActiveMs += now - goal.startTime
    goal.pausedAt = now
  }
  goal.status = 'usage_limited'
  goal.updatedAt = now
  goalLog('USAGE_LIMITED', 'provider rate/usage limit hit, loop stopped')
  return goal
}

/**
 * Lift a `usage_limited` stop once the provider starts answering again.
 * Separate from {@link resumeGoal}, which only accepts `paused`.
 */
export function resumeFromUsageLimit(sessionId?: string): GoalState | null {
  const goal = goals.get(resolveSessionId(sessionId))
  if (!goal || goal.status !== 'usage_limited') return null
  const now = Date.now()
  goal.status = 'active'
  goal.startTime = now
  goal.pausedAt = null
  goal.pauseReason = null
  goal.consecutiveErrors = 0
  goal.updatedAt = now
  goalLog('USAGE_RECOVERED', 'usage limit cleared, goal resumed')
  return goal
}

export function incrementGoalTurns(sessionId?: string): number {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return 0
  goal.turnsExecuted += 1
  goal.updatedAt = Date.now()
  goalLog('TURN', `#${goal.turnsExecuted}/${MAX_GOAL_TURNS}`, {
    status: goal.status,
    tokensUsed: goal.tokensUsed,
  })
  return goal.turnsExecuted
}

export function recordBlockedAttempt(
  reason: string,
  sessionId?: string,
): { status: GoalStatus; attempts: number } | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const normalised = reason.trim().toLowerCase()
  if (
    goal.lastBlockReason !== null &&
    goal.lastBlockReason.trim().toLowerCase() !== normalised
  ) {
    goal.blockedAttempts = 0
  }
  goal.lastBlockReason = reason
  goal.blockedAttempts += 1
  goal.updatedAt = Date.now()
  if (goal.blockedAttempts >= BLOCKED_CONSECUTIVE_THRESHOLD) {
    goal.status = 'blocked'
    goalLog('BLOCKED', `3-strike reached! reason="${normalised}"`)
  } else {
    goalLog(
      'BLOCK_ATTEMPT',
      `attempt ${goal.blockedAttempts}/${BLOCKED_CONSECUTIVE_THRESHOLD} reason="${normalised}"`,
    )
  }
  return { status: goal.status, attempts: goal.blockedAttempts }
}

/**
 * Wall-clock time the goal has been actively worked on (excludes
 * paused intervals). Used by status displays and completion reports.
 */
export function getActiveElapsedMs(goal: GoalState): number {
  const ongoing =
    goal.status === 'active' && goal.pausedAt === null
      ? Date.now() - goal.startTime
      : 0
  return goal.accumulatedActiveMs + ongoing
}

/** Test-only: wipe the in-memory map without touching disk. */
export function _clearAllGoalsForTesting(): void {
  goals.clear()
  syncPresence()
}

/**
 * Test/internal: hydrate the in-memory map from persisted state.
 * Called by goalStorage on session resume.
 *
 * Transcripts written before `consecutiveErrors` / `pauseReason` existed have
 * neither field, and the declared type claims both. Normalise on the way in so
 * every reader downstream can treat them as present.
 */
export function _setGoalFromPersistedState(
  state: GoalState,
  sessionId?: string,
): void {
  goals.set(resolveSessionId(sessionId), {
    ...state,
    consecutiveErrors: state.consecutiveErrors ?? 0,
    pauseReason: state.pauseReason ?? null,
  })
  syncPresence()
}

/** Format the elapsed time as "Xm Ys" / "Ys" for UI display. */
export function formatGoalElapsed(goal: GoalState): string {
  const elapsedMs = getActiveElapsedMs(goal)
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds % 60}s`
}

/** Human-readable status label for UI. */
export function formatGoalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'paused':
      return 'Paused'
    case 'blocked':
      return 'Blocked'
    case 'budget_limited':
      return 'Budget Limited'
    case 'usage_limited':
      return 'Usage Limited'
    case 'max_turns':
      return 'Max Turns Reached'
    case 'complete':
      return 'Complete'
  }
}
