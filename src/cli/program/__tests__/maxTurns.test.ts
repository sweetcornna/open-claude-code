/**
 * `--max-turns` / CLAUDE_CODE_MAX_TURNS precedence and validation. Pure, no mocks.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_TURNS_ENV_VAR, resolveMaxTurns } from '../maxTurns.js'

describe('resolveMaxTurns', () => {
  test('the flag wins over the environment', () => {
    expect(resolveMaxTurns(3, '99')).toBe(3)
  })

  test('the environment supplies the default when the flag is absent', () => {
    expect(resolveMaxTurns(undefined, '12')).toBe(12)
    expect(resolveMaxTurns(undefined, ' 12 ')).toBe(12)
  })

  test('an absent or blank environment value means no ceiling', () => {
    expect(resolveMaxTurns(undefined, undefined)).toBeUndefined()
    expect(resolveMaxTurns(undefined, '')).toBeUndefined()
    expect(resolveMaxTurns(undefined, '   ')).toBeUndefined()
  })

  test('rejects a malformed value instead of silently ignoring it', () => {
    // Failing open here means an unbounded agent loop and an unbounded bill —
    // the opposite trade-off from the managed version gate.
    for (const bad of ['0', '-1', '2.5', 'many', 'NaN']) {
      expect(() => resolveMaxTurns(undefined, bad)).toThrow(MAX_TURNS_ENV_VAR)
    }
  })

  test('a flag value of 0 is still honoured as an explicit choice', () => {
    // Validation of the flag itself belongs to Commander; this function must
    // not second-guess a value the user typed.
    expect(resolveMaxTurns(0, '5')).toBe(0)
  })
})
