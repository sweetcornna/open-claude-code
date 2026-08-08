/**
 * Escalating memory warnings, and an opt-in automatic heap snapshot.
 *
 * heapDumpService has carried an `auto-1.5GB` trigger since it was written, but
 * nothing ever called performHeapDump with it — the automatic path was dead
 * code. So when a session died with `FATAL ERROR: Ineffective mark-compacts near
 * heap limit` at 4 GB, it left nothing behind to analyse: no diagnostics, no
 * snapshot, no growth history. The leak had to be reconstructed from session
 * transcripts afterwards.
 *
 * What fires by default is only the log line: heapUsed/rss/external plus the
 * growth rate, at each threshold crossed. That is cheap, writes no files, and
 * is what turns "it ran out of memory" into a starting point.
 *
 * The snapshot itself stays opt-in behind CLAUDE_CODE_AUTO_HEAP_DUMP, because
 * serialising a multi-GB heap writes a multi-GB file to the user's Desktop and
 * stalls the process for seconds — not something to do unannounced to someone
 * who is already having a bad time.
 */
import { isEnvTruthy } from '../config/envUtils.js'
import { logForDebugging } from './debug.js'

/** Thresholds in bytes, ascending. Each fires at most once per session. */
const THRESHOLDS_GB = [1.5, 2.5, 3.5] as const

/** Snapshots are large and slow; two is enough to show a growth delta. */
const MAX_AUTO_DUMPS = 2

let firedThresholds = 0
let dumpsTaken = 0
let firstObservation: { at: number; heapUsed: number } | null = null

export function autoHeapDumpEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_AUTO_HEAP_DUMP)
}

/** What a poll decided, or null when it was below every unfired threshold. */
export type HeapObservation = {
  /** The threshold, in GB, that this crossing reports. */
  thresholdGB: number
  message: string
  snapshotRequested: boolean
}

/**
 * Call on each memory poll. Logs once per threshold crossed, and takes a
 * snapshot when explicitly enabled.
 *
 * Returns the decision as well as logging it, so tests can assert on it without
 * mocking the logger.
 *
 * `now` is injectable so tests don't depend on wall-clock timing.
 */
export function observeHeapUsage(
  heapUsed: number,
  now: number = Date.now(),
): HeapObservation | null {
  firstObservation ??= { at: now, heapUsed }

  let crossed = 0
  for (const gb of THRESHOLDS_GB) {
    if (heapUsed >= gb * 1024 * 1024 * 1024) crossed++
  }
  if (crossed <= firedThresholds) return null
  firedThresholds = crossed

  const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(2)
  const usage = process.memoryUsage()
  const elapsedSec = Math.max(1, (now - firstObservation.at) / 1000)
  const mbPerHour =
    ((heapUsed - firstObservation.heapUsed) / 1024 ** 2 / elapsedSec) * 3600

  const thresholdGB = THRESHOLDS_GB[crossed - 1]!
  const wantsSnapshot = autoHeapDumpEnabled() && dumpsTaken < MAX_AUTO_DUMPS
  const message =
    `[memory] heapUsed ${gb(heapUsed)} GB crossed ${thresholdGB} GB ` +
    `(rss ${gb(usage.rss)} GB, external ${gb(usage.external)} GB, ` +
    `growth ${mbPerHour.toFixed(0)} MB/h over ${(elapsedSec / 60).toFixed(0)} min). ` +
    (wantsSnapshot
      ? 'Capturing heap snapshot.'
      : 'Set CLAUDE_CODE_AUTO_HEAP_DUMP=1 to capture a heap snapshot at these thresholds.')

  logForDebugging(message)

  if (wantsSnapshot) {
    dumpsTaken++
    // Dynamic import: heapDumpService pulls in v8 + fs plumbing that a session
    // which never crosses a threshold should not pay for.
    void import('./heapDumpService.js')
      .then(m => m.performHeapDump('auto-1.5GB', dumpsTaken))
      .catch(e =>
        logForDebugging(`[memory] auto heap dump failed: ${String(e)}`),
      )
  }

  return { thresholdGB, message, snapshotRequested: wantsSnapshot }
}

/** Test hook. */
export function resetHeapObservationForTests(): void {
  firedThresholds = 0
  dumpsTaken = 0
  firstObservation = null
}
