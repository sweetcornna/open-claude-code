/**
 * Model configuration for the browser-use MCP server.
 *
 * browser-use runs its own model calls (the autonomous agent tool, and the
 * extraction path), so it needs credentials and an endpoint of its own. This
 * derives them from however the user configured occ, so that finishing login —
 * API key, OAuth, or a third-party gateway — leaves the browser tools working
 * without a second setup step.
 *
 * Everything is computed per spawn rather than persisted anywhere: a token
 * refresh, a `/login`, or a `/provider use` then takes effect on the next
 * browser session with nothing to re-sync.
 *
 * Separate module from setup.ts so the config builder stays free of the auth
 * module graph.
 */
import { getClaudeAIOAuthTokens } from '../auth/auth.js'
import { logForDebugging } from '../telemetry/debug.js'

/** Forwarded verbatim when set: they describe *where* the model lives. */
const PASSTHROUGH_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

/**
 * Environment to hand the browser-use subprocess.
 *
 * Empty when occ has nothing to contribute, in which case browser-use falls
 * back to whatever the user configured for it directly.
 */
export function browserUseAuthEnv(): Record<string, string> {
  const env: Record<string, string> = {}

  // Endpoint and model first. A user on a gateway or the china preset has a
  // base URL set; without it browser-use would talk to api.anthropic.com and
  // fail with a credential error that has nothing to do with the credential.
  for (const key of PASSTHROUGH_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }

  // An explicit key in the environment is already inherited by the subprocess
  // and is the user's own choice; do not second-guess it.
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.OPENAI_API_KEY
  ) {
    return env
  }

  // OAuth login: there is no key anywhere, only an access token in the
  // keychain. ANTHROPIC_AUTH_TOKEN is the Anthropic SDK's bearer variable,
  // which is exactly what an OAuth access token is. Without this the server
  // starts fine and then fails on its first model call, pointing at nothing
  // the user did.
  try {
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (accessToken) {
      env.ANTHROPIC_AUTH_TOKEN = accessToken
    }
  } catch (error) {
    logForDebugging(`[browser-use] could not read OAuth token: ${error}`)
  }
  return env
}

/**
 * Whether occ can give browser-use working model configuration.
 *
 * Used to decide whether to warn at setup time rather than letting the failure
 * surface as an authentication error on the first browser action.
 */
export function hasBrowserUseModelConfig(): boolean {
  const env = browserUseAuthEnv()
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.OPENAI_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN,
  )
}
