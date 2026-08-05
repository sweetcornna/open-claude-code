import type { ProgressEvent } from '@open-claude-code/workflow-engine'

/** Typed progress event bus. engine progressEmitter.emit -> broadcasts to all subscribers (store / telemetry). */
export type ProgressBus = {
  emit(event: ProgressEvent): void
  subscribe(listener: (event: ProgressEvent) => void): () => void
}

export function createProgressBus(): ProgressBus {
  // Set iteration is insertion-ordered, and that ordering is load-bearing: the run-state
  // persistence listener relies on having been registered after the store, so that by the
  // time it runs the store has already reduced the same event (see attachRunStatePersistence).
  // Any replacement must keep delivering in subscription order.
  const listeners = new Set<(event: ProgressEvent) => void>()
  return {
    emit(event) {
      for (const fn of listeners) fn(event)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
