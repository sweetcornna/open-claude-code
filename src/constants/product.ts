export const PRODUCT_URL = 'https://github.com/sweetcornna/open-claude-code'

// Claude Code Remote session URLs
export const CLAUDE_AI_BASE_URL = 'https://claude.ai'
export const CLAUDE_AI_STAGING_BASE_URL = 'https://claude-ai.staging.ant.dev'
export const CLAUDE_AI_LOCAL_BASE_URL = 'http://localhost:4000'

const remoteSessionUrls = new Map<string, string>()

export function setRemoteSessionUrl(sessionId: string, url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    remoteSessionUrls.set(sessionId, parsed.toString())
  } catch {
    // Ignore malformed URLs returned by a bridge server.
  }
}

/**
 * Determine if we're in a staging environment for remote sessions.
 * Checks session ID format and ingress URL.
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * Determine if we're in a local-dev environment for remote sessions.
 * Checks session ID format (e.g. `session_local_...`) and ingress URL.
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * Get the base URL for Claude AI based on environment.
 * For localhost, derives the base URL from the ingress URL to preserve the
 * actual server port instead of using the hardcoded default (4000).
 */
export function getClaudeAiBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    // If an ingress URL is available, extract its origin to keep the correct port.
    // Self-hosted servers may run on any port (default 3000), not just 4000.
    if (ingressUrl) {
      try {
        const parsed = new URL(ingressUrl)
        return parsed.origin
      } catch {
        // Fall through to default
      }
    }
    return CLAUDE_AI_LOCAL_BASE_URL
  }
  if (isRemoteSessionStaging(sessionId, ingressUrl)) {
    return CLAUDE_AI_STAGING_BASE_URL
  }
  return CLAUDE_AI_BASE_URL
}

/**
 * Get the full session URL for a remote session.
 *
 * The cse_→session_ translation is gated by the bridge compat shim. Worker
 * endpoints want `cse_*`, while client-facing routes currently expect the same
 * UUID body tagged as `session_*`. The lazy require keeps constants/ at the
 * leaf of the module DAG.
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  const { isSelfHostedBridgeBaseUrl, resolveBridgeBaseUrl } =
    require('../bridge/bridgeBaseUrl.js') as typeof import('../bridge/bridgeBaseUrl.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  const serverIssuedUrl =
    remoteSessionUrls.get(sessionId) ?? remoteSessionUrls.get(compatId)
  if (serverIssuedUrl) return serverIssuedUrl
  // Anything that is not Anthropic's bridge serves its own web UI, so the
  // session lives under the bridge origin rather than on claude.ai.
  if (isSelfHostedBridgeBaseUrl()) {
    return `${resolveBridgeBaseUrl()}/code/${compatId}`
  }
  const baseUrl = getClaudeAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
