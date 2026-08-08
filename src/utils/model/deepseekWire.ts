/**
 * Routing DeepSeek through its Anthropic-compatible endpoint.
 *
 * DeepSeek serves three protocols and they are not equivalent:
 *
 *   /chat/completions   OpenAI-compatible. What occ used by default, because
 *                       DeepSeek is configured through the OPENAI_* keys.
 *                       Has NO built-in web search. Thinking has to be coaxed
 *                       out with `chat_template_kwargs`, and every message is
 *                       converted Anthropic → OpenAI → Anthropic.
 *   /responses          OpenAI Responses API. Has the built-in `web_search`
 *                       tool, but still needs the conversion layer.
 *   /anthropic          Anthropic Messages API. Verified 2026-08-07 to support
 *                       tool_use, native `thinking` blocks, prompt caching,
 *                       `server_tool_use` + `web_search_tool_result` (DeepSeek
 *                       runs the search server-side), and to accept
 *                       `output_config.effort` without complaint.
 *
 * The third is strictly better here: it is occ's own wire format, so nothing
 * is lost in translation, and `ApiSearchAdapter` — which declares
 * `web_search_20250305` — starts returning real results with sources instead
 * of falling back to keyless SERP scraping. (`hasCodexSearchCredentials()`
 * requires an `api.openai.com` base URL, so a DeepSeek key never qualified for
 * the `codex` search lane; those users were on `FreeSearchAdapter`, the worst
 * tier available, while holding a free server-side search they could not
 * reach.)
 *
 * Detection is by base URL only, and the user's settings file is never
 * rewritten — existing configs keep working untouched.
 *
 * Order of preference, matching the documented behaviour:
 *   message (this module, default) > responses (OPENAI_WIRE_API=responses)
 *                                  > chat (OPENAI_WIRE_API=chat)
 *
 * Escape hatch: `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` forces the old path.
 *
 * Imports stay dependency-free (host predicate plus pure URL normalization),
 * because getAPIProvider() consults this and is on every hot path.
 */

import {
  buildProviderResourceURL,
  normalizeProviderBaseURL,
} from '../network/providerUrl.js'
import { isDeepSeekBaseURL } from './deepseekHost.js'

/** Set to `0`/`false` to keep DeepSeek on the OpenAI-compatible wire. */
const OPT_OUT_ENV = 'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE'

function isOptedOut(): boolean {
  const raw = process.env[OPT_OUT_ENV]?.trim().toLowerCase()
  return raw === '0' || raw === 'false'
}

/**
 * Whether an explicit wire choice should win.
 *
 * `OPENAI_WIRE_API` is the user saying "talk to this endpoint with that
 * protocol". Honour it rather than silently redirecting to a third one.
 */
function hasExplicitWireChoice(): boolean {
  const raw = process.env.OPENAI_WIRE_API?.trim().toLowerCase()
  return raw === 'chat' || raw === 'responses'
}

/**
 * True when the session is configured for DeepSeek through the OPENAI_* keys
 * and nothing has asked for a different protocol.
 */
export function isDeepSeekAnthropicWireActive(): boolean {
  if (isOptedOut()) return false
  if (hasExplicitWireChoice()) return false
  // A key is required: without one the Anthropic client would send no auth and
  // the failure would be a confusing 401 rather than the existing behaviour.
  if (!process.env.OPENAI_API_KEY?.trim()) return false
  // Never redirect a session that already points ANTHROPIC_BASE_URL at some
  // OTHER host — that user configured the Anthropic side deliberately. A value
  // pointing at DeepSeek is either their own choice or this module's own
  // earlier write, and must not flip the answer to false (applyDeepSeek…()
  // sets that key, so a naive "is it set?" check would make this function
  // stop agreeing with itself after the first call).
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim()
  if (anthropicBase && !isDeepSeekBaseURL(anthropicBase)) return false
  // Not just "a key exists": the key has to be the one this routing would send.
  // A stale ANTHROPIC_API_KEY left by an earlier provider is not authorisation
  // for DeepSeek, and claiming the wire is active on the strength of it is how
  // a session ends up posting to the wrong endpoint with the wrong credential.
  return isDeepSeekBaseURL(process.env.OPENAI_BASE_URL)
}

/**
 * `<host>` → `<host>/anthropic`, idempotent.
 *
 * normalizeProviderBaseURL throws a TypeError on anything `new URL()` rejects
 * or on a non-http(s) scheme, and this runs from applyDeepSeekAnthropicWire() on
 * the startup path (entrypoints/init.ts), whose catch rethrows anything that is
 * not a ConfigParseError. `OPENAI_BASE_URL=api.deepseek.com` — no scheme, which
 * isDeepSeekBaseURL still recognises through its substring fallback — therefore
 * crashed the CLI before it drew a frame. Fall back to string-only handling, the
 * same shape modelCatalog/cache.ts uses: a base URL occ cannot canonicalize is a
 * reason to pass it through, not to refuse to start.
 */
function toAnthropicBase(base: string): string {
  try {
    return normalizeProviderBaseURL(base, 'deepseekAnthropic')
  } catch {
    const trimmed = base.trim().replace(/\/+$/, '')
    return /\/anthropic$/i.test(trimmed) ? trimmed : `${trimmed}/anthropic`
  }
}

/**
 * The Anthropic Messages base URL derived from `OPENAI_BASE_URL`, or undefined
 * when this routing is not active.
 *
 * Derived rather than hard-coded so a gateway or regional mirror of DeepSeek
 * that `isDeepSeekBaseURL` recognises keeps working.
 */
export function getDeepSeekAnthropicBaseURL(): string | undefined {
  if (!isDeepSeekAnthropicWireActive()) return undefined
  const base = process.env.OPENAI_BASE_URL?.trim()
  if (!base) return undefined
  return toAnthropicBase(base)
}

/**
 * Endpoint + key the `deepseek` WebSearch source posts to, or undefined when
 * this machine holds no DeepSeek configuration.
 *
 * Deliberately NOT gated on `isDeepSeekAnthropicWireActive()`. That predicate
 * answers a different question — "should the MAIN LOOP speak Anthropic Messages
 * to DeepSeek" — and it says no as soon as `OPENAI_WIRE_API` names a protocol.
 * A search source is its own lane, exactly like the `codex` and `gemini` lanes
 * that run against their own provider whatever the main loop speaks. Tying the
 * two together would withhold the search from the user who needs it most: the
 * chat wire has NO built-in web search at all, so a session pinned to
 * `OPENAI_WIRE_API=chat` is precisely the one currently falling back to keyless
 * SERP scraping while holding a server-side search it never reaches.
 *
 * `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` IS honoured: that switch names this
 * endpoint specifically, so it reads as "do not talk to /anthropic at all".
 *
 * Whether the endpoint actually serves `web_search_20250305` is a separate,
 * network-answered question — see probeDeepSeekSearchSupport().
 */
export function getDeepSeekSearchEndpoint():
  | { baseURL: string; messagesURL: string; apiKey: string }
  | undefined {
  if (isOptedOut()) return undefined
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim()
  const openaiBase = process.env.OPENAI_BASE_URL?.trim()
  // ANTHROPIC_BASE_URL first: when it points at DeepSeek it is either the user's
  // own choice or this module's mirror, and either way it is the URL the rest of
  // the session is already talking to.
  const base = isDeepSeekBaseURL(anthropicBase)
    ? anthropicBase
    : isDeepSeekBaseURL(openaiBase)
      ? openaiBase
      : undefined
  if (!base) return undefined
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return undefined
  return {
    baseURL: toAnthropicBase(base),
    // The finished request URL is built HERE, not by the caller. The only
    // consumer is the `deepseek` WebSearch adapter, which lives in
    // packages/builtin-tools — a leaf that must not reach into host URL
    // helpers — and the `${baseURL}/v1/messages` it used to concatenate lands
    // the path inside the query string whenever the base carries one
    // (`https://gw.deepseek.com/anthropic?tenant=x`).
    messagesURL: toMessagesURL(base),
    apiKey,
  }
}

/** `<host>` → `<host>/anthropic/v1/messages`, with the same fallback as above. */
function toMessagesURL(base: string): string {
  try {
    return buildProviderResourceURL(base, 'deepseekAnthropic', 'v1/messages')
  } catch {
    return `${toAnthropicBase(base)}/v1/messages`
  }
}

/** The four tier env keys, paired OpenAI → Anthropic. */
const TIER_ENV_PAIRS = [
  ['OPENAI_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ['OPENAI_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['OPENAI_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['OPENAI_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
] as const

/**
 * Keys this module wrote on the last apply, so the next one can refresh them.
 *
 * Without this the mirror could only ever fill blanks, which is wrong twice
 * over: it cannot follow a configuration that changes mid-session, and it
 * cannot tell its own earlier write apart from a value the user set. Only keys
 * listed here are ever overwritten or removed — a user's own ANTHROPIC_API_KEY
 * is never claimed, so it is never touched.
 */
let mirroredKeys = new Map<string, string>()

/**
 * Whether `ANTHROPIC_API_KEY` currently holds a value this module wrote.
 *
 * The interactive auth path only accepts an `ANTHROPIC_API_KEY` out of the
 * environment when the user has explicitly approved that key (the "use the API
 * key found in your environment?" list). A mirrored key is not "found in the
 * environment" — the user typed it into `/login` two screens earlier and it was
 * copied here by this module, so there is nothing to approve and no prompt they
 * could ever have answered. Without this the interactive session falls past the
 * approval check to the keychain, finds no Anthropic key, and reports
 * "Not logged in · Please run /login" — while `--print` works, because print
 * mode takes an earlier branch that skips approval entirely.
 */
export function isDeepSeekMirroredApiKey(value: string | undefined): boolean {
  return isMirroredValue('ANTHROPIC_API_KEY', value)
}

/**
 * Whether `ANTHROPIC_MODEL` currently holds a value this module wrote.
 *
 * getUserSpecifiedModelSetting() ranks env ANTHROPIC_MODEL above settings.model,
 * which is right for a key the user exported and wrong for the mirror's copy of
 * OPENAI_MODEL. Without this check, a user whose settings.json said
 * `"model": "deepseek-v4-flash"` was moved to `deepseek-v4-pro` the moment the
 * first getAnthropicClient() ran the mirror — no message, no way to tell from
 * the settings file, and the status line showed the model they never picked.
 */
export function isDeepSeekMirroredModel(value: string | undefined): boolean {
  return isMirroredValue('ANTHROPIC_MODEL', value)
}

function isMirroredValue(key: string, value: string | undefined): boolean {
  if (!value) return false
  return mirroredKeys.get(key) === value
}

/**
 * Mirror the DeepSeek OPENAI_* configuration onto the ANTHROPIC_* keys the
 * first-party client reads. In-memory only — `settings.json` is not touched.
 *
 * Tier models are copied because the user's explicit choice must outrank
 * DeepSeek's own alias mapping (`claude-opus*` → v4-pro, `claude-sonnet*` /
 * `claude-haiku*` → v4-flash).
 *
 * MUST be re-run whenever provider configuration changes, not only at startup.
 * `getAPIProvider()` flips to 'firstParty' the instant `isDeepSeekAnthropicWire
 * Active()` starts returning true — which happens as soon as `/login` writes
 * OPENAI_BASE_URL and OPENAI_API_KEY into process.env. If the mirror does not
 * run again at that moment, the session claims the routing without applying it:
 * ANTHROPIC_BASE_URL is unset so requests go to api.anthropic.com,
 * ANTHROPIC_API_KEY is unset so they come back 401 "Not logged in", and
 * `getDefaultSonnetModel()` finds no ANTHROPIC_DEFAULT_SONNET_MODEL so it falls
 * through to the literal `claude-sonnet-5`. One missing call, all three
 * symptoms. It is hooked into managedEnv.ts's two apply functions, which every
 * settings-env path funnels through, plus the two components that write
 * provider env to process.env directly.
 *
 * Idempotent, and safe to call at any time.
 */
export function applyDeepSeekAnthropicWire(): void {
  // Release the previous claim FIRST. Besides letting a changed configuration
  // through, this removes the self-reference that isDeepSeekAnthropicWire
  // Active() otherwise has to reason around: by the time it reads
  // ANTHROPIC_BASE_URL below, anything still there belongs to the user.
  //
  // Only release a key that still holds the exact value written last time.
  // Anything else means something authoritative overwrote it in between —
  // settings.env being re-applied, an explicit export — and dropping that would
  // turn this from "undo my own write" into "discard the user's".
  for (const [key, written] of mirroredKeys) {
    if (process.env[key] === written) delete process.env[key]
  }
  mirroredKeys = new Map()

  const baseURL = getDeepSeekAnthropicBaseURL()
  if (!baseURL) return

  const claim = (key: string, value: string): void => {
    process.env[key] = value
    mirroredKeys.set(key, value)
  }

  claim('ANTHROPIC_BASE_URL', baseURL)
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (apiKey && !process.env.ANTHROPIC_API_KEY?.trim()) {
    claim('ANTHROPIC_API_KEY', apiKey)
  }
  for (const [from, to] of TIER_ENV_PAIRS) {
    const value = process.env[from]?.trim()
    if (value && !process.env[to]?.trim()) claim(to, value)
  }
  // OPENAI_MODEL is the provider's DEFAULT model — the fallback for tiers the
  // user did not pin, not an override of them (resolveOpenAIModel consults it
  // after both `*_DEFAULT_<TIER>_MODEL` lookups). Carrying it to ANTHROPIC_MODEL
  // reproduces that role on this wire; isDeepSeekMirroredModel() is what keeps
  // the copy from being mistaken for a user selection downstream.
  const providerDefault = process.env.OPENAI_MODEL?.trim()
  if (providerDefault && !process.env.ANTHROPIC_MODEL?.trim()) {
    claim('ANTHROPIC_MODEL', providerDefault)
  }
}
