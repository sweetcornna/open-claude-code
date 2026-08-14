/**
 * The banner for an auto-paginated Read rides its own attachment rather than
 * being spliced into the tool_result. Two things must hold for that to work:
 * it has to render as a system-reminder (so the model cannot mistake it for
 * file content), and it must not draw a second visible row in the transcript
 * next to the Read result that already says how many lines came back.
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

const BANNER =
  '[Truncated: PARTIAL view — /tmp/big.ts: showing lines 1-120 of 900 total (31000 tokens, cap 25000). Call Read with offset=121 limit=120 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]'

describe('read_truncation_notice attachment', () => {
  test('reaches the model wrapped in a system-reminder', () => {
    const messages = normalizeAttachmentForAPI({
      type: 'read_truncation_notice',
      banner: BANNER,
      toolUseID: 'toolu_1',
    } as never)

    expect(messages).toHaveLength(1)
    const content = messages[0]!.message.content
    const text = typeof content === 'string' ? content : ''
    expect(text).toContain('<system-reminder>')
    expect(text).toContain(BANNER)
    expect(messages[0]!.isMeta).toBe(true)
  })

  test('renders nothing in the transcript', () => {
    expect(
      isNullRenderingAttachment({
        type: 'attachment',
        uuid: 'a1',
        attachment: {
          type: 'read_truncation_notice',
          banner: BANNER,
          toolUseID: 'toolu_1',
        },
      } as never),
    ).toBe(true)
  })
})
