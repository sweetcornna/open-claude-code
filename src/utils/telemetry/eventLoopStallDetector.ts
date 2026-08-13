import { instances } from '@anthropic/ink'
import { logEvent } from '../../services/analytics/index.js'
import { registerCleanup } from '../process/cleanupRegistry.js'
import { logForDebugging } from './debug.js'

const INTERVAL_MS = 200
const STALL_THRESHOLD_MS = 500
const LIKELY_SLEEP_THRESHOLD_MS = 5_000

type ResourceSample = {
  cpuTimeMs: number
  majorPageFaults?: number
}

type MemorySample = {
  rss_mb: number
  heap_used_mb: number
  ext_mb: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sampleCpuAndPageFaults(): ResourceSample | null {
  try {
    const usage = process.resourceUsage()
    const majorPageFaults = Number.isFinite(usage.majorPageFault)
      ? usage.majorPageFault
      : undefined
    return {
      cpuTimeMs: (usage.userCPUTime + usage.systemCPUTime) / 1_000,
      ...(majorPageFaults === undefined ? {} : { majorPageFaults }),
    }
  } catch (error) {
    logForDebugging(
      `[event-loop-stall] process.resourceUsage() failed: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return null
  }
}

export function sampleRss(): MemorySample | null {
  try {
    const usage = process.memoryUsage()
    return {
      rss_mb: Math.round(usage.rss / 1024 / 1024),
      heap_used_mb: Math.round(usage.heapUsed / 1024 / 1024),
      ext_mb: Math.round(usage.external / 1024 / 1024),
    }
  } catch (error) {
    logForDebugging(
      `[event-loop-stall] process.memoryUsage() failed: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return null
  }
}

class EventLoopStallDetector {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickMs = 0
  private totalStalls = 0
  private totalStallDurationMs = 0
  private lastResourceSample: ResourceSample | null = null

  start(): void {
    if (this.timer !== null) return

    this.lastTickMs = Date.now()
    this.lastResourceSample = sampleCpuAndPageFaults()
    logForDebugging(
      `[event-loop-stall] detector started (interval=${INTERVAL_MS}ms, threshold=${STALL_THRESHOLD_MS}ms)`,
    )

    this.timer = setInterval(() => this.tick(), INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const now = Date.now()
    const actualIntervalMs = now - this.lastTickMs
    const stallDurationMs = actualIntervalMs - INTERVAL_MS
    const resourceSample = sampleCpuAndPageFaults()

    // Advance the baseline before logging or repairing the terminal. A single
    // sleep/wake gap must produce one observation, not a run of stale stalls.
    this.lastTickMs = now
    const previousResourceSample = this.lastResourceSample
    this.lastResourceSample = resourceSample

    if (stallDurationMs <= STALL_THRESHOLD_MS) return

    this.totalStalls++
    this.totalStallDurationMs += stallDurationMs

    const likelySleep = stallDurationMs > LIKELY_SLEEP_THRESHOLD_MS
    const memorySample = sampleRss()
    const cpuAndFaultDeltas =
      resourceSample && previousResourceSample
        ? {
            cpu_delta_ms: Math.round(
              resourceSample.cpuTimeMs - previousResourceSample.cpuTimeMs,
            ),
            ...(resourceSample.majorPageFaults === undefined ||
            previousResourceSample.majorPageFaults === undefined
              ? {}
              : {
                  major_fault_delta:
                    resourceSample.majorPageFaults -
                    previousResourceSample.majorPageFaults,
                }),
          }
        : null

    logForDebugging(
      `[event-loop-stall] blocked for ${stallDurationMs}ms (expected ${INTERVAL_MS}ms, actual ${actualIntervalMs}ms). Total stalls: ${this.totalStalls}, cumulative: ${this.totalStallDurationMs}ms${likelySleep ? ' [likely sleep/wake]' : ''}` +
        (cpuAndFaultDeltas
          ? ` cpu=${cpuAndFaultDeltas.cpu_delta_ms}ms${cpuAndFaultDeltas.major_fault_delta === undefined ? '' : ` majflt=${cpuAndFaultDeltas.major_fault_delta}`}`
          : '') +
        (memorySample
          ? ` rss=${memorySample.rss_mb}MB heap=${memorySample.heap_used_mb}MB ext=${memorySample.ext_mb}MB`
          : ''),
      { level: 'warn' },
    )

    // Keep analytics bounded to primitive counters. In particular, do not send
    // the debug message or sampled runtime objects on this recurring path.
    logEvent('tengu_event_loop_stall', {
      stall_duration_ms: stallDurationMs,
      expected_interval_ms: INTERVAL_MS,
      actual_interval_ms: actualIntervalMs,
      total_stalls: this.totalStalls,
      cumulative_stall_ms: this.totalStallDurationMs,
      likely_sleep: likelySleep,
      ...(cpuAndFaultDeltas ?? {}),
      ...(memorySample ?? {}),
    })

    if (likelySleep) {
      // Re-enter modes through Ink's active host instance. This restores Kitty
      // keys, mouse tracking, and the alternate screen without duplicating its
      // terminal capability checks or escape sequences here.
      instances.get(process.stdout)?.reassertTerminalModes(true)
    }
  }
}

let activeDetector: EventLoopStallDetector | null = null
let activeCleanup: (() => void) | null = null
let unregisterCleanup: (() => void) | null = null

/** Start the process-wide detector and return its idempotent cleanup function. */
export function startEventLoopStallDetector(): () => void {
  if (activeCleanup !== null) return activeCleanup

  const detector = new EventLoopStallDetector()
  const cleanup = (): void => {
    if (activeDetector !== detector) return

    detector.stop()
    activeDetector = null
    activeCleanup = null
    unregisterCleanup?.()
    unregisterCleanup = null
  }

  detector.start()
  activeDetector = detector
  activeCleanup = cleanup
  unregisterCleanup = registerCleanup(async () => cleanup())
  return cleanup
}
