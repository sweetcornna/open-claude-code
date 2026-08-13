import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { instances } from '@anthropic/ink'
import {
  _resetForTesting as resetAnalyticsForTesting,
  attachAnalyticsSink,
  type AnalyticsSink,
} from '../../../services/analytics/index.js'
import { runCleanupFunctions } from '../../process/cleanupRegistry.js'
import { startEventLoopStallDetector } from '../eventLoopStallDetector.js'

type IntervalHandle = ReturnType<typeof setInterval>
type IntervalCallback = () => void

type AnalyticsEvent = {
  eventName: string
  metadata: Record<string, boolean | number | undefined>
}

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realDateNow = Date.now
const realMemoryUsage = process.memoryUsage
const realResourceUsage = process.resourceUsage

let now = 0
let intervalCallback: IntervalCallback | undefined
let intervalHandle: IntervalHandle
let setIntervalCalls = 0
let clearIntervalCalls = 0
let unrefCalls = 0
let cleanupDetector: (() => void) | undefined
let analyticsEvents: AnalyticsEvent[] = []

function resourceUsage(
  cpuTimeMs: number,
  majorPageFault = 0,
): NodeJS.ResourceUsage {
  return {
    userCPUTime: cpuTimeMs * 1_000,
    systemCPUTime: 0,
    maxRSS: 0,
    sharedMemorySize: 0,
    unsharedDataSize: 0,
    unsharedStackSize: 0,
    minorPageFault: 0,
    majorPageFault,
    swappedOut: 0,
    fsRead: 0,
    fsWrite: 0,
    ipcSent: 0,
    ipcReceived: 0,
    signalsCount: 0,
    voluntaryContextSwitches: 0,
    involuntaryContextSwitches: 0,
  }
}

function fireIntervalAt(timeMs: number): void {
  now = timeMs
  intervalCallback?.()
}

beforeEach(() => {
  now = 0
  intervalCallback = undefined
  setIntervalCalls = 0
  clearIntervalCalls = 0
  unrefCalls = 0
  analyticsEvents = []

  const handle = {
    unref: () => {
      unrefCalls++
      return handle
    },
  }
  intervalHandle = handle as unknown as IntervalHandle

  globalThis.setInterval = ((callback: IntervalCallback, delay?: number) => {
    expect(delay).toBe(200)
    setIntervalCalls++
    intervalCallback = callback
    return intervalHandle
  }) as typeof setInterval
  globalThis.clearInterval = ((handleToClear: IntervalHandle) => {
    expect(handleToClear).toBe(intervalHandle)
    clearIntervalCalls++
    intervalCallback = undefined
  }) as typeof clearInterval
  Date.now = () => now

  let cpuTimeMs = 0
  process.resourceUsage = () => {
    cpuTimeMs += 10
    return resourceUsage(cpuTimeMs, cpuTimeMs / 10)
  }
  process.memoryUsage = Object.assign(
    () => ({
      rss: 256 * 1024 * 1024,
      heapTotal: 192 * 1024 * 1024,
      heapUsed: 128 * 1024 * 1024,
      external: 16 * 1024 * 1024,
      arrayBuffers: 8 * 1024 * 1024,
    }),
    { rss: () => 256 * 1024 * 1024 },
  )

  const sink: AnalyticsSink = {
    logEvent: (eventName, metadata) => {
      if (eventName === 'tengu_event_loop_stall') {
        analyticsEvents.push({ eventName, metadata })
      }
    },
    logEventAsync: async (eventName, metadata) => {
      if (eventName === 'tengu_event_loop_stall') {
        analyticsEvents.push({ eventName, metadata })
      }
    },
  }
  attachAnalyticsSink(sink)
})

afterEach(() => {
  cleanupDetector?.()
  cleanupDetector = undefined
  instances.delete(process.stdout)
  resetAnalyticsForTesting()
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  Date.now = realDateNow
  process.memoryUsage = realMemoryUsage
  process.resourceUsage = realResourceUsage
  mock.restore()
})

describe('startEventLoopStallDetector', () => {
  test('starts a 200ms unref interval and stays silent for normal ticks', () => {
    cleanupDetector = startEventLoopStallDetector()

    expect(setIntervalCalls).toBe(1)
    expect(unrefCalls).toBe(1)

    fireIntervalAt(200)
    fireIntervalAt(400)

    expect(analyticsEvents).toEqual([])
  })

  test('reports stalls over 500ms with bounded resource metadata', () => {
    cleanupDetector = startEventLoopStallDetector()

    fireIntervalAt(700)
    expect(analyticsEvents).toEqual([])
    fireIntervalAt(1_401)

    expect(analyticsEvents).toHaveLength(1)
    expect(analyticsEvents[0]).toEqual({
      eventName: 'tengu_event_loop_stall',
      metadata: {
        stall_duration_ms: 501,
        expected_interval_ms: 200,
        actual_interval_ms: 701,
        total_stalls: 1,
        cumulative_stall_ms: 501,
        likely_sleep: false,
        cpu_delta_ms: 10,
        major_fault_delta: 1,
        rss_mb: 256,
        heap_used_mb: 128,
        ext_mb: 16,
      },
    })
    expect(
      Object.values(analyticsEvents[0]!.metadata).every(
        value => typeof value === 'number' || typeof value === 'boolean',
      ),
    ).toBe(true)
  })

  test('handles a sleep gap once and restores terminal modes through Ink', () => {
    const reassertTerminalModes = mock(() => {})
    instances.set(process.stdout, {
      reassertTerminalModes,
    } as unknown as NonNullable<ReturnType<typeof instances.get>>)
    cleanupDetector = startEventLoopStallDetector()

    fireIntervalAt(5_201)
    fireIntervalAt(5_401)

    expect(analyticsEvents).toHaveLength(1)
    expect(analyticsEvents[0]?.metadata.likely_sleep).toBe(true)
    expect(reassertTerminalModes).toHaveBeenCalledTimes(1)
    expect(reassertTerminalModes).toHaveBeenCalledWith(true)
  })

  test('omits resource fields when platform sampling is unavailable', () => {
    process.resourceUsage = () => {
      throw new Error('unsupported')
    }
    cleanupDetector = startEventLoopStallDetector()

    fireIntervalAt(701)

    expect(analyticsEvents).toHaveLength(1)
    expect(analyticsEvents[0]?.metadata.cpu_delta_ms).toBeUndefined()
    expect(analyticsEvents[0]?.metadata.major_fault_delta).toBeUndefined()
  })

  test('cleanup clears the interval and is idempotent', () => {
    cleanupDetector = startEventLoopStallDetector()

    cleanupDetector()
    cleanupDetector()

    expect(clearIntervalCalls).toBe(1)
    fireIntervalAt(701)
    expect(analyticsEvents).toEqual([])
    cleanupDetector = undefined
  })

  test('registered cleanup stops the detector', async () => {
    cleanupDetector = startEventLoopStallDetector()

    await runCleanupFunctions()

    expect(clearIntervalCalls).toBe(1)
    cleanupDetector = undefined
  })

  test('multiple starts share one detector and cleanup', () => {
    const firstCleanup = startEventLoopStallDetector()
    const secondCleanup = startEventLoopStallDetector()
    cleanupDetector = firstCleanup

    expect(secondCleanup).toBe(firstCleanup)
    expect(setIntervalCalls).toBe(1)

    firstCleanup()
    cleanupDetector = startEventLoopStallDetector()
    expect(setIntervalCalls).toBe(2)
  })
})
