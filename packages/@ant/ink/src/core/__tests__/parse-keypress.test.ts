import { describe, expect, test } from 'bun:test'
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedInput,
  type ParsedKey,
  parseMultipleKeypresses,
} from '../parse-keypress.js'

function isKey(input: ParsedInput): input is ParsedKey {
  return input.kind === 'key'
}

function parseOne(input: string): ParsedKey {
  const state: KeyParseState = { ...INITIAL_STATE }
  const [keys] = parseMultipleKeypresses(state, input)

  expect(keys).toHaveLength(1)
  const key = keys[0]!
  expect(isKey(key)).toBe(true)

  return key as ParsedKey
}

describe('parseMultipleKeypresses ctrl+space', () => {
  test('parses a bare NUL byte as ctrl+space', () => {
    const key = parseOne('\x00')

    expect(key.name).toBe('space')
    expect(key.ctrl).toBe(true)
    expect(key.meta).toBe(false)
    expect(key.shift).toBe(false)
  })

  test('agrees with the kitty CSI-u encoding of ctrl+space', () => {
    const legacy = parseOne('\x00')
    const kitty = parseOne('\x1b[32;5u')

    expect(kitty.name).toBe('space')
    expect(kitty.ctrl).toBe(true)
    expect(kitty.name).toBe(legacy.name)
    expect(kitty.ctrl).toBe(legacy.ctrl)
  })
})

describe('parseMultipleKeypresses control characters', () => {
  test('still parses SOH as ctrl+a', () => {
    const key = parseOne('\x01')

    expect(key.name).toBe('a')
    expect(key.ctrl).toBe(true)
  })

  test('still parses SUB as ctrl+z', () => {
    const key = parseOne('\x1a')

    expect(key.name).toBe('z')
    expect(key.ctrl).toBe(true)
  })

  test('still parses US as ctrl+underscore', () => {
    const key = parseOne('\x1f')

    expect(key.name).toBe('_')
    expect(key.ctrl).toBe(true)
  })

  test('still parses a plain space without ctrl', () => {
    const key = parseOne(' ')

    expect(key.name).toBe('space')
    expect(key.ctrl).toBe(false)
  })
})
