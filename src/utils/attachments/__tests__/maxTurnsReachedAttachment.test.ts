/**
 * `max_turns_reached` is the one attachment that means "the harness ended the
 * turn", not "here is a reminder for the model". That gives it the opposite
 * pairing from every other bookkeeping attachment: it must be visible in the
 * transcript (otherwise a truncated run is indistinguishable from a finished
 * one) and invisible to the model (the turn is already over — see the explicit
 * case in attachmentNormalize.ts, official parity).
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { normalizeAttachmentForAPI } = await import(
  '../../messages/attachmentNormalize.js'
)
const { isNullRenderingAttachment } = await import(
  '../../../components/messages/nullRenderingAttachments.js'
)

const ATTACHMENT = {
  type: 'max_turns_reached',
  maxTurns: 12,
  turnCount: 13,
} as const

describe('max_turns_reached attachment', () => {
  test('is rendered in the transcript so the stop has a stated reason', () => {
    expect(
      isNullRenderingAttachment({
        type: 'attachment',
        uuid: 'a1',
        attachment: ATTACHMENT,
      } as never),
    ).toBe(false)
  })

  test('contributes nothing to the model-facing conversation', () => {
    expect(normalizeAttachmentForAPI(ATTACHMENT as never)).toEqual([])
  })
})
