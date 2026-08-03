import { describe, expect, test } from 'bun:test'
import { sanitizeBrowserUrlForDisplay } from '../Doctor.js'

describe('sanitizeBrowserUrlForDisplay', () => {
  test('removes credentials, query, and fragment while retaining the endpoint path', () => {
    const displayed = sanitizeBrowserUrlForDisplay(
      'https://user:password@browser.example.com:9222/devtools/browser/id?token=secret#fragment',
    )

    expect(displayed).toBe(
      'https://browser.example.com:9222/devtools/browser/id',
    )
    expect(displayed).not.toContain('user')
    expect(displayed).not.toContain('password')
    expect(displayed).not.toContain('secret')
  })

  test('does not echo malformed input', () => {
    const raw = 'not a URL?token=secret'
    const displayed = sanitizeBrowserUrlForDisplay(raw)

    expect(displayed).toBe('[invalid URL]')
    expect(displayed).not.toContain(raw)
  })
})
