/**
 * Credentials for the browser-use MCP server.
 *
 * browser-use runs its own model calls (the autonomous agent tool, and the
 * extraction path), so it needs credentials of its own. Users who authenticate
 * with an API key already have `ANTHROPIC_API_KEY` in the environment and it is
 * inherited — but the common case for occ is an OAuth login, where there is no
 * API key anywhere, only an access token in the keychain. Without this the
 * server would start and then fail on its first model call with an
 * authentication error that points at nothing the user did.
 *
 * `ANTHROPIC_AUTH_TOKEN` is the Anthropic SDK's bearer-auth variable, which is
 * what an OAuth access token is. Separate module from setup.ts so the config
 * builder stays free of the auth module graph.
 */
import { getClaudeAIOAuthTokens } from '../auth/auth.js'
import { logForDebugging } from '../telemetry/debug.js'

/**
 * Environment to hand the browser-use subprocess, or an empty object when occ
 * has nothing to give it — in which case browser-use falls back to whatever the
 * user configured for it directly.
 */
export function browserUseAuthEnv(): Record<string, string> {
  // An explicit key in the environment is already inherited by the subprocess
  // and is the user's own choice; do not second-guess it.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return {}
  }
  if (process.env.OPENAI_API_KEY) {
    return {}
  }
  try {
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (accessToken) {
      return { ANTHROPIC_AUTH_TOKEN: accessToken }
    }
  } catch (error) {
    logForDebugging(`[browser-use] could not read OAuth token: ${error}`)
  }
  return {}
}
