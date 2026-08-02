/**
 * The render-loop policy around the message lookups: reuse them, update them in
 * place, or rebuild them.
 *
 * `buildMessageLookups` allocates eight Maps/Sets and walks both arrays. On a
 * long session that is tens of milliseconds and a few MB of garbage per call,
 * and the REPL calls it whenever the conversation changes — which, in an
 * agentic loop, is every single message. This module is what keeps that from
 * happening: it decides, per render, the cheapest sound way to obtain lookups.
 *
 * It lives next to the lookups rather than inside Messages.tsx because the
 * decision is the interesting part and it is worth testing on its own. The
 * component keeps one `MessageLookupsCache` in a ref and hands it back each
 * render.
 */
import type { Message, NormalizedMessage } from '../../types/message.js'
import {
  buildMessageLookups,
  computeMessageStructureKey,
  type MessageLookups,
  updateMessageLookupsIncremental,
} from './lookups.js'

export type MessageLookupsCache = {
  /** Structural fingerprint of the arrays these lookups were derived from. */
  key: string
  lookups: MessageLookups
  normalizedCount: number
  messageCount: number
  normalizedBoundaryUuid: string | undefined
  messageBoundaryUuid: string | undefined
}

/**
 * How the lookups for a render were obtained. Callers do not need it; tests and
 * measurements do, because "did the fast path actually fire" is exactly the
 * property that silently regresses.
 */
export type MessageLookupsSource = 'cached' | 'incremental' | 'rebuild'

export type ResolvedMessageLookups = {
  lookups: MessageLookups
  /** Cache entry to keep for the next render. */
  cache: MessageLookupsCache
  source: MessageLookupsSource
}

/**
 * Identity of whatever sat at index `count - 1`.
 *
 * `length >= cachedLength` does not prove an array was only appended to. The
 * transcript cap slides a fixed-size window (append one, drop one — same
 * length, different contents), and the display filters can retroactively drop
 * an earlier message. In both cases the incremental updater, which reads
 * nothing before the cached count, would skip the new messages entirely and
 * quietly serve stale lookups. If the message that used to be last is still at
 * that index, the prefix survived and the tail really is new.
 */
function boundaryUuidAt(
  messages: readonly { readonly uuid?: string }[],
  count: number,
): string | undefined {
  return count > 0 ? messages[count - 1]?.uuid : undefined
}

function isAppendOnly(
  cache: MessageLookupsCache,
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): boolean {
  return (
    normalizedMessages.length >= cache.normalizedCount &&
    messages.length >= cache.messageCount &&
    boundaryUuidAt(normalizedMessages, cache.normalizedCount) ===
      cache.normalizedBoundaryUuid &&
    boundaryUuidAt(messages, cache.messageCount) === cache.messageBoundaryUuid
  )
}

/**
 * Obtain lookups for this render, reusing as much of `cache` as is sound.
 *
 * Three outcomes, cheapest first:
 *  - `cached`: nothing structural changed (a streaming text delta, a scroll),
 *    so the previous lookups still describe the conversation exactly.
 *  - `incremental`: messages were appended, so the previous lookups are
 *    updated in place. The updater still returns null when it cannot reproduce
 *    what a rebuild would decide (a replaced trailing progress tick, lookups it
 *    has no derivation state for), and then this falls through to a rebuild.
 *  - `rebuild`: everything else.
 *
 * Pass `null` on the first render.
 */
export function resolveMessageLookups(
  cache: MessageLookupsCache | null,
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): ResolvedMessageLookups {
  const key = computeMessageStructureKey(normalizedMessages, messages)

  if (cache && cache.key === key) {
    return { lookups: cache.lookups, cache, source: 'cached' }
  }

  let updated: MessageLookups | null = null
  if (cache && isAppendOnly(cache, normalizedMessages, messages)) {
    updated = updateMessageLookupsIncremental(
      cache.lookups,
      cache.normalizedCount,
      cache.messageCount,
      normalizedMessages,
      messages,
    )
  }

  const lookups = updated ?? buildMessageLookups(normalizedMessages, messages)

  return {
    lookups,
    cache: {
      key,
      lookups,
      normalizedCount: normalizedMessages.length,
      messageCount: messages.length,
      normalizedBoundaryUuid: boundaryUuidAt(
        normalizedMessages,
        normalizedMessages.length,
      ),
      messageBoundaryUuid: boundaryUuidAt(messages, messages.length),
    },
    source: updated ? 'incremental' : 'rebuild',
  }
}
