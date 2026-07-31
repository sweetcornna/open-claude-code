/**
 * Cloud Artifacts service configuration.
 *
 * The token below is PUBLIC by design: it ships inside every npm bundle, so
 * it can never be a secret. Its only job is abuse throttling for the free
 * community Worker. Rotating it requires coordinating with the deployment —
 * see "Bearer token rotation" in packages/cloud-artifacts/README.md (deploy
 * the Worker with TOKEN_PREVIOUS set BEFORE releasing a CLI that carries the
 * new value).
 *
 * The hostname is a live DNS record; changing it without standing up a
 * replacement breaks artifact upload for every user.
 *
 * Self-hosted deployments override via env. `OCC_*` is canonical; the
 * `CLAUDE_ARTIFACTS_*` names are kept as a deprecated fallback so existing
 * setups keep working.
 */
export const ARTIFACTS_DEFAULT_TOKEN =
  '2f7f02afff3f9a6e72ea1454b748d9019b1e7939e3a6377e'
export const ARTIFACTS_DEFAULT_URL =
  'https://cloud-artifacts.claude-code-best.win'

export type ArtifactsBackend = 'worker' | 'rustypaste'

export function getArtifactsBackend(): ArtifactsBackend {
  const backend = process.env.OCC_ARTIFACTS_BACKEND ?? 'worker'
  if (backend === 'worker' || backend === 'rustypaste') return backend
  throw new Error(
    `Unsupported artifact backend: ${backend}. Expected "worker" or "rustypaste".`,
  )
}

export function getArtifactsToken(): string {
  return (
    process.env.OCC_ARTIFACTS_TOKEN ??
    process.env.CLAUDE_ARTIFACTS_TOKEN ??
    ARTIFACTS_DEFAULT_TOKEN
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
