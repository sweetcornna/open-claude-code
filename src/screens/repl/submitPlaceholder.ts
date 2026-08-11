/**
 * Visibility rule for the "submitted prompt" placeholder that REPL renders
 * directly under <Messages> while a turn is being prepared.
 *
 * The placeholder is a second, independent drawing of the same text the user
 * just sent (`UserTextMessage`, identical `❯ …` chrome). It exists to bridge
 * two gaps: before `setMessages` has appended the real user message, and
 * while the deferred array <Messages> renders is still behind. It must
 * therefore disappear the instant the real message is on screen — otherwise
 * the user sees their one message twice.
 *
 * WHY THE LENGTH COMPARISON IS NOT ENOUGH
 *
 * The original rule was `displayedMessages.length <= baselineLength`, where
 * the baseline is `messages.length` captured at submit time. That holds only
 * while the displayed array and the baseline are counted in the same space.
 * They are not: when the REPL renders `deferredMessages` it renders a capped
 * *tail* (`DEFERRED_CAP`), whose length saturates and stops tracking
 * `messages.length`. In a session past the cap the baseline is already
 * larger than the cap, so `displayedLength <= baseline` is permanently true
 * and the placeholder never hides — the prompt renders twice for the whole
 * turn, every turn.
 *
 * That path is not exotic: `usesSyncMessages` is false whenever streaming
 * text is suppressed while loading, which is the default on Windows and
 * Windows Terminal (`hasCursorUpViewportYankBug`) and for anyone with
 * `prefersReducedMotion`.
 *
 * Once the array is capped the length carries no information, so fall back
 * to `userMessagePending`, the flag REPL maintains against the uncapped
 * array (flipped in the `setMessages` wrapper when a human turn lands).
 */

/**
 * Cap on the array handed to `useDeferredValue`, bounding the memory cost of
 * double-buffering the message list. Exported so the visibility rule below
 * and the REPL memo that applies it cannot drift apart.
 */
export const DEFERRED_MESSAGES_CAP = 500

export type SubmitPlaceholderInput = {
  /** A placeholder string is set (i.e. a prompt is being processed). */
  hasPlaceholder: boolean
  /** Viewing a subagent transcript — a different array entirely. */
  viewingAgent: boolean
  /** Length of the array <Messages> renders this frame. */
  displayedLength: number
  /** `messages.length` captured when the placeholder was set. */
  baselineLength: number
  /** True until the submitted user message lands in `messages`. */
  userMessagePending: boolean
  /** True when the displayed array is a capped tail of `messages`. */
  displayedIsCapped: boolean
}

export function shouldShowSubmitPlaceholder(
  input: SubmitPlaceholderInput,
): boolean {
  if (!input.hasPlaceholder) return false
  // onAgentSubmit does not use the placeholder, and displayedMessages is the
  // agent's own array there, so neither input below means anything.
  if (input.viewingAgent) return false
  if (input.displayedIsCapped) return input.userMessagePending
  return input.displayedLength <= input.baselineLength
}
