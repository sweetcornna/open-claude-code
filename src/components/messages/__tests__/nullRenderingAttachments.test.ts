import { describe, expect, test } from 'bun:test'

import { isNullRenderingAttachment } from '../nullRenderingAttachments.js'

function attachmentMessage(type: string): any {
  return { type: 'attachment', attachment: { type } }
}

describe('isNullRenderingAttachment', () => {
  // Regression: `max_turns_reached` is the harness ending the turn, not a
  // model-facing reminder. While it was in NULL_RENDERING_TYPES, Messages.tsx
  // filtered it out before rendering, so an interactive run truncated by the
  // turn limit looked exactly like one the model chose to finish — the user
  // got no explanation at all.
  test('max_turns_reached is user-visible', () => {
    expect(
      isNullRenderingAttachment(attachmentMessage('max_turns_reached')),
    ).toBe(false)
  })

  test.each([
    'todo_reminder',
    'task_reminder',
    'critical_system_reminder',
    'hook_success',
  ])('%s stays model-facing only', type => {
    expect(isNullRenderingAttachment(attachmentMessage(type))).toBe(true)
  })

  test('non-attachment messages are never treated as null-rendering', () => {
    expect(isNullRenderingAttachment({ type: 'assistant' } as any)).toBe(false)
  })
})
