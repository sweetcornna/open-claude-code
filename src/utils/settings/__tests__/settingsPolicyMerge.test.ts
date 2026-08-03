import { describe, expect, test } from 'bun:test'
import { mergeSettingsWithPolicy } from '../settings'

describe('mergeSettingsWithPolicy', () => {
  test('preserves an empty managed model allowlist', () => {
    const merged = mergeSettingsWithPolicy(
      {
        availableModels: ['sonnet'],
        permissions: { allow: ['Bash'] },
      },
      {
        availableModels: [],
        permissions: { allow: ['Read'] },
      },
    )

    expect(merged.availableModels).toEqual([])
    expect(merged.permissions?.allow).toEqual(['Bash', 'Read'])
  })

  test('replaces lower-trust models with the managed allowlist', () => {
    const merged = mergeSettingsWithPolicy(
      { availableModels: ['sonnet', 'haiku'] },
      { availableModels: ['opus'] },
    )

    expect(merged.availableModels).toEqual(['opus'])
  })
})
