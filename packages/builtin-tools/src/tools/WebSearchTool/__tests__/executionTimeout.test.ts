import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  parseWebSearchExecutionTimeoutMs,
} from '../executionTimeout.js'

describe('parseWebSearchExecutionTimeoutMs', () => {
  test('defaults to three minutes', () => {
    expect(parseWebSearchExecutionTimeoutMs(undefined)).toBe(180_000)
  })

  test('accepts zero as the explicit disable value', () => {
    expect(parseWebSearchExecutionTimeoutMs('0')).toBe(0)
  })

  test('accepts a positive integer override', () => {
    expect(parseWebSearchExecutionTimeoutMs(' 15000 ')).toBe(15_000)
  })

  test('rejects invalid, negative, fractional, and overflowing values', () => {
    for (const raw of ['nope', '-1', '1.5', '2147483648', '9007199254740992']) {
      expect(parseWebSearchExecutionTimeoutMs(raw)).toBe(
        DEFAULT_WEB_SEARCH_TIMEOUT_MS,
      )
    }
  })
})
