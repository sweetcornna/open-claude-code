/**
 * Credential revocation fan-out.
 *
 * The store raises an event whenever a credential stops being valid — logout,
 * refresh-token replay, account disable, password reset, worker epoch
 * rotation. Live transports subscribe so a revoked credential is evicted
 * within milliseconds instead of surviving until the connection's next frame,
 * which for an idle socket or a quiet SSE stream can be never.
 *
 * Deliberately dependency-free: `store.ts` sits below the transport layer, so
 * anything it imports must not reach back up into it.
 */

interface CredentialRevocation {
  /** Undefined means "scope unknown" — subscribers must re-check everything. */
  accountId?: string
  /** Set when only one session's credentials changed (e.g. epoch rotation). */
  sessionId?: string
  /** Short machine-readable cause, used for logging only. */
  reason: string
}

type RevocationListener = (event: CredentialRevocation) => void

const listeners = new Set<RevocationListener>()

export function subscribeCredentialRevocation(
  listener: RevocationListener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Notify subscribers that credentials were revoked. A throwing subscriber must
 * never break the store write that triggered it, so failures are swallowed.
 */
export function notifyCredentialRevocation(event: CredentialRevocation): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // A broken subscriber must not roll back a successful revocation.
    }
  }
}
