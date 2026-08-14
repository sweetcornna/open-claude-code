/**
 * Artifact backend configuration.
 *
 * The default backend is `local`: the rendered HTML is written into the occ
 * config directory and the tool returns a `file://` URL. Nothing leaves the
 * machine unless the user opts in to a remote backend.
 *
 * Remote backends (`worker`, `rustypaste`) are explicit opt-in via
 * `OCC_ARTIFACTS_BACKEND` and REQUIRE an explicit upload token. There is no
 * usable baked-in credential — see ARTIFACTS_DEFAULT_TOKEN below.
 *
 * Self-hosted deployments configure via env. `OCC_*` is canonical; the
 * `CLAUDE_ARTIFACTS_*` names are kept as a deprecated fallback so existing
 * setups keep working.
 */

/**
 * KNOWN-STALE. Verified 2026-08-13 against the live community deployment:
 *
 *   POST https://cloud-artifacts.claude-code-best.win/upload
 *     no Authorization        -> {"error":"unauthorized"}  (HTTP 200)
 *     Authorization: <below>  -> {"error":"unauthorized"}  (HTTP 200)
 *
 * i.e. the deployment rotated its TOKEN secret without a matching CLI release,
 * so this value authenticates nothing. It is kept, not deleted, because the
 * rotation protocol in packages/cloud-artifacts/README.md ("Bearer token
 * rotation") is written around this constant and a self-hosted deployment may
 * still accept it. It is NEVER used as a fallback: `getArtifactsToken()`
 * requires an explicit token so a doomed request is never sent. Deployers who
 * still honour it can opt back in with `OCC_ARTIFACTS_TOKEN=<this value>`.
 */
export const ARTIFACTS_DEFAULT_TOKEN =
  '2f7f02afff3f9a6e72ea1454b748d9019b1e7939e3a6377e'

/**
 * Default host for the `worker` backend. Still a live DNS record and still the
 * right default for anyone who deploys their own Worker behind that name, so
 * it stays; only the credential is gone.
 */
export const ARTIFACTS_DEFAULT_URL =
  'https://cloud-artifacts.claude-code-best.win'

export type ArtifactsBackend = 'local' | 'worker' | 'rustypaste'

const BACKENDS: readonly ArtifactsBackend[] = ['local', 'worker', 'rustypaste']

export function getArtifactsBackend(): ArtifactsBackend {
  const backend = process.env.OCC_ARTIFACTS_BACKEND ?? 'local'
  if ((BACKENDS as readonly string[]).includes(backend)) {
    return backend as ArtifactsBackend
  }
  throw new Error(
    `Unsupported artifact backend: ${backend}. Expected "local", "worker" or "rustypaste".`,
  )
}

/** The configured upload token, or undefined when the user set none. */
export function getConfiguredArtifactsToken(): string | undefined {
  return process.env.OCC_ARTIFACTS_TOKEN ?? process.env.CLAUDE_ARTIFACTS_TOKEN
}

/**
 * Upload token for a remote backend. Throws with an actionable message rather
 * than falling back to ARTIFACTS_DEFAULT_TOKEN, which is known to be rejected.
 */
export function getArtifactsToken(backend?: ArtifactsBackend): string {
  const token = getConfiguredArtifactsToken()
  if (token) return token
  const name = backend ?? getArtifactsBackend()
  throw new Error(
    `The "${name}" artifact backend needs an upload token, but neither ` +
      'OCC_ARTIFACTS_TOKEN nor CLAUDE_ARTIFACTS_TOKEN is set. Either set ' +
      'OCC_ARTIFACTS_TOKEN (plus OCC_ARTIFACTS_URL for a self-hosted host — ' +
      'see packages/cloud-artifacts/README.md), or unset ' +
      'OCC_ARTIFACTS_BACKEND to save the artifact locally instead.',
  )
}

export function getArtifactsBaseUrl(): string {
  return (
    process.env.OCC_ARTIFACTS_URL ??
    process.env.CLAUDE_ARTIFACTS_URL ??
    ARTIFACTS_DEFAULT_URL
  )
}

/** Strip trailing slash so `${base}/upload` is well-formed. */
export function getUploadUrl(): string {
  const base = getArtifactsBaseUrl()
  return base.endsWith('/') ? `${base}upload` : `${base}/upload`
}
