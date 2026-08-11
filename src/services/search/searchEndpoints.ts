/**
 * Where a search lane sends its request, and with what key.
 *
 * One resolution order, everywhere: **pinned credential → provider env**. A
 * user who never opened /search-setting keeps working off the provider plane
 * exactly as before — nothing here changes what an unpinned source does — while
 * a pinned one stops caring whether `/logout` or `/provider use` just rewrote
 * the env it used to live in.
 *
 * This module exists rather than folding the lookup into `sourceCredentials.ts`
 * because the search adapters live in `packages/builtin-tools`, and importing
 * that file from there would drag the OAuth stores (ChatGPT, Gemini, Anthropic
 * keychain) into the tool dependency graph — the exact cycle the credential
 * facade was built to avoid. This one imports the store and pure URL helpers.
 */

import { buildProviderResourceURL } from 'src/utils/network/providerUrl.js'
import {
  getDeepSeekSearchEndpoint,
  isDeepSeekAnthropicWireOptedOut,
  toDeepSeekAnthropicBase,
  toDeepSeekMessagesURL,
} from 'src/utils/model/deepseekWire.js'
import { DEEPSEEK_API_HOST } from 'src/utils/model/deepseekHost.js'
import { readPinnedSearchCredential } from './searchCredentialStore.js'

/** Endpoint the DeepSeek search lane posts to, plus the key it authenticates with. */
type DeepSeekSearchEndpoint = {
  baseURL: string
  messagesURL: string
  apiKey: string
}

/** Fallback host for a pinned DeepSeek credential that carries no endpoint. */
const DEFAULT_DEEPSEEK_BASE_URL = `https://${DEEPSEEK_API_HOST}`

/**
 * The DeepSeek search endpoint: pinned first, then the env derivation.
 *
 * `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` still wins over both. That switch
 * names this endpoint specifically ("do not talk to /anthropic at all"), and a
 * pin is a statement about *which* credential to use, never a request to
 * override a capability the user switched off — the same asymmetry
 * `isSourceEnabled` applies to the source overrides.
 */
export function resolveDeepSeekSearchEndpoint():
  | DeepSeekSearchEndpoint
  | undefined {
  if (isDeepSeekAnthropicWireOptedOut()) return undefined
  const pinned = readPinnedSearchCredential('deepseek')
  if (pinned) {
    const base = pinned.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL
    // Both derivations are idempotent (normalizePathname strips `/anthropic`
    // before re-adding it), so a credential pinned from an already-derived
    // endpoint round-trips instead of growing a second path segment.
    return {
      baseURL: toDeepSeekAnthropicBase(base),
      messagesURL: toDeepSeekMessagesURL(base),
      apiKey: pinned.apiKey,
    }
  }
  return getDeepSeekSearchEndpoint()
}

/** Endpoint the Anthropic search lane posts to when a credential is pinned. */
type AnthropicSearchEndpoint = {
  messagesURL: string
  apiKey: string
}

/** Anthropic's own Messages host, for a pin that carries no endpoint. */
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

/**
 * The Anthropic search lane's own endpoint and key, or nothing when none is
 * pinned.
 *
 * There is no env fallback here, and that asymmetry is deliberate: unpinned,
 * this lane authenticates through the session's Anthropic auth stack (Claude
 * subscription, keychain, `ANTHROPIC_API_KEY`, custom headers), which is far
 * more than an endpoint and a key and must keep working exactly as it does
 * today. `undefined` therefore means "use getAnthropicClient()", not "no
 * credentials".
 *
 * A pin gets a standalone request instead, for the same reason
 * `DeepSeekDirectSearchAdapter` does not use the SDK client: that client is
 * built from `ANTHROPIC_*` env, which after a `/provider use` may hold an
 * OpenCode access token mirrored onto Anthropic's keys and a base URL pointing
 * at somebody else's gateway. Sending a pinned Anthropic key there would post
 * the user's credential to a third party.
 */
export function resolvePinnedAnthropicSearchEndpoint():
  | AnthropicSearchEndpoint
  | undefined {
  const pinned = readPinnedSearchCredential('anthropic')
  if (!pinned) return undefined
  const base = pinned.baseURL ?? DEFAULT_ANTHROPIC_BASE_URL
  return { messagesURL: toAnthropicMessagesURL(base), apiKey: pinned.apiKey }
}

/**
 * `<host>` → `<host>/v1/messages`.
 *
 * Same fallback shape as the DeepSeek derivation: a base URL that `new URL()`
 * rejects is a reason to pass the string through and let the failure arrive as
 * a readable request error, not to throw inside a settings panel render.
 */
function toAnthropicMessagesURL(base: string): string {
  try {
    return buildProviderResourceURL(base, 'anthropic', 'v1/messages')
  } catch {
    return `${base.trim().replace(/\/+$/, '')}/v1/messages`
  }
}

/** Credential the Gemini search lane authenticates with, when one is pinned. */
type GeminiSearchCredential = {
  apiKey: string
  baseURL?: string
}

/**
 * The pinned Gemini search credential, or nothing.
 *
 * No env fallback, same reasoning as the Anthropic resolver above: unpinned,
 * `streamGeminiGenerateContent` reads `GEMINI_API_KEY`/`GEMINI_BASE_URL`
 * itself and may also route through Antigravity on a Google login. Returning
 * `undefined` leaves that path untouched.
 */
export function resolvePinnedGeminiSearchCredential():
  | GeminiSearchCredential
  | undefined {
  const pinned = readPinnedSearchCredential('gemini')
  if (!pinned) return undefined
  return {
    apiKey: pinned.apiKey,
    ...(pinned.baseURL ? { baseURL: pinned.baseURL } : {}),
  }
}

/** Credential the Codex search lane authenticates with, when one is pinned. */
type CodexSearchCredential = {
  apiKey: string
  baseURL?: string
}

/**
 * The pinned Codex/OpenAI search credential, or nothing.
 *
 * No env fallback, same as the Anthropic and Gemini resolvers: unpinned, the
 * lane picks between a stored ChatGPT login and `OPENAI_API_KEY` exactly as it
 * did before this store existed, and `undefined` is what leaves that alone.
 *
 * The key deliberately keeps whatever endpoint it was pinned with — including
 * none, which `createOpenAIResponsesStream` reads as OpenAI's own default.
 * Completing an endpoint-less pin from `OPENAI_BASE_URL` would send the user's
 * OpenAI key to whichever third-party gateway the session was later pointed
 * at; that env var is the thing a pin is supposed to stop depending on.
 */
export function resolvePinnedCodexSearchCredential():
  | CodexSearchCredential
  | undefined {
  const pinned = readPinnedSearchCredential('codex')
  if (!pinned) return undefined
  return {
    apiKey: pinned.apiKey,
    ...(pinned.baseURL ? { baseURL: pinned.baseURL } : {}),
  }
}
