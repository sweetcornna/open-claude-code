import { describe, expect, test } from 'bun:test'
import {
  clampBashTimeoutMs,
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../timeouts.js'

// clampBashTimeoutMs enforces the ceiling the Bash schema/prompt advertise
// ("max 600000") — before it existed, `timeout || default` passed any value
// through, so a model could request an hour-long blocking foreground bash.
describe('clampBashTimeoutMs', () => {
  const DEFAULT = 120_000
  const MAX = 600_000
  // Isolate from ambient BASH_*_TIMEOUT_MS so the numbers are deterministic.
  const cleanEnv: Record<string, string | undefined> = {}

  test('caps an oversized request at the max', () => {
    expect(clampBashTimeoutMs(3_600_000, cleanEnv)).toBe(MAX)
    expect(clampBashTimeoutMs(MAX + 1, cleanEnv)).toBe(MAX)
  })

  test('leaves a legitimate in-range request unchanged', () => {
    expect(clampBashTimeoutMs(5_000, cleanEnv)).toBe(5_000)
    expect(clampBashTimeoutMs(30_000, cleanEnv)).toBe(30_000)
    expect(clampBashTimeoutMs(MAX, cleanEnv)).toBe(MAX)
    expect(clampBashTimeoutMs(1, cleanEnv)).toBe(1)
  })

  test('falls back to the default for absent / non-finite / non-positive input', () => {
    expect(clampBashTimeoutMs(undefined, cleanEnv)).toBe(DEFAULT)
    expect(clampBashTimeoutMs(0, cleanEnv)).toBe(DEFAULT)
    // A bare `timeout || default` would let -5 (truthy) slip through.
    expect(clampBashTimeoutMs(-5, cleanEnv)).toBe(DEFAULT)
    expect(clampBashTimeoutMs(Number.NaN, cleanEnv)).toBe(DEFAULT)
    expect(clampBashTimeoutMs(Number.POSITIVE_INFINITY, cleanEnv)).toBe(DEFAULT)
  })

  test('respects env overrides for the ceiling', () => {
    const env = { BASH_MAX_TIMEOUT_MS: '900000' }
    expect(getMaxBashTimeoutMs(env)).toBe(900_000)
    expect(clampBashTimeoutMs(800_000, env)).toBe(800_000)
    expect(clampBashTimeoutMs(1_000_000, env)).toBe(900_000)
  })

  test('never returns a fallback above the ceiling even if default > max', () => {
    // Pathological: default configured higher than the (smaller) hard max.
    const env = { BASH_DEFAULT_TIMEOUT_MS: '5000000' }
    // getMaxBashTimeoutMs floors max at the default, so they coincide here.
    expect(getDefaultBashTimeoutMs(env)).toBe(5_000_000)
    expect(clampBashTimeoutMs(undefined, env)).toBe(getMaxBashTimeoutMs(env))
  })
})
