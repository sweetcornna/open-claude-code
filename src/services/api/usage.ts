import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth/auth.js'
import { getFirstPartyTelemetryAuthHeaders } from '../../utils/network/http.js'
import { getClaudeCodeUserAgent } from '../../utils/network/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

export type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

export async function fetchUtilization(): Promise<Utilization | null> {
  // This asks Anthropic how much of an Anthropic subscription has been used, so
  // it is meaningless without an Anthropic subscription. A DeepSeek/OpenCode
  // session fails this check — isAnthropicAuthEnabled() is false once
  // OPENAI_BASE_URL or an external ANTHROPIC_API_KEY is present — and returns
  // an empty utilization, which /usage renders as "no rate limit data" and
  // /extra-usage treats as "unknown, let the user ask". That is the right
  // answer; the point of the guard below is that it also keeps a mirrored
  // third-party credential away from the auth chain.
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  // Skip API call if OAuth token is expired to avoid 401 errors
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  // Reaching here implies isClaudeAISubscriber(), so this resolves the OAuth
  // branch and the first-party variant is a no-op. Using it anyway means the
  // "is this Anthropic's credential?" question is asked by the same helper
  // everywhere, instead of being implied by a predicate three lines up that a
  // later edit could weaken without anyone connecting the two.
  const authResult = getFirstPartyTelemetryAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
  })

  return response.data
}
