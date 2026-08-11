/**
 * The one OpenCode failure occ explains in its own words.
 *
 * No mocks — the module is pure and reads nothing. The bodies below are the
 * live console's (2026-08-11): `claude-haiku-4-5` answers 403
 * `managed_inference_model_disabled` on an account whose `/api/config` lists
 * that same model as `status: "active"`, while `big-pickle` answers 200 on the
 * same account and endpoint.
 */

import { describe, expect, test } from 'bun:test'
import {
  describeOpencodeModelDisabled,
  isOpencodeModelDisabledError,
} from '../inferenceErrors.js'

/** Shape the OpenAI SDK hands a caller for a 403 with a JSON body. */
const sdkError = Object.assign(new Error('403 Model is disabled'), {
  status: 403,
  error: {
    type: 'managed_inference_model_disabled',
    message: 'Model is disabled for this organization',
  },
})

describe('isOpencodeModelDisabledError', () => {
  test('recognises the console’s own body', () => {
    expect(isOpencodeModelDisabledError(sdkError)).toBe(true)
  })

  test('recognises it after an adapter has stringified it', () => {
    // The chat lane hands over an object; an adapter that has already turned
    // the response into text hands over a sentence. A rule that only reads
    // `error.type` sees the first and misses the second.
    expect(
      isOpencodeModelDisabledError(
        new Error(
          'Chat request failed (403): {"type":"managed_inference_model_disabled"}',
        ),
      ),
    ).toBe(true)
  })

  test('leaves every other failure alone', () => {
    expect(
      isOpencodeModelDisabledError(
        Object.assign(new Error('401'), {
          status: 401,
          error: { type: 'AuthError', message: 'Invalid API key.' },
        }),
      ),
    ).toBe(false)
    expect(isOpencodeModelDisabledError(undefined)).toBe(false)
    expect(isOpencodeModelDisabledError('ECONNRESET')).toBe(false)
  })
})

describe('describeOpencodeModelDisabled', () => {
  test('names the model and says the credential is fine', () => {
    const message = describeOpencodeModelDisabled(sdkError, 'claude-haiku-4-5')
    expect(message).toContain('claude-haiku-4-5')
    // The whole point: a 403 reads as "your login is broken", and here it is
    // not — re-running /login changes nothing.
    expect(message).toContain('sign-in is fine')
    expect(message).toContain('/model')
  })

  test('is undefined for anything else, so the normal diagnostic stands', () => {
    expect(
      describeOpencodeModelDisabled(new Error('boom'), 'x'),
    ).toBeUndefined()
  })
})
