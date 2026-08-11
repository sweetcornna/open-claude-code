import { describe, expect, test } from 'bun:test'
import {
  DEFERRED_MESSAGES_CAP,
  shouldShowSubmitPlaceholder,
  type SubmitPlaceholderInput,
} from '../submitPlaceholder.js'

const base: SubmitPlaceholderInput = {
  hasPlaceholder: true,
  viewingAgent: false,
  displayedLength: 1,
  baselineLength: 1,
  userMessagePending: true,
  displayedIsCapped: false,
}

describe('shouldShowSubmitPlaceholder', () => {
  test('hidden when nothing was submitted', () => {
    expect(
      shouldShowSubmitPlaceholder({ ...base, hasPlaceholder: false }),
    ).toBe(false)
  })

  test('hidden while viewing a subagent transcript', () => {
    expect(shouldShowSubmitPlaceholder({ ...base, viewingAgent: true })).toBe(
      false,
    )
  })

  test('shown in the gap before the real user message is appended', () => {
    expect(shouldShowSubmitPlaceholder(base)).toBe(true)
  })

  test('hidden once the displayed array grows past the baseline', () => {
    // onQuery appended [user, attachment, attachment] onto a 1-message array.
    expect(
      shouldShowSubmitPlaceholder({
        ...base,
        displayedLength: 4,
        userMessagePending: false,
      }),
    ).toBe(false)
  })

  test('shown while the deferred array still lags behind messages', () => {
    expect(
      shouldShowSubmitPlaceholder({
        ...base,
        displayedLength: 1,
        baselineLength: 1,
        userMessagePending: false,
      }),
    ).toBe(true)
  })

  // Regression: the displayed array is a capped tail past DEFERRED_MESSAGES_CAP,
  // so its length saturates while the baseline (messages.length at submit
  // time) keeps growing. `displayedLength <= baselineLength` is then
  // permanently true and the placeholder sits next to the real user
  // message for the whole turn — the prompt drawn twice, every turn, on
  // every Windows/Windows-Terminal or reduced-motion session long enough
  // to reach the cap.
  test('hidden in a capped session once the user message has landed', () => {
    expect(
      shouldShowSubmitPlaceholder({
        ...base,
        displayedIsCapped: true,
        displayedLength: DEFERRED_MESSAGES_CAP,
        baselineLength: 900,
        userMessagePending: false,
      }),
    ).toBe(false)
  })

  test('still bridges the gap in a capped session before it lands', () => {
    expect(
      shouldShowSubmitPlaceholder({
        ...base,
        displayedIsCapped: true,
        displayedLength: DEFERRED_MESSAGES_CAP,
        baselineLength: 900,
        userMessagePending: true,
      }),
    ).toBe(true)
  })
})
