import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  autoHeapDumpEnabled,
  observeHeapUsage,
  resetHeapObservationForTests,
} from '../autoHeapDump.js'

const GB = 1024 ** 3
const savedEnv = process.env.CLAUDE_CODE_AUTO_HEAP_DUMP

beforeEach(() => {
  delete process.env.CLAUDE_CODE_AUTO_HEAP_DUMP
  resetHeapObservationForTests()
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CODE_AUTO_HEAP_DUMP
  else process.env.CLAUDE_CODE_AUTO_HEAP_DUMP = savedEnv
})

describe('observeHeapUsage', () => {
  test('stays silent below the first threshold', () => {
    expect(observeHeapUsage(0.9 * GB, 0)).toBeNull()
    expect(observeHeapUsage(1.4 * GB, 10_000)).toBeNull()
  })

  test('reports once per threshold, not once per poll', () => {
    expect(observeHeapUsage(1.0 * GB, 0)).toBeNull()
    expect(observeHeapUsage(1.6 * GB, 10_000)?.thresholdGB).toBe(1.5)
    expect(observeHeapUsage(1.7 * GB, 20_000)).toBeNull()
    expect(observeHeapUsage(1.8 * GB, 30_000)).toBeNull()
    expect(observeHeapUsage(2.6 * GB, 40_000)?.thresholdGB).toBe(2.5)
  })

  test('a jump past several thresholds reports once, naming the highest', () => {
    expect(observeHeapUsage(1.0 * GB, 0)).toBeNull()
    const obs = observeHeapUsage(3.6 * GB, 60_000)
    expect(obs?.thresholdGB).toBe(3.5)
    expect(obs?.message).toContain('crossed 3.5 GB')
  })

  test('reports the growth rate that makes a leak visible', () => {
    observeHeapUsage(0.5 * GB, 0)
    const obs = observeHeapUsage(1.6 * GB, 30 * 60 * 1000)
    // +1.1 GB over 30 min.
    expect(obs?.message).toMatch(/growth 2\d{3} MB\/h over 30 min/)
  })

  test('does not fall back to wall-clock when a caller supplies `now`', () => {
    // A regression here would make the growth rate meaningless (elapsed would
    // be the process uptime, not the observation window).
    observeHeapUsage(1.0 * GB, 1_000_000)
    const obs = observeHeapUsage(1.6 * GB, 1_000_000 + 60 * 60 * 1000)
    expect(obs?.message).toContain('over 60 min')
  })

  test('points at the env var instead of writing files by default', () => {
    expect(autoHeapDumpEnabled()).toBe(false)
    const obs = observeHeapUsage(1.6 * GB, 0)
    expect(obs?.snapshotRequested).toBe(false)
    expect(obs?.message).toContain('CLAUDE_CODE_AUTO_HEAP_DUMP=1')
  })

  test('requests a snapshot when explicitly enabled, capped per session', () => {
    process.env.CLAUDE_CODE_AUTO_HEAP_DUMP = '1'
    expect(observeHeapUsage(1.6 * GB, 0)?.snapshotRequested).toBe(true)
    expect(observeHeapUsage(2.6 * GB, 10_000)?.snapshotRequested).toBe(true)
    // Third threshold exceeds MAX_AUTO_DUMPS — still warns, no third snapshot.
    const third = observeHeapUsage(3.6 * GB, 20_000)
    expect(third?.thresholdGB).toBe(3.5)
    expect(third?.snapshotRequested).toBe(false)
  })
})
