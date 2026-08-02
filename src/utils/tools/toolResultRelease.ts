/**
 * Structural stand-in for `Message`. Kept local rather than importing the
 * real union so this stays a leaf module — `types/message.ts` sits in a large
 * import cycle, and pulling it in here would add more.
 */
type MessageLike = { type: string }

/**
 * Releasing `toolUseResult` payloads from the API-bound view of the history.
 *
 * The next API call only needs `message.message.content` (the tool_result
 * blocks), never the raw `toolUseResult` object the tool produced. Left in
 * place, a single 400KB file read stays pinned in `mutableMessages` for the
 * rest of the session, so the query loop strips it before every request.
 *
 * The strip must not mutate: `messagesForQuery` elements are references
 * shared with `mutableMessages` (UI state), and deleting `toolUseResult` in
 * place strips it from the live message while React may still be rendering
 * it. The next query can start within milliseconds of tool_result creation
 * (the model immediately calls the next tool), before the UI commit lands —
 * `UserToolSuccessMessage` reads `message.toolUseResult` to delegate to
 * `tool.renderToolResultMessage`, so a mutation race makes tool-result rows
 * render blank. Hence a stripped *copy*, with the original left alone.
 *
 * The copy for a given message is pure and stable — the source messages are
 * append-only and never mutated in place — so it is worth building once per
 * message instead of once per message per turn. Without the cache the strip
 * is O(history) per turn and O(history^2) over a user turn that drives many
 * tool round-trips; see `scripts/bench-query-turn-pipeline.ts`.
 */
export type ToolResultReleaseCache = WeakMap<object, object>

/**
 * One cache per `queryLoop` invocation. Deliberately not module-level: the
 * cache is only useful within a single user turn (the iterations that share a
 * growing history), and a loop-local one cannot outlive the generator or leak
 * between sessions and tests. Keyed weakly so a cached copy dies with the
 * message it was derived from.
 */
export function createToolResultReleaseCache(): ToolResultReleaseCache {
  return new WeakMap()
}

function hasToolUseResult(msg: MessageLike): boolean {
  return (
    msg.type === 'user' &&
    'toolUseResult' in msg &&
    (msg as { toolUseResult?: unknown }).toolUseResult !== undefined
  )
}

/**
 * Returns `messages` with every `toolUseResult` payload dropped, without
 * touching the input messages. Messages that carry no payload are passed
 * through by reference; the rest are replaced by a cached stripped copy.
 *
 * Always returns a fresh array, matching the `.map()` this replaced —
 * downstream transformations (`applyToolResultBudget`, microcompact,
 * `normalizeMessagesForAPI`) build new arrays of their own, so they compose
 * either way, but keeping the array fresh keeps the change to the copies.
 */
export function releaseToolUseResults<T extends MessageLike>(
  messages: T[],
  cache: ToolResultReleaseCache,
): T[] {
  return messages.map(msg => {
    if (!hasToolUseResult(msg)) return msg
    const cached = cache.get(msg as object)
    if (cached) return cached as T
    const copy: T = { ...msg }
    delete (copy as T & { toolUseResult?: unknown }).toolUseResult
    cache.set(msg as object, copy as object)
    return copy
  })
}
