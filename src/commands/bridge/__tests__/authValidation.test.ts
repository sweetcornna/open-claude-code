import { describe, expect, test } from 'bun:test'
import {
  isValidRemoteControlPassword,
  isValidRemoteControlUsername,
  normalizeRemoteControlUsername,
  REMOTE_CONTROL_PASSWORD_ERROR,
  REMOTE_CONTROL_USERNAME_ERROR,
} from '../authValidation.js'

describe('Remote Control account username rules', () => {
  test('normalizes before validating, as the dialog does', () => {
    expect(normalizeRemoteControlUsername('  Alice  ')).toBe('alice')
    expect(
      isValidRemoteControlUsername(normalizeRemoteControlUsername('ALICE')),
    ).toBe(true)
    // The raw value would fail; only the normalized form is ever submitted.
    expect(isValidRemoteControlUsername('ALICE')).toBe(false)
  })

  test('accepts the documented character set', () => {
    for (const value of ['abc', 'a1_b.c-d', '0user', 'a'.repeat(32)]) {
      expect(isValidRemoteControlUsername(value)).toBe(true)
    }
  })

  test('rejects out-of-range lengths and leading punctuation', () => {
    for (const value of [
      '',
      'ab',
      'a'.repeat(33),
      '_abc',
      '.abc',
      '-abc',
      'a b',
      'a@b',
      'üser',
    ]) {
      expect(isValidRemoteControlUsername(value)).toBe(false)
    }
  })
})

describe('Remote Control account password rules', () => {
  test('enforces the 12–128 character window at both edges', () => {
    expect(isValidRemoteControlPassword('a'.repeat(11))).toBe(false)
    expect(isValidRemoteControlPassword('a'.repeat(12))).toBe(true)
    expect(isValidRemoteControlPassword('a'.repeat(128))).toBe(true)
    expect(isValidRemoteControlPassword('a'.repeat(129))).toBe(false)
    expect(isValidRemoteControlPassword('')).toBe(false)
  })
})

describe('validation messages', () => {
  test('state the rule without echoing the rejected value', () => {
    expect(REMOTE_CONTROL_USERNAME_ERROR).toContain('3–32')
    expect(REMOTE_CONTROL_PASSWORD_ERROR).toContain('12 and 128')
  })
})
