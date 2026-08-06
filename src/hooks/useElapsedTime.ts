import { useCallback, useSyncExternalStore } from 'react'
import { formatDuration } from '../utils/text/format.js'

/**
 * How long a task has been running.
 *
 * Measured against a monotonic clock whenever the caller has one. `Date.now()`
 * is a wall clock and can step *backwards* — Windows in particular does this
 * routinely (w32time correcting after sleep/resume, WSL2 drift being pulled
 * back by the host, a dual-boot RTC being re-interpreted). One backward step
 * larger than the task's age makes `Date.now() - startTime` negative for the
 * rest of that task's life, and the old `Math.max(0, …)` turned that into a
 * permanent `0s` next to a token counter that kept climbing. A duration is a
 * span, not two dates, so measure it with the clock built for spans.
 *
 * `pausedMs` is accumulated by a different code path than the one that stamps
 * the start, so the two can also disagree. When the paused counter exceeds the
 * whole span, prefer a slightly-too-large duration over a provably wrong one.
 */
export function computeElapsedMs(
  startTime: number,
  pausedMs: number,
  endTime?: number,
  startTimeMono?: number,
): number {
  const total =
    endTime !== undefined
      ? endTime - startTime
      : startTimeMono !== undefined
        ? performance.now() - startTimeMono
        : Date.now() - startTime
  if (!(total > 0)) {
    // Not started yet, a frozen endTime that predates startTime, or NaN.
    return 0
  }
  const net = total - pausedMs
  if (net > 0) {
    return net
  }
  // Deliberately silent: this runs at 1Hz per visible task, and reaching the
  // debug logger from here closes an import cycle. The unadjusted span is the
  // honest answer; a paused counter that outgrew the span is a bug in whoever
  // accumulates it, not something this hook can report usefully.
  return total
}

/**
 * Hook that returns formatted elapsed time since startTime.
 * Uses useSyncExternalStore with interval-based updates for efficiency.
 *
 * @param startTime - Unix timestamp in ms
 * @param isRunning - Whether to actively update the timer
 * @param ms - How often should we trigger updates?
 * @param pausedMs - Total paused duration to subtract
 * @param endTime - If set, freezes the duration at this timestamp (for
 *   terminal tasks). Without this, viewing a 2-min task 30 min after
 *   completion would show "32m".
 * @param startTimeMono - `performance.now()` captured alongside `startTime`.
 *   Pass it whenever the caller has one: it makes the reading immune to the
 *   wall clock stepping backwards. See computeElapsedMs.
 * @returns Formatted duration string (e.g., "1m 23s")
 */
export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  ms: number = 1000,
  pausedMs: number = 0,
  endTime?: number,
  startTimeMono?: number,
): string {
  const get = () =>
    formatDuration(
      computeElapsedMs(startTime, pausedMs, endTime, startTimeMono),
    )

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!isRunning) return () => {}
      const interval = setInterval(notify, ms)
      return () => clearInterval(interval)
    },
    [isRunning, ms],
  )

  return useSyncExternalStore(subscribe, get, get)
}
