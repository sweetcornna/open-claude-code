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
import { isOfficialOpenAIBaseURL } from 'src/services/api/openai/openaiShared.js'

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
 * ChatGPT OAuth, or an OpenAI API key that will actually reach OpenAI.
 *
 * The `codex` source is not "some OpenAI-compatible endpoint" — it is OpenAI's
 * server-side `web_search` tool, and only OpenAI runs it. An API key alone used
 * to be treated as proof of that, which is wrong in the configuration occ is
 * built for: `OPENAI_BASE_URL` pointed at a third-party OpenAI-compatible
 * endpoint is the norm here, and `OPENAI_API_KEY` then holds THAT vendor's key.
 *
 * The failure this produced was silent rather than loud, which is why it
 * survived. Pointed at DeepSeek, the lane is chosen as the session's PRIMARY
 * source, the request is accepted (DeepSeek does implement the Responses API),
 * and the search genuinely runs — the response carries `web_search_call` items.
 * But DeepSeek reports neither `url_citation` annotations nor `action.sources`,
 * the only two places results are read from, so the lane returns zero results
 * on every query while reporting no error at all. The model then sees an empty
 * web and says so.
 *
 * The base-URL check is deliberately strict (see `isOfficialOpenAIBaseURL`):
 * a gateway that genuinely proxies OpenAI's web_search is indistinguishable
 * from one that does not, so the conservative answer is "off". There is no
 * settings escape hatch — `isSourceEnabled` treats an explicit `true` as "use
 * this when it works", never as a capability override — so the remedy is to log
 * in with ChatGPT (which the first branch then honours) or point the endpoint at
 * OpenAI.
 *
 * The ChatGPT branch is a promise the lane has to keep: `CodexSearchAdapter`
 * routes to the Codex backend whenever the base URL is not OpenAI's, precisely
 * so the login counted here is the login the search uses. Loosening either side
 * alone re-opens the silent-empty-results hole above.
 */
export function hasCodexSearchCredentials(): boolean {
  // A ChatGPT/Codex login authenticates against OpenAI's own backend by
  // construction, whatever OPENAI_BASE_URL happens to say.
  if (hasStoredChatGPTAuthSync()) return true
  return (
    Boolean(process.env.OPENAI_API_KEY) &&
    isOfficialOpenAIBaseURL(process.env.OPENAI_BASE_URL)
  )
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
