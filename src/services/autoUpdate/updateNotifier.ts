/**
 * Registry bridging the background self-updater (a plain service module with
 * no React access) to the in-REPL notification queue.
 *
 * Same pattern as setEnvHookNotifier (src/utils/hooks/fileChangedWatcher.ts):
 * the Notifications component registers a callback on mount and the service
 * calls it. If the updater finishes before the REPL registered a callback,
 * the text is buffered and flushed on registration so the notice is not lost.
 */

type BackgroundUpdateNotifier = (text: string) => void

let notifier: BackgroundUpdateNotifier | null = null
let pendingText: string | null = null

export function setBackgroundUpdateNotifier(
  cb: BackgroundUpdateNotifier | null,
): void {
  notifier = cb
  if (cb && pendingText !== null) {
    const text = pendingText
    pendingText = null
    cb(text)
  }
}

export function emitBackgroundUpdateNotification(text: string): void {
  if (notifier) {
    notifier(text)
    return
  }
  pendingText = text
}

export function resetBackgroundUpdateNotifierForTests(): void {
  notifier = null
  pendingText = null
}
