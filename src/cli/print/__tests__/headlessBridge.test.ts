import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import type { ReplBridgeHandle } from 'src/bridge/replBridge.js'
import {
  forwardMessagesToBridge,
  teardownHeadlessBridge,
} from '../headlessBridge.js'
import type { HeadlessRunState } from '../headlessRunState.js'

function message(type: Message['type'], uuid: string): Message {
  return { type, uuid } as unknown as Message
}

describe('headless Remote Control bridge', () => {
  test('forwards only new user and assistant messages', () => {
    const writes: Message[][] = []
    const mutableMessages = [
      message('user', 'old'),
      message('progress', 'progress'),
      message('assistant', 'assistant'),
      message('user', 'user'),
    ]
    const state = {
      mutableMessages,
      bridgeLastForwardedIndex: 1,
      bridgeHandle: {
        writeMessages: (messages: Message[]) => writes.push(messages),
      } as unknown as ReplBridgeHandle,
    } as HeadlessRunState

    forwardMessagesToBridge(state)

    expect(writes).toEqual([[mutableMessages[2], mutableMessages[3]]])
    expect(state.bridgeLastForwardedIndex).toBe(mutableMessages.length)

    forwardMessagesToBridge(state)
    expect(writes).toHaveLength(1)
  })

  test('clears permission relays before tearing down', async () => {
    const callbacks: Array<'sent' | 'resolved'> = []
    let teardownCount = 0
    const state = {
      structuredIO: {
        setOnControlRequestSent: (callback: unknown) => {
          if (callback === undefined) callbacks.push('sent')
        },
        setOnControlRequestResolved: (callback: unknown) => {
          if (callback === undefined) callbacks.push('resolved')
        },
      },
      bridgeHandle: {
        teardown: async () => {
          teardownCount++
        },
      } as unknown as ReplBridgeHandle,
      bridgeLastForwardedIndex: 8,
    } as unknown as HeadlessRunState

    await teardownHeadlessBridge(state)

    expect(callbacks).toEqual(['sent', 'resolved'])
    expect(teardownCount).toBe(1)
    expect(state.bridgeHandle).toBeNull()
    expect(state.bridgeLastForwardedIndex).toBe(0)
  })
})
