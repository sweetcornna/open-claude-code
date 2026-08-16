/**
 * Shared bridge auth/URL resolution. Consolidates the CLAUDE_BRIDGE_*
 * overrides that were previously copy-pasted across a dozen files —
 * inboundAttachments, BriefTool/upload, bridgeMain, initReplBridge,
 * remoteBridgeCore, daemon workers, /rename, /remote-control.
 *
 * URL resolution itself lives in `bridgeBaseUrl.ts` — a leaf module, so
 * `constants/product.ts` can reach it without dragging in the auth tree. This
 * file adds the layers that do need the auth store.
 */

import {
  isSelfHostedBridgeBaseUrl,
  resolveBridgeBaseUrl,
} from './bridgeBaseUrl.js'
import {
  getRemoteControlAccessTokenForRequest,
  getRemoteControlAuthMode,
} from '../services/remoteControlAuth/state.js'
import { getClaudeAIOAuthTokens } from '../utils/auth/auth.js'

/** Dev override: CLAUDE_BRIDGE_OAUTH_TOKEN, else undefined. */
function getBridgeTokenOverride(): string | undefined {
  return process.env.CLAUDE_BRIDGE_OAUTH_TOKEN || undefined
}

/**
 * Access token for bridge API calls. Account-mode servers (the public occ RCS
 * and any self-hosted RCS 0.2) use the short-lived token managed by
 * remoteControlAuth, keyed by the same resolved base URL the request will use;
 * legacy servers retain the explicit env override; claude.ai uses OAuth.
 */
export function getBridgeAccessToken(): string | undefined {
  const baseUrl = getBridgeBaseUrl()
  if (getRemoteControlAuthMode(baseUrl) === 'accounts') {
    return getRemoteControlAccessTokenForRequest(baseUrl)
  }
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

/**
 * Base URL for bridge API calls: `OCC_REMOTE_CONTROL_URL`, then
 * `CLAUDE_BRIDGE_BASE_URL`, then the public occ Remote Control server. Always
 * returns a normalized URL.
 */
export function getBridgeBaseUrl(): string {
  return resolveBridgeBaseUrl()
}

/**
 * True unless Remote Control is explicitly aimed at Anthropic's own bridge —
 * so true by default. See `bridgeBaseUrl.ts` for why the default flipped.
 */
export function isSelfHostedBridge(): boolean {
  return isSelfHostedBridgeBaseUrl()
}

/**
 * Detail passed to `onStateChange('failed', …)` when a self-hosted account
 * server has no usable session yet. Interactive callers treat this one value
 * as "open the account dialog" rather than "show a failure notification", so
 * the producer (initReplBridge) and the consumer (useReplBridge) have to agree
 * on the exact string — hence a shared constant instead of a literal at each
 * end. The value is the slash command itself, so it reads correctly as a hint
 * for callers that only render it and is directly runnable for callers that
 * dispatch it.
 */
export const BRIDGE_ACCOUNT_LOGIN_REQUIRED = '/remote-control login'

/**
 * Whether the persistent `occ remote-control` entrypoint may refuse to start
 * because no claude.ai login is present.
 *
 * Only the official service can answer that question this early. A self-hosted
 * server owns its own credential lifecycle: in account mode a fresh process
 * legitimately has no access token yet — it is obtained by `bridgeMain`, from
 * the stored refresh credential or the masked TTY prompt. Blocking here would
 * make that path unreachable, so self-hosted deployments get exactly one gate,
 * inside `bridgeMain`.
 *
 * `hasCredential` stays lazy: reading it can spawn a keychain helper, and the
 * self-hosted branch must not pay for an answer it ignores.
 */
export function shouldBlockBridgeStartupForLogin(input: {
  selfHosted: boolean
  hasCredential: () => boolean
}): boolean {
  if (input.selfHosted) return false
  return !input.hasCredential()
}
