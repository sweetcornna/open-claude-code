import type { RuntimeAccessVerdict } from '../auth/middleware'
import { subscribeCredentialRevocation } from '../auth/revocation'
import { log } from '../logger'

/**
 * Registry of live credentialed transports (WebSockets and SSE streams).
 *
 * Per-frame revalidation catches a revoked credential the next time the peer
 * says something — which for an idle socket or a read-only SSE stream may be
 * never. This registry closes the gap: the store fans out a revocation event,
 * and every matching connection re-runs its own full auth check and is torn
 * down if it now fails.
 */
interface LiveConnection {
  /** Owner of the connection; scopes revocation sweeps. */
  accountId: string
  /** Session the connection is bound to, when it has one. */
  sessionId?: string
  /** Re-runs the connection's full auth check (credential + account + session). */
  revalidate: () => RuntimeAccessVerdict
  /** Terminates the transport. Must be idempotent. */
  close: (reason: string) => void
}

let nextConnectionId = 1
const connections = new Map<number, LiveConnection>()

export function registerLiveConnection(connection: LiveConnection): () => void {
  const id = nextConnectionId++
  connections.set(id, connection)
  return () => {
    connections.delete(id)
  }
}

/**
 * Re-validate every connection in scope and close the ones that now fail.
 * An undefined scope field matches everything, so a revocation whose owner is
 * unknown sweeps the whole registry.
 */
function sweepLiveConnections(scope: {
  accountId?: string
  sessionId?: string
}): number {
  let closed = 0
  for (const [id, connection] of [...connections]) {
    if (scope.accountId && connection.accountId !== scope.accountId) continue
    if (scope.sessionId && connection.sessionId !== scope.sessionId) continue
    let verdict: RuntimeAccessVerdict
    try {
      verdict = connection.revalidate()
    } catch {
      // A revalidation that throws is not a pass.
      verdict = { ok: false, reason: 'token_revoked' }
    }
    if (verdict.ok) continue
    connections.delete(id)
    closed++
    try {
      connection.close(verdict.reason)
    } catch {
      // Already-dead transports are fine; the entry is gone either way.
    }
  }
  return closed
}

/** Test helper — drops registry state without touching the transports. */
export function clearLiveConnections(): void {
  connections.clear()
}

subscribeCredentialRevocation(event => {
  const closed = sweepLiveConnections(event)
  if (closed > 0) {
    log(`[RCS] ${event.reason}: closed ${closed} live connection(s)`)
  }
})

/**
 * Credential re-validation for an SSE stream: the same check the WebSocket
 * paths run per frame, wired to a stream that has no inbound frames.
 */
export interface StreamGuard {
  accountId: string
  sessionId?: string
  revalidate: () => RuntimeAccessVerdict
}

export function attachStreamGuard(
  guard: StreamGuard | undefined,
  terminate: (reason: string) => void,
): { ensureValid: () => boolean; dispose: () => void } {
  if (!guard) {
    return { ensureValid: () => true, dispose: () => {} }
  }
  let terminated = false
  const finish = (reason: string) => {
    if (terminated) return
    terminated = true
    terminate(reason)
  }
  const unregister = registerLiveConnection({
    accountId: guard.accountId,
    sessionId: guard.sessionId,
    revalidate: guard.revalidate,
    close: finish,
  })
  return {
    ensureValid: () => {
      if (terminated) return false
      const verdict = guard.revalidate()
      if (verdict.ok) return true
      unregister()
      finish(verdict.reason)
      return false
    },
    dispose: () => {
      terminated = true
      unregister()
    },
  }
}
