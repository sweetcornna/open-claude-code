import { describe, expect, test } from 'bun:test'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { isUserAbort } from '../userAbort.js'

/**
 * Pressing Esc is a completed action, not a fault. Reporting it as
 * `API Error: <whatever wording aborted first>` puts a red failure line in the
 * transcript for something the user asked for — and that line stays in the
 * history the model reads back later.
 *
 * The third-party adapters had no abort check at all (one catch-all turned
 * every failure into an error message), and the first-party path matched only
 * `instanceof APIUserAbortError`, which misses a bare DOMException from undici
 * or an abort wrapped by an intermediate layer.
 */
describe('isUserAbort', () => {
  test('recognises the SDK abort error', () => {
    expect(isUserAbort(new APIUserAbortError())).toBe(true)
  })

  test('recognises a bare DOMException AbortError (undici)', () => {
    expect(
      isUserAbort(new DOMException('The operation was aborted', 'AbortError')),
    ).toBe(true)
  })

  test('recognises any Error named AbortError', () => {
    const err = Object.assign(new Error('user cancelled'), {
      name: 'AbortError',
    })
    expect(isUserAbort(err)).toBe(true)
  })

  test('an aborted signal makes any error an abort', () => {
    // Wrapper layers do not preserve name === 'AbortError' reliably; if the
    // caller's signal is aborted, whatever surfaced is downstream of that.
    const controller = new AbortController()
    controller.abort('interrupt')
    expect(isUserAbort(new Error('terminated'), controller.signal)).toBe(true)
    expect(isUserAbort(new TypeError('fetch failed'), controller.signal)).toBe(
      true,
    )
  })

  test('a genuine network failure on a live signal is NOT an abort', () => {
    // The discrimination that matters: real failures must still be reported
    // and retried, not silently swallowed as a cancellation.
    const live = new AbortController().signal
    expect(isUserAbort(new Error('terminated'), live)).toBe(false)
    expect(isUserAbort(new TypeError('fetch failed'), live)).toBe(false)
    expect(isUserAbort(new Error('terminated'))).toBe(false)
  })

  test('non-error values are not aborts', () => {
    expect(isUserAbort(undefined)).toBe(false)
    expect(isUserAbort(null)).toBe(false)
    expect(isUserAbort('aborted')).toBe(false)
  })
})
