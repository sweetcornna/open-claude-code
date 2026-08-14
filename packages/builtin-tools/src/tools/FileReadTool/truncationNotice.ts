/**
 * Side-channel for the banner attached to a Read result that the token cap
 * forced into a partial first page, keyed by the result `data` object's
 * identity.
 *
 * Two reasons this is a module of its own rather than a field or a helper on
 * FileReadTool.ts:
 *
 *  - It is NOT part of the output schema. Schema fields flow into SDK types
 *    and are reconstructed on resume; this is one-shot render-time text. The
 *    durable half of the same signal is `file.truncatedByTokenCap`.
 *  - The consumer is the host tool dispatcher, and FileReadTool.ts pulls in
 *    most of the filesystem/image/PDF stack. Keeping the map in a zero-import
 *    leaf lets the dispatcher read it without taking that edge.
 *
 * WeakMap so the entry disappears with the result object it describes.
 */
const readTruncationNotices = new WeakMap<object, string>()

export function setReadTruncationNotice(data: object, banner: string): void {
  readTruncationNotices.set(data, banner)
}

/**
 * The "you only saw page 1, here is how to ask for page 2" banner for this
 * Read result, or undefined when the read was complete.
 */
export function getReadTruncationNotice(data: object): string | undefined {
  return readTruncationNotices.get(data)
}
