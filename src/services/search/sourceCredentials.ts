/**
 * Do we hold credentials for each WebSearch source?
 *
 * One host-side module answers this for everyone: the (synchronous) source
 * resolver inside packages/builtin-tools, and the /search-setting panel. That
 * keeps the leaf package's reach into host auth down to a single import, and
 * keeps "what counts as connected" from drifting between the panel and the
 * thing that actually runs the search.
 *
 * Every probe is synchronous and side-effect free: env vars plus the presence
 * of a credential file. A file that exists but holds a stale token still reads
 * as "connected" here — the search itself surfaces that, and a token refresh
 * must never be triggered from a settings panel render.
 */

import {
  registerSearchCredentialProbe,
  type SearchCredentialFamily,
} from '@open-claude-code/tool-runtime/searchCredentials.js'
import { hasGeminiOAuthCredentialsSync } from 'src/services/api/gemini/oauthToken.js'
import { hasStoredChatGPTAuthSync } from 'src/services/api/openai/chatgptAuth.js'

/**
 * The two Anthropic auth probes, loaded on first use.
 *
 * `require` on purpose, not a static import: src/tools.ts imports this module
 * (to register the facade) and is itself reachable FROM src/utils/auth, so a
 * static edge closes a cycle the check:cycles ratchet counts. The same
 * technique is already used for cycle- and DCE-sensitive edges in tools.ts and
 * commands.ts. Typed structurally so no import — not even a type-only one —
 * is needed.
 */
type AnthropicAuthProbes = {
  isClaudeAISubscriber: () => boolean
  hasAnthropicApiKeyAuth: () => boolean
}

let anthropicAuthProbes: AnthropicAuthProbes | undefined

function loadAnthropicAuthProbes(): AnthropicAuthProbes {
  if (!anthropicAuthProbes) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    anthropicAuthProbes =
      require('../../utils/auth/auth.js') as AnthropicAuthProbes
  }
  return anthropicAuthProbes
}

/**
 * Claude OAuth subscription or an Anthropic API key.
 *
 * Every call is wrapped: the auth stack THROWS when no credential is
 * configured at all (isAnthropicAuthEnabled → "ANTHROPIC_API_KEY or
 * CLAUDE_CODE_OAUTH_TOKEN env var is required"). For every caller here that
 * exception simply means "no credentials", and a settings panel or a search
 * must never blow up on it.
 */
export function hasAnthropicSearchCredentials(): boolean {
  try {
    if (loadAnthropicAuthProbes().isClaudeAISubscriber()) return true
  } catch {
    // fall through to the API-key probe
  }
  try {
    return loadAnthropicAuthProbes().hasAnthropicApiKeyAuth()
  } catch {
    return false
  }
}

/** Google OAuth (Antigravity) or a Gemini API key. */
export function hasGeminiSearchCredentials(): boolean {
  return hasGeminiOAuthCredentialsSync() || Boolean(process.env.GEMINI_API_KEY)
}

/**
 * ChatGPT OAuth or an OpenAI API key. The key alone is enough: the Responses
 * API serves the built-in web_search tool on the API-key route too.
 */
export function hasCodexSearchCredentials(): boolean {
  return hasStoredChatGPTAuthSync() || Boolean(process.env.OPENAI_API_KEY)
}

export function hasSearchCredentials(family: SearchCredentialFamily): boolean {
  switch (family) {
    case 'anthropic':
      return hasAnthropicSearchCredentials()
    case 'gemini':
      return hasGeminiSearchCredentials()
    case 'codex':
      return hasCodexSearchCredentials()
  }
}

// Self-registration (see packages/tool-runtime/src/searchCredentials.ts).
// The leaf package asks the facade, never this module: a direct import would
// drag src/utils/auth into the tool dependency graph and add cycles.
registerSearchCredentialProbe(hasSearchCredentials)
