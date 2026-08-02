import { afterEach, describe, expect, test } from 'bun:test'
import {
  createHyperlink,
  OSC8_START,
  terminalSupportsHyperlinks,
} from '../hyperlink.js'

describe('terminalSupportsHyperlinks (FORCE_HYPERLINK env)', () => {
  const savedEnv = process.env.FORCE_HYPERLINK

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FORCE_HYPERLINK
    else process.env.FORCE_HYPERLINK = savedEnv
  })

  test('FORCE_HYPERLINK=0 disables hyperlinks regardless of terminal', () => {
    process.env.FORCE_HYPERLINK = '0'
    expect(terminalSupportsHyperlinks()).toBe(false)
    expect(createHyperlink('https://example.com', 'text')).toBe(
      'https://example.com',
    )
  })

  test('FORCE_HYPERLINK=false disables hyperlinks', () => {
    process.env.FORCE_HYPERLINK = 'false'
    expect(terminalSupportsHyperlinks()).toBe(false)
  })

  test('FORCE_HYPERLINK=1 forces hyperlinks on', () => {
    process.env.FORCE_HYPERLINK = '1'
    expect(terminalSupportsHyperlinks()).toBe(true)
    expect(createHyperlink('https://example.com', 'text')).toContain(OSC8_START)
  })

  test('unset/empty falls through to terminal detection', () => {
    delete process.env.FORCE_HYPERLINK
    expect(typeof terminalSupportsHyperlinks()).toBe('boolean')
    process.env.FORCE_HYPERLINK = '  '
    expect(typeof terminalSupportsHyperlinks()).toBe('boolean')
  })
})
