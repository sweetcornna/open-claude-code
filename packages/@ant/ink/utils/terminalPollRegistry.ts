/**
 * Registry of background pollers that write escape sequences to the terminal.
 *
 * Exists so shutdown can stop them synchronously without loading the modules
 * that own them, and without depending on React unmounting.
 *
 * The problem it solves: `systemThemeWatcher` re-queries the background colour
 * (OSC 11 + a DA1 sentinel) every 3s. Its only stop hook used to be a React
 * effect cleanup, which the normal exit path never reaches — gracefulShutdown
 * calls `inst.unmount()` only when the alt screen is active, and
 * `detachForShutdown()` deliberately does not unmount React. So on a plain
 * Ctrl+C the interval kept firing through the seconds shutdown spends running
 * cleanup hooks, and each reply arrived after stdin had been drained and put
 * back in cooked mode. Cooked mode buffers a reply with no newline forever, so
 * it was never delivered to this process — it stayed in the tty queue and the
 * shell inherited it, printing `^[]11;rgb:…` and `^[[?62;22;52c` at the next
 * prompt.
 *
 * Deliberately zero imports: the host imports this during shutdown, when
 * pulling in the querier and theme modules would be both pointless and slow.
 */

const stoppers = new Set<() => void>()

/** Register a poller's stop function. Returns an unregister thunk. */
export function registerTerminalPoll(stop: () => void): () => void {
  stoppers.add(stop)
  return () => stoppers.delete(stop)
}

/**
 * Stop every registered poller.
 *
 * Must run BEFORE stdin is drained and raw mode is dropped — anything written
 * after that point can no longer be read back by this process. Idempotent.
 */
export function stopTerminalPolls(): void {
  for (const stop of [...stoppers]) {
    try {
      stop()
    } catch {
      // A poller that throws on stop must not block the others or shutdown.
    }
  }
  stoppers.clear()
}
