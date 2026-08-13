import { describe, expect, test } from 'bun:test'
import { sanitizeNotificationText } from '../../hooks/useTerminalNotification.js'

describe('sanitizeNotificationText', () => {
  test('replaces every C0, DEL, and C1 control with a space', () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ]
    const input = controls
      .map(code => `a${String.fromCharCode(code)}b`)
      .join('')

    expect(sanitizeNotificationText(input)).toBe(
      controls.map(() => 'a b').join(''),
    )
  })

  test('preserves normal Unicode and printable punctuation', () => {
    const input = 'Claude 完成了 — café 😀; title: body'
    expect(sanitizeNotificationText(input)).toBe(input)
  })

  test('flattens line breaks and strips escape-sequence delimiters', () => {
    expect(
      sanitizeNotificationText('title\r\nbody\u001b]9;injected\u0007next'),
    ).toBe('title  body ]9;injected next')
  })
})
