/**
 * Session-scoped pause switch for automemory (`/pause-memory`).
 *
 * Deliberately in-memory only. Pausing is a "not this conversation" decision,
 * not a configuration change: persisting it would silently disable memory in
 * every future session, and users would have no obvious way to notice.
 * `settings.autoMemoryEnabled` is the durable off switch.
 *
 * Kept in its own zero-dependency module rather than on `isAutoMemoryEnabled()`
 * so pausing only affects the runtime paths that read and write memories.
 * `isAutoMemoryEnabled()` also drives static UI affordances (the /memory
 * selector, agent-creation wizard steps, memory-path permission checks) which
 * should keep reflecting the durable configuration while paused.
 */

let paused = false

export function isMemoryPaused(): boolean {
  return paused
}

export function setMemoryPaused(next: boolean): void {
  paused = next
}

/** Flips the switch and returns the new state. */
export function toggleMemoryPaused(): boolean {
  paused = !paused
  return paused
}

/** Test-only: restore the default so suites don't leak state into each other. */
export function resetMemoryPausedForTesting(): void {
  paused = false
}
