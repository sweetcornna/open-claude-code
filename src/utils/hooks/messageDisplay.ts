/**
 * MessageDisplay hook application (official 2.1.228 parity).
 *
 * The contract is display-only: a hook may swap the text that reaches the
 * consumer's screen, but the stored transcript and the model-visible history
 * must not move. That is why this returns a **clone** — the caller has already
 * pushed the original into `mutableMessages` / the transcript by the time we
 * run, and mutating in place would rewrite what the model sees next turn.
 *
 * Failure is always "show the original": a throwing, timing-out or non-zero
 * exiting hook never blanks a message.
 */

import { randomUUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../telemetry/debug.js'
import { hasHookForEvent } from './config.js'
import { executeMessageDisplayHooks } from './lifecycleHooks.js'

/**
 * Run MessageDisplay hooks for a completed assistant message.
 *
 * Fires once per message with `index: 0` and `final: true` — occ has no
 * line-batched streaming display seam outside React, and the per-flush shape
 * is preserved in the payload so a streaming caller can be added later without
 * changing the hook contract.
 *
 * @param message The assistant message about to be emitted
 * @param turnId Stable id for the current turn
 * @returns The message to display: the original, or a clone with replaced text
 */
export async function applyMessageDisplayHooks<T extends Message>(
  message: T,
  turnId: string,
  options: { getAppState?: () => AppState; signal?: AbortSignal } = {},
): Promise<T> {
  if (
    !hasHookForEvent('MessageDisplay', options.getAppState?.(), getSessionId())
  ) {
    return message
  }

  const content = message.message?.content
  if (!Array.isArray(content)) {
    return message
  }

  const delta = content
    .map(block =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('')
  if (delta === '') {
    return message
  }

  let displayContent: string | undefined
  try {
    for await (const result of executeMessageDisplayHooks(
      {
        turnId,
        messageId: randomUUID(),
        index: 0,
        final: true,
        delta,
      },
      options.signal,
    )) {
      // Last hook to answer wins, matching upstream.
      if (result.displayContent !== undefined) {
        displayContent = result.displayContent
      }
    }
  } catch (e) {
    logForDebugging(
      `MessageDisplay hook failed for completed message; emitting original text: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { level: 'error' },
    )
    return message
  }

  if (displayContent === undefined) {
    return message
  }

  // The hook replaces the message's text as a whole, so the replacement lands
  // in the first text block and any further text blocks are emptied.
  let isFirstTextBlock = true
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map(block => {
        if (
          typeof block !== 'object' ||
          block === null ||
          !('type' in block) ||
          block.type !== 'text'
        ) {
          return block
        }
        const text = isFirstTextBlock ? displayContent : ''
        isFirstTextBlock = false
        return { ...block, text }
      }),
    },
  } as T
}
