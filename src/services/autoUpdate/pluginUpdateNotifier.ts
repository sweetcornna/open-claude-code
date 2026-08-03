/**
 * Registry bridging the background plugin updater (a plain service module
 * with no React access) to the in-REPL notification queue.
 *
 * Parallel to updateNotifier.ts (the occ self-update channel) rather than
 * shared with it: the two notices render differently — occ updates show dim
 * and uncolored, plugin updates show green (color: 'success') — so each
 * channel keeps its own registration in Notifications.tsx. Buffering
 * semantics are identical: if the updater finishes before the REPL
 * registered a callback, the text is held and flushed on registration.
 */

type PluginUpdateNotifier = (text: string) => void

let notifier: PluginUpdateNotifier | null = null
let pendingText: string | null = null

export function setPluginUpdateNotifier(cb: PluginUpdateNotifier | null): void {
  notifier = cb
  if (cb && pendingText !== null) {
    const text = pendingText
    pendingText = null
    cb(text)
  }
}

export function emitPluginUpdateNotification(text: string): void {
  if (notifier) {
    notifier(text)
    return
  }
  pendingText = text
}

export function resetPluginUpdateNotifierForTests(): void {
  notifier = null
  pendingText = null
}
