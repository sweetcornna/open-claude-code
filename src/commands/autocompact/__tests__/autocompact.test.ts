import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  applyAutoCompactWindow,
  formatAutoCompactWindowStatus,
} from '../autocompact.js'
import type { AutoCompactWindowSource } from '../../../services/compact/autoCompactWindow.js'

// No mock.module: the status formatter is pure, and the only applyAutoCompactWindow
// path exercised here is the one that refuses to write (env override active) plus
// the parse-error path — neither touches the user's settings.json.

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const MODEL = 'claude-sonnet-4-5-20250929'

function status(
  source: AutoCompactWindowSource,
  configured: number,
  window: number,
  enabled = true,
): string {
  return formatAutoCompactWindowStatus({ window, configured, source }, enabled)
}

describe('formatAutoCompactWindowStatus', () => {
  test('auto reports no override and no warning', () => {
    const text = status('auto', 200_000, 200_000)
    expect(text.split('\n')[0]).toBe('Auto-compact window: auto')
    expect(text).not.toContain('Overriding auto')
  })

  test('env names the environment variable and warns', () => {
    const text = status('env', 150_000, 150_000)
    expect(text.split('\n')[0]).toBe(
      `Auto-compact window: 150k tokens (from ${ENV_KEY})`,
    )
    expect(text).toContain('Overriding auto may result in high token usage')
  })

  test('settings say so and warn', () => {
    const text = status('settings', 150_000, 150_000)
    expect(text.split('\n')[0]).toBe(
      'Auto-compact window: 150k tokens (from settings)',
    )
    expect(text).toContain('Overriding auto may result in high token usage')
  })

  test('a configured value above the model window is reported as capped', () => {
    const text = status('settings', 1_000_000, 200_000)
    expect(text.split('\n')[0]).toBe(
      'Auto-compact window: 1m tokens (from settings) · capped to 200k by model',
    )
  })

  test('experiment and clientdata still read as auto', () => {
    expect(status('experiment', 150_000, 150_000).split('\n')[0]).toBe(
      'Auto-compact window: auto (150k tokens)',
    )
    expect(status('clientdata', 150_000, 150_000).split('\n')[0]).toBe(
      'Auto-compact window: auto (150k tokens)',
    )
  })

  test('model-default and unknown-model explain where the number came from', () => {
    expect(status('model-default', 150_000, 150_000).split('\n')[0]).toBe(
      'Auto-compact window: 150k tokens (default for this model)',
    )
    expect(status('unknown-model', 150_000, 150_000).split('\n')[0]).toBe(
      'Auto-compact window: 150k tokens (default for an unrecognized model)',
    )
  })

  test('a disabled auto-compact says so', () => {
    expect(status('auto', 200_000, 200_000, false)).toContain(
      'Auto-compact is currently disabled (see /config)',
    )
    expect(status('auto', 200_000, 200_000, true)).not.toContain(
      'Auto-compact is currently disabled',
    )
  })
})

describe('applyAutoCompactWindow', () => {
  const previous = process.env[ENV_KEY]

  beforeEach(() => {
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = previous
    }
  })

  test('refuses to write while the env var is set, instead of silently no-op-ing', () => {
    process.env[ENV_KEY] = '150000'
    expect(applyAutoCompactWindow('500k', MODEL)).toBe(
      `${ENV_KEY} is set and takes precedence. Unset it to change this setting.`,
    )
  })

  test('reports unparseable input without writing settings', () => {
    expect(applyAutoCompactWindow('banana', MODEL)).toBe(
      "Couldn't parse 'banana'. Expected 'auto' or 100k–1m tokens (e.g. 500k, 200000, or 200 as shorthand)",
    )
  })

  test('out-of-range values are a parse error, not a clamp', () => {
    expect(applyAutoCompactWindow('50k', MODEL)).toContain("Couldn't parse")
  })
})
