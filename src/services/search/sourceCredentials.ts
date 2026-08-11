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
 *
 * RESOLUTION ORDER — pinned credential (searchCredentialStore.ts) first, the
 * provider env second. Search used to be entirely parasitic on the provider
 * plane, so `/logout` and `/provider use` silently took it away; a pin is the
 * user saying "this key is for search, leave it alone". Nothing about the
 * unpinned path changed, so an existing setup needs no migration to keep
 * searching.
 */

import {
  registerSearchCredentialProbe,
  type SearchCredentialFamily,
} from '@open-claude-code/tool-runtime/searchCredentials.js'
import { hasGeminiOAuthCredentialsSync } from 'src/services/api/gemini/oauthToken.js'
import { hasStoredChatGPTAuthSync } from 'src/services/api/openai/chatgptAuth.js'
import { isOfficialOpenAIBaseURL } from 'src/services/api/openai/openaiShared.js'
import { isDeepSeekAnthropicWireActive } from 'src/utils/model/deepseekWire.js'
import { readPinnedSearchCredential } from './searchCredentialStore.js'
import { resolveDeepSeekSearchEndpoint } from './searchEndpoints.js'

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
  // A pin carries its own endpoint and its own key, and the lane posts to them
  // directly (resolvePinnedAnthropicSearchEndpoint), so none of the reasoning
  // below about what the session's provider plane happens to hold applies to
  // it. Answered first for exactly that reason: it is the one case where "this
  // really is Anthropic" is known rather than inferred.
  if (readPinnedSearchCredential('anthropic')) return true
  // Not "are there Anthropic credentials" but "can this lane reach Anthropic".
  // While the DeepSeek routing is active, ANTHROPIC_BASE_URL points at
  // api.deepseek.com and ANTHROPIC_API_KEY is usually this process's own mirror
  // of the DeepSeek key — so `AnthropicDirectSearchAdapter` would post to
  // DeepSeek. Left saying "yes", the panel shows a connected *Anthropic* row
  // that is really DeepSeek (the exact mislabelling CLAUDE.md forbids) and the
  // aggregation fires the same endpoint twice, once per name. The `deepseek`
  // source below is what that configuration owns.
  if (isDeepSeekAnthropicWireActive()) return false
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

/**
 * A DeepSeek endpoint plus a key for it.
 *
 * "Configured", not "verified": whether that deployment really serves
 * `web_search_20250305` is a network question, and this probe is contractually
 * synchronous and side-effect free. The verified half is
 * `probeDeepSeekSearchSupport()`, which retires the source through the
 * session-scoped availability axis when the endpoint says no — the same axis a
 * live search failure uses.
 */
export function hasDeepSeekSearchCredentials(): boolean {
  return resolveDeepSeekSearchEndpoint() !== undefined
}

/** A pinned key, Google OAuth (Antigravity), or a Gemini API key. */
export function hasGeminiSearchCredentials(): boolean {
  if (readPinnedSearchCredential('gemini')) return true
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
 *
 * No pinned-credential branch, unlike the other three sources — this is the one
 * source `/search-setting` refuses to pin (PINNABLE_SEARCH_SOURCES). Its lane
 * authenticates inside `createOpenAIResponsesStream`, which builds the request
 * from `OPENAI_API_KEY`/`OPENAI_BASE_URL` with no credential seam, so a pin
 * would light this row green for a key that never leaves the disk. Its ChatGPT
 * login is already a 0600 file rather than an env var, which is what gives this
 * source a credential that survives a provider switch at all.
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
    case 'deepseek':
      return hasDeepSeekSearchCredentials()
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
