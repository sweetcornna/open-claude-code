/**
 * Continuous-use tracking for the opt-in break reminder.
 *
 * Deliberately dependency-free: the only writer is
 * `bootstrap/state/sessionRuntime.ts`, which sits far below settings and
 * message plumbing in the import graph. Everything that needs configuration
 * lives in `reminder.ts` instead.
 *
 * A "stretch" is a run of user activity with no gap longer than the break
 * threshold. Any longer gap counts as a break: the stretch restarts and the
 * reminder budget resets, which is what makes the reminder stop nagging once
 * the user actually steps away.
 */

const DEFAULT_BREAK_THRESHOLD_MINUTES = 10

type Stretch = {
  startMs: number
  lastActivityMs: number
  /** Reminders already shown for this stretch — the re-fire counter. */
  firedCount: number
}

let stretch: Stretch | null = null
let breakThresholdMs = DEFAULT_BREAK_THRESHOLD_MINUTES * 60_000

/**
 * Record a moment of user activity (a keystroke batch, a submit).
 *
 * Hot path — called once per Ink interaction flush, so it stays arithmetic
 * only. The threshold it compares against is whatever `reminder.ts` last
 * cached; a stale value only shifts a stretch boundary by one evaluation.
 */
export function noteUserActivity(nowMs: number): void {
  if (stretch === null || nowMs - stretch.lastActivityMs >= breakThresholdMs) {
    stretch = { startMs: nowMs, lastActivityMs: nowMs, firedCount: 0 }
    return
  }
  stretch.lastActivityMs = nowMs
}

/** Milliseconds of unbroken use, or null when the user is currently on a break. */
export function getContinuousUseMs(nowMs: number): number | null {
  if (stretch === null) return null
  if (nowMs - stretch.lastActivityMs >= breakThresholdMs) return null
  return Math.max(0, nowMs - stretch.startMs)
}

/** How many reminders this stretch has already produced. */
export function getFiredCount(): number {
  return stretch?.firedCount ?? 0
}

export function noteReminderFired(): void {
  if (stretch !== null) stretch.firedCount += 1
}

export function setBreakThresholdMs(ms: number): void {
  breakThresholdMs = ms
}

export function resetActivityTracker(): void {
  stretch = null
  breakThresholdMs = DEFAULT_BREAK_THRESHOLD_MINUTES * 60_000
}

export const DEFAULT_BREAK_THRESHOLD_MS =
  DEFAULT_BREAK_THRESHOLD_MINUTES * 60_000
