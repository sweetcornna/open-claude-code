import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import type { ToolUseContext } from '../../../Tool.js'
import { getUltracodeModeAttachments } from '../modes.js'

function ctx(ultracodeMode: boolean | undefined): ToolUseContext {
  return {
    getAppState: () => ({ ultracodeMode }),
  } as unknown as ToolUseContext
}

function humanTurn(): Message {
  return {
    type: 'user',
    message: { role: 'user', content: 'do the thing' },
  } as unknown as Message
}

function ultracodeAttachment(): Message {
  return {
    type: 'attachment',
    attachment: { type: 'ultracode_mode' },
  } as unknown as Message
}

function toolResultTurn(): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  } as unknown as Message
}

describe('getUltracodeModeAttachments', () => {
  test('off → no attachment', async () => {
    expect(
      await getUltracodeModeAttachments([humanTurn()], ctx(false)),
    ).toEqual([])
    expect(
      await getUltracodeModeAttachments([humanTurn()], ctx(undefined)),
    ).toEqual([])
  })

  test('on, first turn → attaches', async () => {
    const out = await getUltracodeModeAttachments([], ctx(true))
    expect(out).toEqual([{ type: 'ultracode_mode' }])
  })

  test('on, already reminded this human turn → throttled', async () => {
    // human turn → reminder sent → tool rounds follow (no new human turn)
    const messages = [humanTurn(), ultracodeAttachment(), toolResultTurn()]
    expect(await getUltracodeModeAttachments(messages, ctx(true))).toEqual([])
  })

  test('on, new human turn after last reminder → attaches again', async () => {
    const messages = [humanTurn(), ultracodeAttachment(), humanTurn()]
    expect(await getUltracodeModeAttachments(messages, ctx(true))).toEqual([
      { type: 'ultracode_mode' },
    ])
  })
})
