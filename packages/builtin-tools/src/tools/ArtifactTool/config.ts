/**
 * Cloud Artifacts service configuration.
 *
 * The defaults still point at the existing deployment, and deliberately so:
 * the token below is the Bearer value that the live Cloudflare Worker
 * validates, and the hostname is a live DNS record. Renaming either without
 * first standing up the replacement and rotating the Worker secret would break
 * artifact upload for every user. Change them together with the deployment,
 * not as part of a rename sweep.
 *
 * Self-hosted deployments override via env. `OCC_*` is canonical; the
 * `CLAUDE_ARTIFACTS_*` names are kept as a deprecated fallback so existing
 * setups keep working.
 */
export const ARTIFACTS_DEFAULT_TOKEN = 'claude-code-best'
export const ARTIFACTS_DEFAULT_URL =
  'https://cloud-artifacts.claude-code-best.win'

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
