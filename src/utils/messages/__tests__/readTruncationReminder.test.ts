/**
 * Resume must not silently hand the model a partial file.
 *
 * The live banner is a `read_truncation_notice` attachment, and attachments are
 * stripped from the persisted transcript for non-ant users. The tool_result and
 * its `toolUseResult.file.truncatedByTokenCap` flag survive, so after --resume
 * the model sees page 1 of a 900-line file with nothing marking it partial.
 * These tests pin the reconstruction that closes that gap, and — just as
 * important — the three cases where it must stay quiet.
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { collectMissingReadTruncationBanners } from '../readTruncationReminder.js'

const TOOL_USE_ID = 'toolu_read_1'

function toolResultMessage(
  overrides: {
    truncated?: boolean
    numLines?: number
    totalLines?: number
    extraText?: string
  } = {},
): Message {
  const {
    truncated = true,
    numLines = 120,
    totalLines = 900,
    extraText,
  } = overrides
  return {
    type: 'user',
    uuid: 'user-tool-result',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL_USE_ID,
          content: 'line 1\nline 2\n',
        },
        ...(extraText ? [{ type: 'text', text: extraText }] : []),
      ],
    },
    toolUseResult: {
      type: 'text',
      file: {
        filePath: '/tmp/big.ts',
        content: 'line 1\nline 2\n',
        numLines,
        startLine: 1,
        totalLines,
        ...(truncated ? { truncatedByTokenCap: true } : {}),
      },
    },
  } as unknown as Message
}

function noticeAttachment(): Message {
  return {
    type: 'attachment',
    uuid: 'attachment-1',
    attachment: {
      type: 'read_truncation_notice',
      banner: '[Truncated: PARTIAL view — /tmp/big.ts: live banner]',
      toolUseID: TOOL_USE_ID,
    },
  } as unknown as Message
}

describe('collectMissingReadTruncationBanners', () => {
  test('rebuilds the banner when the live attachment is gone', () => {
    const banners = collectMissingReadTruncationBanners([toolResultMessage()])

    expect(banners.size).toBe(1)
    const banner = banners.get('user-tool-result')!
    expect(banner).toContain('[Truncated: PARTIAL view — ')
    expect(banner).toContain('/tmp/big.ts')
    // Reconstructed from the durable numLines/totalLines, not replayed: the
    // original token counts and suggested offset were never persisted.
    expect(banner).toContain('showing 120 of 900 lines')
    expect(banner).toContain('Do NOT answer from this page alone')
  })

  test('stays quiet while the live attachment is still in the transcript', () => {
    const banners = collectMissingReadTruncationBanners([
      toolResultMessage(),
      noticeAttachment(),
    ])

    expect(banners.size).toBe(0)
  })

  test('stays quiet on a second pass over its own output', () => {
    // Idempotency: normalization output flows back through normalization on
    // the next request, with the reconstructed banner merged onto the same
    // message as the tool_result.
    const alreadyBannered = toolResultMessage({
      extraText:
        '<system-reminder>[Truncated: PARTIAL view — /tmp/big.ts: showing 120 of 900 lines.]</system-reminder>',
    })

    expect(collectMissingReadTruncationBanners([alreadyBannered]).size).toBe(0)
  })

  test('stays quiet for a Read that was not truncated', () => {
    expect(
      collectMissingReadTruncationBanners([
        toolResultMessage({ truncated: false }),
      ]).size,
    ).toBe(0)
  })

  test('falls back to the unpaginable wording when line counts are unusable', () => {
    // A char-sliced page (very long lines) reports numLines === totalLines, so
    // "showing N of M lines" would read as a complete file.
    const banners = collectMissingReadTruncationBanners([
      toolResultMessage({ numLines: 1, totalLines: 1 }),
    ])

    const banner = banners.get('user-tool-result')!
    expect(banner).toContain('cannot be paginated by line')
    expect(banner).not.toContain('showing 1 of 1 lines')
  })
})
