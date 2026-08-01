import { describe, expect, test } from 'bun:test'
import { isBuiltinComputerUseBackend } from '../backend.js'

describe('isBuiltinComputerUseBackend', () => {
  test('defaults to the builtin backend when unset', () => {
    expect(isBuiltinComputerUseBackend({})).toBe(true)
  })

  test('uses the builtin backend when explicitly selected', () => {
    expect(
      isBuiltinComputerUseBackend({
        computerUse: { backend: 'builtin' },
      }),
    ).toBe(true)
  })

  test('disables builtin wiring for an external backend', () => {
    expect(
      isBuiltinComputerUseBackend({
        computerUse: { backend: 'external' },
      }),
    ).toBe(false)
  })
})
