import { describe, expect, test } from 'bun:test'
import {
  AUTO_COMPACT_WINDOW_MAX_TOKENS,
  AUTO_COMPACT_WINDOW_MIN_TOKENS,
  AUTO_COMPACT_WINDOW_SOURCES,
  getAutoCompactWindowFromEnv,
  isAutoCompactWindowOverridden,
  normalizeAutoCompactWindowSetting,
  parseAutoCompactWindowInput,
  resolveAutoCompactWindow,
  resolveInitialAutoCompactWindow,
} from '../autoCompactWindow.js'

// Pure functions with env injected as an argument — no process.env mutation
// and no mock.module, so nothing here can leak into other files.

const MODEL_WINDOW = 200_000

function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: value }
}

describe('parseAutoCompactWindowInput', () => {
  test('accepts auto', () => {
    expect(parseAutoCompactWindowInput('auto')).toBe('auto')
    expect(parseAutoCompactWindowInput('  AUTO ')).toBe('auto')
  })

  test('accepts k/m suffixes and raw token counts', () => {
    expect(parseAutoCompactWindowInput('500k')).toBe(500_000)
    expect(parseAutoCompactWindowInput('1m')).toBe(1_000_000)
    expect(parseAutoCompactWindowInput('200000')).toBe(200_000)
  })

  test('reads a bare 100-1000 as thousands', () => {
    expect(parseAutoCompactWindowInput('200')).toBe(200_000)
    expect(parseAutoCompactWindowInput('1000')).toBe(1_000_000)
  })

  test('rejects values outside 100k-1M and garbage', () => {
    expect(parseAutoCompactWindowInput('50k')).toBeUndefined()
    expect(parseAutoCompactWindowInput('2m')).toBeUndefined()
    expect(parseAutoCompactWindowInput('99999')).toBeUndefined()
    expect(parseAutoCompactWindowInput('banana')).toBeUndefined()
    expect(parseAutoCompactWindowInput('')).toBeUndefined()
  })

  test('bounds are the official 100k-1M', () => {
    expect(AUTO_COMPACT_WINDOW_MIN_TOKENS).toBe(100_000)
    expect(AUTO_COMPACT_WINDOW_MAX_TOKENS).toBe(1_000_000)
    expect(parseAutoCompactWindowInput('100000')).toBe(100_000)
    expect(parseAutoCompactWindowInput('1000000')).toBe(1_000_000)
  })
})

describe('getAutoCompactWindowFromEnv', () => {
  test('returns undefined when unset or unparseable', () => {
    expect(getAutoCompactWindowFromEnv(env())).toBeUndefined()
    expect(getAutoCompactWindowFromEnv(env(''))).toBeUndefined()
    expect(getAutoCompactWindowFromEnv(env('banana'))).toBeUndefined()
  })

  test('raises sub-minimum values to the floor rather than ignoring them', () => {
    expect(getAutoCompactWindowFromEnv(env('50000'))).toBe(100_000)
  })

  test('caps above-maximum values', () => {
    expect(getAutoCompactWindowFromEnv(env('5000000'))).toBe(1_000_000)
  })
})

describe('normalizeAutoCompactWindowSetting', () => {
  test('accepts in-range integers only', () => {
    expect(normalizeAutoCompactWindowSetting(400_000)).toBe(400_000)
    expect(normalizeAutoCompactWindowSetting(50_000)).toBeUndefined()
    expect(normalizeAutoCompactWindowSetting(2_000_000)).toBeUndefined()
    expect(normalizeAutoCompactWindowSetting(400_000.5)).toBeUndefined()
    expect(normalizeAutoCompactWindowSetting('400000')).toBeUndefined()
    expect(normalizeAutoCompactWindowSetting(undefined)).toBeUndefined()
  })
})

describe('resolveAutoCompactWindow precedence', () => {
  test('env beats settings', () => {
    expect(
      resolveAutoCompactWindow(MODEL_WINDOW, 150_000, env('120000')),
    ).toEqual({
      window: 120_000,
      configured: 120_000,
      source: 'env',
    })
  })

  test('settings win when env is unset', () => {
    expect(resolveAutoCompactWindow(MODEL_WINDOW, 150_000, env())).toEqual({
      window: 150_000,
      configured: 150_000,
      source: 'settings',
    })
  })

  test('falls back to auto — the model window is the window', () => {
    expect(resolveAutoCompactWindow(MODEL_WINDOW, undefined, env())).toEqual({
      window: MODEL_WINDOW,
      configured: MODEL_WINDOW,
      source: 'auto',
    })
  })

  test('an invalid settings value falls through to auto instead of clamping', () => {
    expect(resolveAutoCompactWindow(MODEL_WINDOW, 10, env()).source).toBe(
      'auto',
    )
  })

  test('never widens past the model window — it only narrows', () => {
    // A 1M request against a 200k model still compacts at the model window.
    const resolved = resolveAutoCompactWindow(MODEL_WINDOW, 1_000_000, env())
    expect(resolved.window).toBe(MODEL_WINDOW)
    // configured keeps what the user asked for so the UI can say "capped".
    expect(resolved.configured).toBe(1_000_000)
    expect(resolved.source).toBe('settings')
  })

  test('isAutoCompactWindowOverridden is false only for auto', () => {
    expect(
      isAutoCompactWindowOverridden(
        resolveAutoCompactWindow(MODEL_WINDOW, undefined, env()),
      ),
    ).toBe(false)
    expect(
      isAutoCompactWindowOverridden(
        resolveAutoCompactWindow(MODEL_WINDOW, 150_000, env()),
      ),
    ).toBe(true)
  })
})

describe('resolveInitialAutoCompactWindow', () => {
  test('inherits settings when the CLI flag is absent', () => {
    expect(resolveInitialAutoCompactWindow(undefined, 400_000)).toEqual({
      autoCompactWindow: 400_000,
      autoCompactWindowOverride: false,
    })
  })

  test('a CLI token value overrides settings for this session', () => {
    expect(resolveInitialAutoCompactWindow(500_000, 400_000)).toEqual({
      autoCompactWindow: 500_000,
      autoCompactWindowOverride: true,
    })
  })

  test('explicit CLI auto suppresses the settings window', () => {
    expect(resolveInitialAutoCompactWindow('auto', 400_000)).toEqual({
      autoCompactWindow: undefined,
      autoCompactWindowOverride: true,
    })
  })
})

describe('source labels', () => {
  test('match the official set exactly', () => {
    expect([...AUTO_COMPACT_WINDOW_SOURCES].sort()).toEqual([
      'auto',
      'clientdata',
      'env',
      'experiment',
      'model-default',
      'settings',
      'unknown-model',
    ])
  })
})
