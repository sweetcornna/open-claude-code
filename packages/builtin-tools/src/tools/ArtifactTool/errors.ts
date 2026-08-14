/**
 * Error text for the remote artifact backends.
 *
 * Both failure modes below are dead ends for the model unless the message says
 * what to change: a rejected token and an unreachable host look identical from
 * the tool result otherwise. Every other backend error code is passed through
 * verbatim on purpose (see client.ts) — those are already actionable.
 */

/** The host answered, and it refused the credential. */
export function unauthorizedMessage(): string {
  return (
    'Artifact upload failed: unauthorized — the artifact host rejected the ' +
    'upload token. Set OCC_ARTIFACTS_TOKEN to a token that deployment ' +
    'accepts (packages/cloud-artifacts/README.md, "Bearer token rotation"), ' +
    'or unset OCC_ARTIFACTS_BACKEND to save the artifact locally instead.'
  )
}

/** The request never got an answer: DNS, TLS, proxy, offline. */
export function unreachableMessage(target: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  let origin = target
  try {
    origin = new URL(target).origin
  } catch {
    // Keep the raw string; a malformed URL is itself the useful detail.
  }
  return (
    `Artifact upload failed: cannot reach ${origin} (${detail}). Check the ` +
    'host is up and that OCC_ARTIFACTS_URL points at it, or unset ' +
    'OCC_ARTIFACTS_BACKEND to save the artifact locally instead.'
  )
}
