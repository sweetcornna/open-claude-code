import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  DEFAULT_BREAK_THRESHOLD_MS,
  getContinuousUseMs,
  getFiredCount,
  noteReminderFired,
  setBreakThresholdMs,
} from './activityTracker.js'

export const DEFAULT_INTERVAL_MINUTES = 30
export const DEFAULT_BREAK_THRESHOLD_MINUTES =
  DEFAULT_BREAK_THRESHOLD_MS / 60_000

export type BreakReminderSettings = {
  enabled?: boolean
  intervalMinutes?: number
  breakThresholdMinutes?: number
  message?: string
}

export type QuietHoursSettings = {
  enabled?: boolean
  start?: string
  end?: string
}

/** Rotating nudges, so a long session doesn't repeat the same sentence. */
const BREAK_MESSAGES = [
  "You've been at this a while — a short break is a good idea.",
  'Still going strong. Worth standing up and stretching for a minute?',
  'Another stretch done. Water, window, walk — pick one.',
  "Long session. Whatever you're chasing will still be here in five minutes.",
] as const

const QUIET_HOURS_MESSAGE =
  "It's your downtime right now. Nothing here can't wait until morning."

export function getBreakReminderSettings(): BreakReminderSettings {
  return getInitialSettings().breakReminder ?? {}
}

export function getQuietHoursSettings(): QuietHoursSettings {
  return getInitialSettings().quietHours ?? {}
}

/** Minutes since local midnight, or null when the string isn't "HH:MM". */
export function parseClockMinutes(value: string | undefined): number | null {
  if (!value) return null
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Whether `date` falls inside the window. `end` earlier than `start` means the
 * window wraps midnight (22:00 → 07:00), which is the common configuration.
 */
export function isWithinQuietHours(
  quietHours: QuietHoursSettings,
  date: Date,
): boolean {
  if (!quietHours.enabled) return false
  const start = parseClockMinutes(quietHours.start)
  const end = parseClockMinutes(quietHours.end)
  if (start === null || end === null || start === end) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return start < end ? now >= start && now < end : now >= start || now < end
}

/** One quiet-hours nudge per process, matching the upstream "per session" rule. */
let quietHoursNudged = false

export function resetWellbeingSessionState(): void {
  quietHoursNudged = false
}

/**
 * Nudges to show for this turn, in display order. Returns an empty array in the
 * common case — both features are opt-in and default to off.
 *
 * Evaluated at user-turn boundaries rather than on a timer: nothing outside
 * React can push into the transcript, and a nudge is only useful when the user
 * is looking at the prompt anyway. The cost is that a reminder can lag its
 * interval by one turn.
 */
export function collectWellbeingNudges(now: Date = new Date()): string[] {
  const nudges: string[] = []
  const nowMs = now.getTime()

  const breakReminder = getBreakReminderSettings()
  // Refresh the tracker's threshold here rather than on the activity path, so
  // the hot path never reads settings.
  setBreakThresholdMs(
    (breakReminder.breakThresholdMinutes ?? DEFAULT_BREAK_THRESHOLD_MINUTES) *
      60_000,
  )

  if (breakReminder.enabled) {
    const continuousUseMs = getContinuousUseMs(nowMs)
    if (continuousUseMs !== null) {
      const intervalMs =
        (breakReminder.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000
      const fired = getFiredCount()
      if (intervalMs > 0 && continuousUseMs >= intervalMs * (fired + 1)) {
        noteReminderFired()
        nudges.push(
          breakReminder.message?.trim() ||
            BREAK_MESSAGES[fired % BREAK_MESSAGES.length]!,
        )
      }
    }
  }

  if (!quietHoursNudged && isWithinQuietHours(getQuietHoursSettings(), now)) {
    quietHoursNudged = true
    nudges.push(QUIET_HOURS_MESSAGE)
  }

  return nudges
}
