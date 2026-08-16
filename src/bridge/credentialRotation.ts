/**
 * Proactive credential rotation for long-lived Remote Control transports.
 *
 * RCS 0.2 re-validates the exact credential a session-ingress socket was
 * opened with on every frame and every keepalive tick, and closes with 4002
 * when it stops validating. A 15-minute account access token therefore takes
 * an otherwise healthy socket down every 15 minutes — and the recovery that
 * follows is a full environment re-registration, which can land on a brand new
 * session ID. Refreshing ahead of the deadline and swapping the socket while
 * the old one still works turns that into a sub-second, invisible event.
 *
 * Zero imports on purpose: this is the policy, and the bridge that owns the
 * transport supplies every effect. That also makes it testable on a fake clock
 * without loading the bridge.
 */

type Timer = { readonly __timer?: never }

type CredentialRotationDeps = {
  /** The credential the transport is currently authenticated with. */
  getAccessToken: () => string | undefined
  /**
   * Epoch-ms expiry of that credential, or undefined when the caller cannot
   * answer — which disables rotation entirely (claude.ai OAuth, legacy keys).
   */
  getAccessTokenExpiry: () => number | undefined
  /** Exchange the stored refresh credential for a newer access token. */
  refreshAccessToken: (staleAccessToken: string) => Promise<unknown>
  /**
   * Rebuild the transport around the current token. Returns false when the
   * swap has to wait (a history flush is in flight) — the scheduler retries
   * rather than skipping the rotation.
   */
  rotateTransport: () => boolean
  /** True once the bridge is torn down; every callback becomes a no-op. */
  isStopped: () => boolean
  log: (message: string, level?: 'warn' | 'error') => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}

type CredentialRotationScheduler = {
  /** (Re)arm the timer from the current expiry. Safe to call repeatedly. */
  schedule: () => void
  cancel: () => void
}

/**
 * How far ahead of expiry to rotate. Wide enough for a refresh round-trip
 * plus a WebSocket handshake, narrow enough that a 15-minute token rotates
 * once per lifetime rather than continuously.
 */
export const CREDENTIAL_REFRESH_BUFFER_MS = 3 * 60 * 1000

/**
 * Floor on the computed delay. Short-lived tokens shrink the buffer to half
 * their remaining life; this keeps that from degenerating into a tight loop.
 */
export const CREDENTIAL_REFRESH_MIN_DELAY_MS = 5_000

/** Retry delay when the swap is blocked behind an in-flight history flush. */
export const CREDENTIAL_REFRESH_BUSY_RETRY_MS = 10_000

/** Backoff between refreshes that produced no newer credential. */
export const CREDENTIAL_REFRESH_FAILURE_RETRY_MS = 60_000

/**
 * Consecutive refreshes that fail to produce a newer token before the
 * scheduler stands down. Past that, refreshing is not the answer and the
 * transport-close path — which re-registers the environment and carries its
 * own 401 retry — is better placed to recover.
 */
export const MAX_CREDENTIAL_REFRESH_FAILURES = 3

/**
 * Delay until the next rotation attempt.
 *
 * Exported for the same reason it is separate: the halving rule below is the
 * only part of this file worth reading twice. A token whose whole life is
 * shorter than the buffer would otherwise compute a negative delay, clamp to
 * the floor, and re-fire every few seconds forever.
 */
export function computeCredentialRefreshDelayMs(
  expiryMs: number,
  nowMs: number,
  bufferMs = CREDENTIAL_REFRESH_BUFFER_MS,
  minDelayMs = CREDENTIAL_REFRESH_MIN_DELAY_MS,
): number {
  const remainingMs = expiryMs - nowMs
  const effectiveBufferMs = Math.min(bufferMs, Math.max(remainingMs / 2, 0))
  return Math.max(remainingMs - effectiveBufferMs, minDelayMs)
}

export function createCredentialRotationScheduler(
  deps: CredentialRotationDeps,
): CredentialRotationScheduler {
  const now = deps.now ?? (() => Date.now())
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return handle as unknown as Timer
    })
  const clearTimer =
    deps.clearTimer ?? (timer => clearTimeout(timer as unknown as number))

  let timer: Timer | null = null
  let failures = 0

  function cancel(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  function schedule(delayOverrideMs?: number): void {
    cancel()
    if (deps.isStopped()) return

    let delayMs = delayOverrideMs
    if (delayMs === undefined) {
      const expiry = deps.getAccessTokenExpiry()
      // No expiry means no account session on this base URL. Nothing to do.
      if (!expiry) return
      delayMs = computeCredentialRefreshDelayMs(expiry, now())
    }
    timer = setTimer(() => void rotate(), delayMs)
  }

  async function rotate(): Promise<void> {
    timer = null
    if (deps.isStopped()) return

    const stale = deps.getAccessToken()
    try {
      await deps.refreshAccessToken(stale ?? '')
    } catch (error) {
      deps.log(`Proactive credential refresh threw: ${String(error)}`, 'error')
    }
    if (deps.isStopped()) return

    const fresh = deps.getAccessToken()
    if (!fresh || fresh === stale) {
      failures++
      deps.log(
        'Proactive credential refresh produced no newer token' +
          ` (attempt ${failures}/${MAX_CREDENTIAL_REFRESH_FAILURES})`,
      )
      if (failures >= MAX_CREDENTIAL_REFRESH_FAILURES) return
      schedule(CREDENTIAL_REFRESH_FAILURE_RETRY_MS)
      return
    }
    failures = 0

    if (!deps.rotateTransport()) {
      schedule(CREDENTIAL_REFRESH_BUSY_RETRY_MS)
      return
    }
    schedule()
  }

  return { schedule: () => schedule(), cancel }
}
