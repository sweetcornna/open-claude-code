/**
 * Precedence table for screen-reader mode: CLI flag > env > settings.
 *
 * `resolveScreenReaderMode` is pure, so the table is driven by arguments
 * rather than by mutating process.env / the settings cache — no mock.module
 * needed, and no state leaks into whatever file bun loads next.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  isScreenReaderMode,
  resetScreenReaderModeForTesting,
  resolveScreenReaderMode,
  screenReaderActivationSource,
  setScreenReaderModeOverride,
} from '../screenReader.js'

afterEach(() => {
  resetScreenReaderModeForTesting()
  delete process.env.CLAUDE_AX_SCREEN_READER
})

describe('resolveScreenReaderMode', () => {
  test('CLI flag wins over env and settings', () => {
    expect(
      resolveScreenReaderMode({ flag: true, env: '0', settings: false }),
    ).toEqual({ enabled: true, source: 'flag' })
  })

  test('an explicit false flag beats a truthy env and settings', () => {
    expect(
      resolveScreenReaderMode({ flag: false, env: '1', settings: true }),
    ).toEqual({ enabled: false, source: undefined })
  })

  test('env wins over settings when the flag is absent', () => {
    expect(
      resolveScreenReaderMode({ flag: undefined, env: '1', settings: false }),
    ).toEqual({ enabled: true, source: 'env' })
  })

  test('env is tri-state: an explicitly falsy value overrides settings', () => {
    expect(
      resolveScreenReaderMode({ flag: undefined, env: '0', settings: true }),
    ).toEqual({ enabled: false, source: undefined })
    expect(
      resolveScreenReaderMode({
        flag: undefined,
        env: 'false',
        settings: true,
      }),
    ).toEqual({ enabled: false, source: undefined })
  })

  test('an unparseable env value falls through to settings', () => {
    expect(
      resolveScreenReaderMode({
        flag: undefined,
        env: 'maybe',
        settings: true,
      }),
    ).toEqual({ enabled: true, source: 'settings' })
  })

  test('settings are the last resort', () => {
    expect(
      resolveScreenReaderMode({
        flag: undefined,
        env: undefined,
        settings: true,
      }),
    ).toEqual({ enabled: true, source: 'settings' })
    expect(
      resolveScreenReaderMode({
        flag: undefined,
        env: undefined,
        settings: undefined,
      }),
    ).toEqual({ enabled: false, source: undefined })
  })
})

describe('isScreenReaderMode', () => {
  test('defaults to off', () => {
    expect(isScreenReaderMode()).toBe(false)
    expect(screenReaderActivationSource()).toBeUndefined()
  })

  test('the CLI override turns it on and reports its source', () => {
    setScreenReaderModeOverride(true)
    expect(isScreenReaderMode()).toBe(true)
    expect(screenReaderActivationSource()).toBe('flag')
  })

  test('the env var turns it on when no flag was passed', () => {
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    resetScreenReaderModeForTesting()
    expect(isScreenReaderMode()).toBe(true)
    expect(screenReaderActivationSource()).toBe('env')
  })

  test('a parsed false flag suppresses the env var', () => {
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    setScreenReaderModeOverride(false)
    expect(isScreenReaderMode()).toBe(false)
  })

  test('the result is memoized until reset', () => {
    expect(isScreenReaderMode()).toBe(false)
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    expect(isScreenReaderMode()).toBe(false)
    resetScreenReaderModeForTesting()
    expect(isScreenReaderMode()).toBe(true)
  })
})
