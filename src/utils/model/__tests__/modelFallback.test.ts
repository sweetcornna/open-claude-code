/**
 * CLAUDE_CODE_NO_MODEL_FALLBACK. The env is passed in rather than mutated so
 * the table cannot leak into whatever file bun loads next.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildAvailabilityFallbackChain,
  isNoModelFallbackEnabled,
} from '../modelFallback.js'

describe('isNoModelFallbackEnabled', () => {
  test('off when unset or empty', () => {
    expect(isNoModelFallbackEnabled({})).toBe(false)
    expect(
      isNoModelFallbackEnabled({ CLAUDE_CODE_NO_MODEL_FALLBACK: '' }),
    ).toBe(false)
  })

  test('accepts the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' on ']) {
      expect(
        isNoModelFallbackEnabled({ CLAUDE_CODE_NO_MODEL_FALLBACK: value }),
      ).toBe(true)
    }
  })

  test('anything else is off', () => {
    for (const value of ['0', 'false', 'no', 'off', 'maybe']) {
      expect(
        isNoModelFallbackEnabled({ CLAUDE_CODE_NO_MODEL_FALLBACK: value }),
      ).toBe(false)
    }
  })
})

describe('buildAvailabilityFallbackChain', () => {
  test('passes the configured chain through untouched by default', () => {
    expect(buildAvailabilityFallbackChain(['sonnet', 'haiku'], {})).toEqual([
      'sonnet',
      'haiku',
    ])
    expect(buildAvailabilityFallbackChain(undefined, {})).toBeUndefined()
  })

  test('collapses the chain when the guarantee is active', () => {
    expect(
      buildAvailabilityFallbackChain(['sonnet', 'haiku'], {
        CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
      }),
    ).toBeUndefined()
  })

  test('an off value leaves --fallback-model working', () => {
    expect(
      buildAvailabilityFallbackChain(['sonnet'], {
        CLAUDE_CODE_NO_MODEL_FALLBACK: '0',
      }),
    ).toEqual(['sonnet'])
  })
})
