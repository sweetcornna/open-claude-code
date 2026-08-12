import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getRegisteredHooks,
  getSessionTrustAccepted,
  registerHookCallbacks,
  setSessionTrustAccepted,
} from '../../../bootstrap/state.js'
import { resetTrustDialogAcceptedCacheForTesting } from '../../config/config.js'
import type {
  HookInput,
  HookJSONOutput,
} from '../../../entrypoints/agentSdkTypes.js'
import type { Message } from '../../../types/message.js'
import { applyMessageDisplayHooks } from '../messageDisplay.js'

// See userPromptExpansionHooks.test.ts for why this file injects hooks through
// the SDK callback registry instead of mock.module, and for the full writeup of
// the trust-gate setup below.

const TURN_ID = '11111111-1111-4111-8111-111111111111'

function assistantMessage(...texts: string[]): Message {
  return {
    type: 'assistant',
    uuid: '22222222-2222-4222-8222-222222222222',
    message: {
      role: 'assistant',
      id: 'msg_test',
      content: texts.map(text => ({ type: 'text', text })),
    },
  } as unknown as Message
}

function textOf(message: Message): string[] {
  const content = message.message?.content
  return Array.isArray(content)
    ? content.map(block =>
        typeof block === 'object' && block && 'text' in block
          ? String(block.text)
          : '',
      )
    : []
}

function registerCallback(
  callback: (input: HookInput) => HookJSONOutput,
): void {
  registerHookCallbacks({
    MessageDisplay: [
      {
        hooks: [{ type: 'callback', callback: async input => callback(input) }],
      },
    ],
  })
}

let previousTrust = false

beforeEach(() => {
  previousTrust = getSessionTrustAccepted()
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
})

afterEach(() => {
  // Restore both halves of the trust state: the session flag AND the latch
  // checkHasTrustDialogAccepted() sets on first true read. Leaving the latch
  // set would hand "workspace trusted" to every later file in the shard.
  setSessionTrustAccepted(previousTrust)
  resetTrustDialogAcceptedCacheForTesting()
  // Drop only this suite's event, not the whole registry: resetSdkInitState()
  // would also null initJsonSchema, which belongs to whoever set it.
  delete getRegisteredHooks()?.MessageDisplay
})

describe('applyMessageDisplayHooks', () => {
  test('returns the message untouched when no hook is configured', async () => {
    const message = assistantMessage('hello')
    expect(await applyMessageDisplayHooks(message, TURN_ID)).toBe(message)
  })

  test('sends the official payload shape', async () => {
    let seen: HookInput | undefined
    registerCallback(input => {
      seen = input
      return {}
    })

    await applyMessageDisplayHooks(assistantMessage('one', 'two'), TURN_ID)

    expect(seen).toMatchObject({
      hook_event_name: 'MessageDisplay',
      turn_id: TURN_ID,
      index: 0,
      final: true,
      delta: 'onetwo',
    })
    // message_id is a per-message UUID, not the API msg_… id.
    expect((seen as { message_id: string }).message_id).not.toBe('msg_test')
  })

  test('displayContent replaces the displayed text without touching the original', async () => {
    registerCallback(() => ({
      hookSpecificOutput: {
        hookEventName: 'MessageDisplay',
        displayContent: '[redacted]',
      },
    }))

    const original = assistantMessage('secret', 'more secret')
    const displayed = await applyMessageDisplayHooks(original, TURN_ID)

    expect(displayed).not.toBe(original)
    expect(textOf(displayed)).toEqual(['[redacted]', ''])
    // Display-only: the stored message (and therefore what the model sees on
    // the next turn) is byte-identical to what the API produced.
    expect(textOf(original)).toEqual(['secret', 'more secret'])
  })

  test('a failing hook falls back to the original delta', async () => {
    registerCallback(() => {
      throw new Error('boom')
    })

    const original = assistantMessage('untouched')
    const displayed = await applyMessageDisplayHooks(original, TURN_ID)
    expect(textOf(displayed)).toEqual(['untouched'])
  })

  test('messages without text content skip the hook entirely', async () => {
    let called = false
    registerCallback(() => {
      called = true
      return {}
    })

    const toolOnly = {
      type: 'assistant',
      uuid: '33333333-3333-4333-8333-333333333333',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }],
      },
    } as unknown as Message

    expect(await applyMessageDisplayHooks(toolOnly, TURN_ID)).toBe(toolOnly)
    expect(called).toBe(false)
  })
})
