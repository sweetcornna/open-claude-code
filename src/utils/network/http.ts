/**
 * HTTP utility constants and helpers
 */

import axios from 'axios'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isThirdPartyMirroredApiKey,
} from '../auth/auth.js'
import { getClaudeCodeUserAgent } from './userAgent.js'
import { getWorkload } from '../session/workloadContext.js'

// WARNING: We rely on `claude-cli` in the user agent for log filtering.
// Please do NOT change this without making sure that logging also gets updated!
export function getUserAgent(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  // SDK consumers can identify their app/library via CLAUDE_AGENT_SDK_CLIENT_APP
  // e.g., "my-app/1.0.0" or "my-library/2.1"
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  // Turn-/process-scoped workload tag for cron-initiated requests. 1P-only
  // observability — proxies strip HTTP headers; QoS routing uses cc_workload
  // in the billing-header attribution block instead (see constants/system.ts).
  // getAnthropicClient (client.ts:98) calls this per-request inside withRetry,
  // so the read picks up the same setWorkload() value as getAttributionHeader.
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `claude-cli/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    parts.push(process.env.CLAUDE_CODE_ENTRYPOINT)
  }
  if (process.env.CLAUDE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`)
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `claude-code/${MACRO.VERSION}${suffix}`
}

// User-Agent for WebFetch requests to arbitrary sites. `Claude-User` is
// Anthropic's publicly documented agent for user-initiated fetches (what site
// operators match in robots.txt); the claude-code suffix lets them distinguish
// local CLI traffic from claude.ai server-side fetches.
export function getWebFetchUserAgent(): string {
  return `Claude-User (${getClaudeCodeUserAgent()}; +https://support.anthropic.com/)`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * Get authentication headers for API requests
 * Returns either OAuth headers for Max/Pro users or API key headers for regular users
 */
export function getAuthHeaders(): AuthHeaders {
  if (isClaudeAISubscriber()) {
    const oauthTokens = getClaudeAIOAuthTokens()
    if (!oauthTokens?.accessToken) {
      return {
        headers: {},
        error: 'No OAuth token available',
      }
    }
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }
  // Whatever getAnthropicApiKey() resolves to is sent as-is. That is right for
  // requests bound for ANTHROPIC_BASE_URL — gateway key to the gateway,
  // DeepSeek key to DeepSeek's Anthropic-compatible endpoint — and wrong for
  // requests occ addresses to api.anthropic.com itself, which is why those go
  // through getFirstPartyTelemetryAuthHeaders() below instead.
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

/**
 * Auth headers for every request occ addresses to Anthropic ON ITS OWN BEHALF,
 * as opposed to on behalf of the user's configured model endpoint. Not for
 * inference: that follows the user's endpoint and must keep using
 * getAuthHeaders().
 *
 * Callers span three kinds, and the list grows — prefer this function for any
 * new hardcoded api.anthropic.com request rather than reasoning about whether
 * that particular one can be reached by a mirrored session:
 *   - background telemetry: GrowthBook gate fetch, 1P event export, the
 *     BigQuery metrics exporter and the metrics opt-out probe that gates it
 *   - account/subscription probes: Grove settings, post-login first-token
 *     date, the startup subscription-switch profile lookup, utilization
 *   - user-initiated data sharing: /bug reports and transcript shares, which
 *     additionally refuse via isBlockedByMirroredCredential() so they can tell
 *     the user why instead of failing silently
 *
 * The distinction exists because `ANTHROPIC_API_KEY` is not always Anthropic's
 * key. The DeepSeek and OpenCode wires mirror their own credential into it (an
 * OpenCode one is a live OAuth access token), so the pre-fork code path
 * — `getAuthHeaders()` straight into a POST at
 * `https://api.anthropic.com/api/event_logging/batch` — sent a third party's
 * secret to Anthropic as `x-api-key`. The stale TODO that used to sit in
 * getAuthHeaders ("this will fail if the API key is being set to an LLM
 * Gateway key") was upstream noticing the same shape and reading it as a
 * reliability problem.
 *
 * Deliberately a separate function rather than a refusal inside
 * getAuthHeaders(): that one is shared with every real Anthropic-protocol
 * request, and blanket-rejecting mirrored keys there would break inference for
 * exactly the DeepSeek and OpenCode users this protects. A `purpose` parameter
 * would work equally well mechanically, but it puts the decision at the call
 * site where it can be omitted by accident; a distinctly named function makes
 * "which of the two is this?" visible in the caller and in review.
 *
 * Failing closed means no auth header, not no request — each caller decides.
 * GrowthBook skips its HTTP init entirely and serves LOCAL_GATE_DEFAULTS, the
 * 1P exporter POSTs unauthenticated (the same path it takes before the trust
 * dialog), the BigQuery exporter and its opt-out probe skip the export, the
 * account probes skip their cache warm. The telemetry callers additionally
 * cannot reach the network without their own opt-in
 * (OCC_ENABLE_GROWTHBOOK / OCC_ENABLE_1P_TELEMETRY /
 * CLAUDE_CODE_ENABLE_TELEMETRY); the account probes have no such gate, which
 * is why the check has to live here rather than alongside those switches.
 */
export function getFirstPartyTelemetryAuthHeaders(): AuthHeaders {
  const auth = getAuthHeaders()
  if (auth.error) {
    return auth
  }
  if (isThirdPartyMirroredApiKey(auth.headers['x-api-key'])) {
    return {
      headers: {},
      error:
        'ANTHROPIC_API_KEY holds a third-party credential mirrored by this session',
    }
  }
  return auth
}

/**
 * Wrapper that handles OAuth 401 errors by force-refreshing the token and
 * retrying once. Addresses clock drift scenarios where the local expiration
 * check disagrees with the server.
 *
 * The request closure is called again on retry, so it should re-read auth
 * (e.g., via getAuthHeaders()) to pick up the refreshed token.
 *
 * Note: bridgeApi.ts has its own DI-injected version — handleOAuth401Error
 * transitively pulls in config.ts (~1300 modules), which breaks the SDK bundle.
 *
 * @param opts.also403Revoked - Also retry on 403 with "OAuth token has been
 *   revoked" body (some endpoints signal revocation this way instead of 401).
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  opts?: { also403Revoked?: boolean },
): Promise<T> {
  try {
    return await request()
  } catch (err) {
    if (!axios.isAxiosError(err)) throw err
    const status = err.response?.status
    const isAuthError =
      status === 401 ||
      (opts?.also403Revoked &&
        status === 403 &&
        typeof err.response?.data === 'string' &&
        err.response.data.includes('OAuth token has been revoked'))
    if (!isAuthError) throw err
    const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!failedAccessToken) throw err
    await handleOAuth401Error(failedAccessToken)
    return await request()
  }
}
