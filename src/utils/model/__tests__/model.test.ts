import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../settings/types.js'

/**
 * `apply1mContextOptIn` consults the per-tier configuration (that layer is the
 * second source of the `[1m]` suffix), which reads userSettings. Without a
 * mocked source these assertions measure the developer's own settings.json:
 * anyone whose sonnet tier is configured at 1M gets `[1m]` appended and the
 * "no-op" cases below fail — locally only, since a CI runner has no such file.
 * Green on CI and red on a configured machine is the worst polarity there is,
 * so the source is pinned to empty here. Same reasoning as
 * utils/session/__tests__/tierContextWindow.test.ts.
 */
const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: () => ({}) as SettingsJson,
    getInitialSettings: () => ({}) as SettingsJson,
  }),
)
afterAll(() => settingsMock.reset())

const { apply1mContextOptIn, firstPartyNameToCanonical } = await import(
  '../model.js'
)

describe('firstPartyNameToCanonical', () => {
  test('maps opus-4-6 full name to canonical', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-6-20250514')).toBe(
      'claude-opus-4-6',
    )
  })

  test('maps sonnet-4-6 full name', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-4-6-20250514')).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('maps haiku-4-5', () => {
    expect(firstPartyNameToCanonical('claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5',
    )
  })

  test('maps 3P provider format', () => {
    expect(firstPartyNameToCanonical('us.anthropic.claude-opus-4-6-v1:0')).toBe(
      'claude-opus-4-6',
    )
  })

  test('maps claude-3-7-sonnet', () => {
    expect(firstPartyNameToCanonical('claude-3-7-sonnet-20250219')).toBe(
      'claude-3-7-sonnet',
    )
  })

  test('maps claude-3-5-sonnet', () => {
    expect(firstPartyNameToCanonical('claude-3-5-sonnet-20241022')).toBe(
      'claude-3-5-sonnet',
    )
  })

  test('maps claude-3-5-haiku', () => {
    expect(firstPartyNameToCanonical('claude-3-5-haiku-20241022')).toBe(
      'claude-3-5-haiku',
    )
  })

  test('maps claude-3-opus', () => {
    expect(firstPartyNameToCanonical('claude-3-opus-20240229')).toBe(
      'claude-3-opus',
    )
  })

  test('is case insensitive', () => {
    expect(firstPartyNameToCanonical('Claude-Opus-4-6-20250514')).toBe(
      'claude-opus-4-6',
    )
  })

  test('falls back to input for unknown model', () => {
    expect(firstPartyNameToCanonical('unknown-model')).toBe('unknown-model')
  })

  test('differentiates opus-4 vs opus-4-5 vs opus-4-6', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-20240101')).toBe(
      'claude-opus-4',
    )
    expect(firstPartyNameToCanonical('claude-opus-4-5-20240101')).toBe(
      'claude-opus-4-5',
    )
    expect(firstPartyNameToCanonical('claude-opus-4-6-20240101')).toBe(
      'claude-opus-4-6',
    )
  })

  test('maps opus-4-1', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-1-20240101')).toBe(
      'claude-opus-4-1',
    )
  })

  test('maps sonnet-4-5', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-4-5-20240101')).toBe(
      'claude-sonnet-4-5',
    )
  })

  test('maps sonnet-4', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-4-20240101')).toBe(
      'claude-sonnet-4',
    )
  })
})

describe('apply1mContextOptIn', () => {
  test('appends [1m] when the model matches an opt-in entry', () => {
    expect(apply1mContextOptIn('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6[1m]',
    )
    expect(apply1mContextOptIn('claude-opus-4-7', 'sonnet, opus')).toBe(
      'claude-opus-4-7[1m]',
    )
  })

  test('matching is case-insensitive and substring-based', () => {
    expect(apply1mContextOptIn('Claude-Sonnet-4-6', 'SONNET')).toBe(
      'Claude-Sonnet-4-6[1m]',
    )
  })

  test('leaves non-matching and already-suffixed models untouched', () => {
    expect(apply1mContextOptIn('claude-haiku-4-5', 'sonnet')).toBe(
      'claude-haiku-4-5',
    )
    expect(apply1mContextOptIn('claude-sonnet-4-6[1m]', 'sonnet')).toBe(
      'claude-sonnet-4-6[1m]',
    )
  })

  test('empty or unset opt-in list is a no-op', () => {
    expect(apply1mContextOptIn('claude-sonnet-4-6', undefined)).toBe(
      'claude-sonnet-4-6',
    )
    expect(apply1mContextOptIn('claude-sonnet-4-6', ' , ')).toBe(
      'claude-sonnet-4-6',
    )
  })
})
