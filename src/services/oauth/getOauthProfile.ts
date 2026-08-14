import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import type { OAuthProfileResponse } from 'src/services/oauth/types.js'
import {
  getAnthropicApiKey,
  isThirdPartyMirroredApiKey,
} from 'src/utils/auth/auth.js'
import { getGlobalConfig } from 'src/utils/config/config.js'
import { logError } from 'src/utils/telemetry/log.js'
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  // Assumes interactive session
  const config = getGlobalConfig()
  const accountUuid = config.oauthAccount?.accountUuid
  const apiKey = getAnthropicApiKey()

  // Need both account UUID and API key to check
  if (!accountUuid || !apiKey) {
    return
  }

  // Reached at startup from useCanSwitchToExistingSubscription, whose only gate
  // is `!isClaudeAISubscriber()` — which a DeepSeek/OpenCode session always
  // passes. Any user who logged in with Anthropic OAuth once (leaving
  // oauthAccount on disk) and later configured one of those providers would
  // send that vendor's mirrored credential to api.anthropic.com, unprompted,
  // on every launch. It is not Anthropic's key, so it cannot answer "does this
  // account have a Claude subscription" anyway.
  if (isThirdPartyMirroredApiKey(apiKey)) {
    return
  }
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli_profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      params: {
        account_uuid: accountUuid,
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    logError(error as Error)
  }
}

export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    logError(error as Error)
  }
}
