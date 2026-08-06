import { describe, expect, test } from 'bun:test'
import { avoidReservedName } from '../reservedNames.js'

describe('avoidReservedName', () => {
  test.each([
    'con',
    'prn',
    'aux',
    'nul',
    'com1',
    'com9',
    'lpt1',
    'lpt9',
  ])('escapes the device name %s', name => {
    expect(avoidReservedName(name)).toBe(`_${name}`)
  })

  test('matches case-insensitively', () => {
    expect(avoidReservedName('NUL')).toBe('_NUL')
    expect(avoidReservedName('Com1')).toBe('_Com1')
  })

  test('escapes device names carrying an extension', () => {
    // `nul.txt` addresses the null device too — the extension does not help.
    expect(avoidReservedName('nul.txt')).toBe('_nul.txt')
  })

  test('leaves ordinary names alone', () => {
    for (const name of ['context7', 'console', 'nullable', 'com', 'lpt', 'a']) {
      expect(avoidReservedName(name)).toBe(name)
    }
  })

  test('strips a trailing dot or space, which Windows rejects', () => {
    expect(avoidReservedName('plugin.')).toBe('plugin')
    expect(avoidReservedName('plugin ')).toBe('plugin')
    expect(avoidReservedName('plugin. .')).toBe('plugin')
  })

  test('keeps interior dots and spaces', () => {
    expect(avoidReservedName('my.plugin')).toBe('my.plugin')
  })
})
