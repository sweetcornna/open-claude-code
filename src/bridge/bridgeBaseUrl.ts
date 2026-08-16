/**
 * Where Remote Control points, and whether that is Anthropic's bridge.
 *
 * Kept apart from `bridgeConfig.ts` so the answer stays reachable from the
 * leaves of the module DAG: `constants/product.ts` builds session URLs from it
 * and must not pull in the auth/keychain tree that `bridgeConfig.ts` imports.
 * `bridgeConfig.ts` wraps the two helpers most callers want
 * (`getBridgeBaseUrl` / `isSelfHostedBridge`).
 *
 * Resolution order — `OCC_REMOTE_CONTROL_URL` > `CLAUDE_BRIDGE_BASE_URL` >
 * `DEFAULT_REMOTE_CONTROL_URL`. The middle one predates the rename and is the
 * form already sitting in existing `settings.json` files, so it stays
 * supported rather than being migrated.
 *
 * The default is a real, reachable server, which inverts what "self-hosted"
 * used to mean: an unconfigured occ is now *not* on Anthropic's bridge. That
 * is the point — the claude.ai path needs a subscription plus a first-party
 * GrowthBook gate, and 1P GrowthBook is opt-in-off in occ, so leaving it as
 * the default made `/remote-control` permanently unavailable out of the box.
 */

import { DEFAULT_REMOTE_CONTROL_URL } from '../constants/brand.js'
import { getOauthConfig } from '../constants/oauth.js'

/** Strip trailing slashes so the same server is one key everywhere. */
export function normalizeBridgeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function readBaseUrlEnv(key: string): string | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  const normalized = normalizeBridgeBaseUrl(raw)
  return normalized || undefined
}

/**
 * The explicitly configured Remote Control server, or undefined when the user
 * has not chosen one. Callers that need a URL to actually talk to should use
 * `resolveBridgeBaseUrl()`; this getter exists for the few places that must
 * distinguish "configured" from "defaulted".
 */
export function getBridgeBaseUrlOverride(): string | undefined {
  return (
    readBaseUrlEnv('OCC_REMOTE_CONTROL_URL') ??
    readBaseUrlEnv('CLAUDE_BRIDGE_BASE_URL')
  )
}

/** Base URL for every Remote Control request. Always returns a URL. */
export function resolveBridgeBaseUrl(): string {
  return getBridgeBaseUrlOverride() ?? DEFAULT_REMOTE_CONTROL_URL
}

/**
 * True unless Remote Control is aimed at Anthropic's own bridge.
 *
 * "Self-hosted" here means "not the claude.ai service" — it covers the public
 * occ server, a private RCS and a laptop on port 3000 alike, because what the
 * callers actually branch on is whether claude.ai's subscription/entitlement
 * checks and org-UUID lookups apply. Only an explicit override equal to the
 * official API base takes the claude.ai path.
 */
export function isSelfHostedBridgeBaseUrl(): boolean {
  const resolved = resolveBridgeBaseUrl()
  if (resolved === DEFAULT_REMOTE_CONTROL_URL) return true
  let officialBase: string
  try {
    officialBase = normalizeBridgeBaseUrl(getOauthConfig().BASE_API_URL)
  } catch {
    // A rejected CLAUDE_CODE_CUSTOM_OAUTH_URL throws here. This predicate runs
    // during command registration, so it must answer rather than take the
    // process down — and "we could not identify Anthropic's bridge" can only
    // mean the configured URL is not it.
    return true
  }
  return resolved !== officialBase
}

/**
 * WebSocket/SSE ingress. Normally the same host as the API, but a local RCS
 * (or Anthropic's dev stack) can split them across ports.
 */
export function resolveBridgeSessionIngressUrl(baseUrl: string): string {
  return readBaseUrlEnv('CLAUDE_BRIDGE_SESSION_INGRESS_URL') ?? baseUrl
}
