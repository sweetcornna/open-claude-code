/**
 * `extractReadFilesFromMessages` reseeds readFileState from the transcript on
 * resume. Whether an entry is marked `isPartialView` decides whether Edit and
 * Write will touch the file without a fresh Read (both refuse on a partial
 * view — see FileEditTool.ts / FileWriteTool.ts).
 *
 * The failure this pins: a Read that the token cap cut to page 1 is marked
 * partial in-session, but the marking used to be dropped on the way back in,
 * so a resumed session would happily edit a file it had only seen the first
 * page of. The narrowness matters as much as the fix — ordinary reads must
 * keep coming back editable, or every resume-then-edit breaks.
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { extractReadFilesFromMessages } from '../queryHelpers.js'

const CWD = '/repo'
const FILE = '/repo/big.ts'
const TOOL_USE_ID = 'toolu_read_1'
const TIMESTAMP = '2026-08-13T00:00:00.000Z'

function readToolUse(input: Record<string, unknown> = {}): Message {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    timestamp: TIMESTAMP,
    message: {
      id: 'msg_1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'Read',
          input: { file_path: FILE, ...input },
        },
      ],
    },
  } as unknown as Message
}

function readToolResult(
  options: { truncated?: boolean; content?: string } = {},
): Message {
  const { truncated = false, content = '     1\tconst a = 1\n' } = options
  return {
    type: 'user',
    uuid: 'user-1',
    timestamp: TIMESTAMP,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content }],
    },
    ...(truncated
      ? {
          toolUseResult: {
            type: 'text',
            file: {
              filePath: FILE,
              content,
              numLines: 120,
              startLine: 1,
              totalLines: 900,
              truncatedByTokenCap: true,
            },
          },
        }
      : {}),
  } as unknown as Message
}

function noticeAttachment(): Message {
  return {
    type: 'attachment',
    uuid: 'attachment-1',
    timestamp: TIMESTAMP,
    attachment: {
      type: 'read_truncation_notice',
      banner: '[Truncated: PARTIAL view — /repo/big.ts: page 1]',
      toolUseID: TOOL_USE_ID,
    },
  } as unknown as Message
}

describe('extractReadFilesFromMessages isPartialView', () => {
  test('an ordinary whole-file Read comes back editable', () => {
    const cache = extractReadFilesFromMessages(
      [readToolUse(), readToolResult()],
      CWD,
    )

    expect(cache.get(FILE)?.content).toContain('const a = 1')
    expect(cache.get(FILE)?.isPartialView).toBeUndefined()
  })

  test('the durable truncatedByTokenCap flag marks the entry partial', () => {
    // The resume case: attachments are gone from the transcript, only
    // toolUseResult survives.
    const cache = extractReadFilesFromMessages(
      [readToolUse(), readToolResult({ truncated: true })],
      CWD,
    )

    expect(cache.get(FILE)?.isPartialView).toBe(true)
  })

  test('a live read_truncation_notice attachment marks the entry partial', () => {
    const cache = extractReadFilesFromMessages(
      [readToolUse(), readToolResult(), noticeAttachment()],
      CWD,
    )

    expect(cache.get(FILE)?.isPartialView).toBe(true)
  })

  test('a banner reconstructed onto the tool_result marks the entry partial', () => {
    const cache = extractReadFilesFromMessages(
      [
        readToolUse(),
        readToolResult({
          content:
            '<system-reminder>[Truncated: PARTIAL view — /repo/big.ts: showing 120 of 900 lines.]</system-reminder>\n     1\tconst a = 1\n',
        }),
      ],
      CWD,
    )

    expect(cache.get(FILE)?.isPartialView).toBe(true)
  })

  test('ranged reads are still not cached at all', () => {
    // Unchanged behaviour, restated here because the partial-view logic sits
    // right next to the offset/limit filter and must not have widened it.
    const cache = extractReadFilesFromMessages(
      [readToolUse({ offset: 10, limit: 20 }), readToolResult()],
      CWD,
    )

    expect(cache.get(FILE)).toBeUndefined()
  })
})
