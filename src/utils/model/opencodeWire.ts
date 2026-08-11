/**
 * Routing an OpenCode session onto the right wire protocol.
 *
 * OpenCode serves three protocols behind one base URL (all three verified live,
 * 2026-08-10 — each answers 401 without a credential rather than 404):
 *
 *   /messages           Anthropic Messages. The right lane for `claude-*`: zen
 *                       proxies real Anthropic checkpoints, so this is occ's
 *                       own wire format with nothing lost in translation, and
 *                       native thinking blocks survive.
 *   /responses          OpenAI Responses API. The right lane for `gpt-*` and
 *                       the o-series, which is what the Codex-shaped models
 *                       there expect.
 *   /chat/completions   OpenAI Chat Completions. The catch-all for everything
 *                       else in the catalog (gemini, deepseek, glm, kimi,
 *                       qwen, minimax, grok, and Zen's free tier).
 *
 * WHICH base URL is a separate question this module deliberately does not ask:
 * `OPENCODE_BASE_URL` names one of two products — Zen (pay-as-you-go) or Go
 * (subscription, 25 open-coding models, no Claude) — and the lane rule above is
 * the same for both. Verified on Go: /chat/completions and /responses answer
 * 200, and /messages forwards without translating, so with no Claude in that
 * catalog the classifier below never picks it. Nothing here needs a product
 * term, and adding one would make the lane depend on two inputs instead of one.
 *
 * ── Why the lane is read off the environment, not off a resolved model ──
 *
 * getAPIProvider() consults this module, and getAPIProvider() is upstream of
 * model resolution. Asking model.ts which checkpoint an alias resolves to would
 * close exactly the dependency cycle that keeps modelTier.ts and tierDefaults.ts
 * at zero imports. So the lane comes from `OPENCODE_MODEL` — the model the
 * session is actually configured for — and the whole configuration is re-applied
 * when that selection changes.
 *
 * The consequence is worth stating plainly: in this phase a session speaks ONE
 * protocol, so pinning `opus` to `claude-opus-5` and `haiku` to `gpt-5.6-luna`
 * puts one of them on the wrong lane. Per-request routing is what fixes that,
 * and it is a larger change than this module.
 *
 * Escape hatch: `OPENCODE_WIRE_API` (`messages` | `responses` | `chat`) pins
 * the lane, for a deployment whose model naming this heuristic misreads.
 *
 * Dependency-free apart from the family classifier, which is itself zero-import
 * for the same reason.
 */

import { getProviderFamily } from './tierDefaults.js'

export type OpencodeLane = 'messages' | 'responses' | 'chat'

/** Persisted configuration keys. The credential is NOT among them — see below. */
export const OPENCODE_BASE_URL_ENV = 'OPENCODE_BASE_URL'
export const OPENCODE_MODEL_ENV = 'OPENCODE_MODEL'
export const OPENCODE_WIRE_API_ENV = 'OPENCODE_WIRE_API'

/** Marks a session as OpenCode-configured, the way OPENAI_AUTH_MODE does. */
export const OPENCODE_AUTH_MODE_ENV = 'OPENCODE_AUTH_MODE'

export const OPENCODE_TIER_ENVS = [
  'OPENCODE_DEFAULT_HAIKU_MODEL',
  'OPENCODE_DEFAULT_SONNET_MODEL',
  'OPENCODE_DEFAULT_OPUS_MODEL',
  'OPENCODE_DEFAULT_FABLE_MODEL',
] as const

const TIER_ENV_TARGETS = {
  messages: [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
  ],
  openai: [
    'OPENAI_DEFAULT_HAIKU_MODEL',
    'OPENAI_DEFAULT_SONNET_MODEL',
    'OPENAI_DEFAULT_OPUS_MODEL',
    'OPENAI_DEFAULT_FABLE_MODEL',
  ],
} as const

/**
 * The live bearer token, held in memory only.
 *
 * OpenCode access tokens expire in about an hour and are refreshed from a 0600
 * file, so they must never reach settings.json — a persisted copy would be
 * stale within the hour and would be a secret in a world-readable-ish config at
 * the same time. The async credential layer (services/auth/opencode) pushes the
 * current value here, and this module mirrors it onto whichever lane's key the
 * client reads.
 */
let runtimeToken: string | undefined

/**
 * Only the bearer value lives here. The organization id travels with the
 * credential instead (services/api/opencodeCredential.ts → the client's
 * `x-org-id` header): it is not part of any mirrored env key, so a copy here
 * would be state nothing reads.
 */
export function setOpencodeRuntimeCredential(token: string | undefined): void {
  runtimeToken = token?.trim() || undefined
}

function explicitLane(): OpencodeLane | undefined {
  const raw = process.env[OPENCODE_WIRE_API_ENV]?.trim().toLowerCase()
  if (raw === 'messages' || raw === 'responses' || raw === 'chat') return raw
  return undefined
}

/**
 * Which protocol an OpenCode model id speaks. Same rule on Zen and on Go.
 *
 * Pure and exported so the setup wizard can tell the user which lane a pick
 * lands on before anything is written.
 */
export function laneForModel(model: string): OpencodeLane {
  const family = getProviderFamily(model)
  if (family === 'claude') return 'messages'
  if (family === 'gpt') return 'responses'
  return 'chat'
}

/** True when this session is configured to talk to OpenCode. */
export function isOpencodeSessionActive(): boolean {
  return process.env[OPENCODE_AUTH_MODE_ENV]?.trim() === 'opencode'
}

/** The lane this session will use. */
export function getOpencodeLane(): OpencodeLane | undefined {
  if (!isOpencodeSessionActive()) return undefined
  return explicitLane() ?? laneForModel(process.env[OPENCODE_MODEL_ENV] ?? '')
}

/**
 * Keys this module wrote on the last apply, so the next one can refresh them.
 *
 * Same accounting rule as the DeepSeek mirror, and for the same reason: only a
 * key still holding the exact value written last time is released. Anything
 * else was overwritten by something authoritative in between (settings.env
 * being re-applied, a user export) and dropping it would turn "undo my own
 * write" into "discard the user's".
 */
let mirroredKeys = new Map<string, string>()

/**
 * Whether `ANTHROPIC_API_KEY` currently holds a value this module wrote.
 *
 * Same role as isDeepSeekMirroredApiKey, and needed for the same reason: the
 * interactive auth path only accepts an ANTHROPIC_API_KEY out of the
 * environment when the user has approved it in the "Detected a custom API key"
 * list. A mirrored value was never discovered in the shell — it came from the
 * OpenCode login two screens earlier — so there is no prompt the user could
 * have answered, and the default answer is No. Without this, an OpenCode
 * session works under `--print` (which skips approval entirely) and reports
 * "Not logged in · Please run /login" in the REPL.
 */
export function isOpencodeMirroredApiKey(value: string | undefined): boolean {
  if (!value) return false
  return mirroredKeys.get('ANTHROPIC_API_KEY') === value
}

/**
 * Mirror the OPENCODE_* configuration onto the lane keys the clients read.
 * In-memory only — settings.json is never rewritten.
 *
 * MUST be re-run whenever the configuration or the credential changes, not just
 * at startup: getAPIProvider() flips the moment the auth mode lands in
 * process.env, and a mirror that has not run yet means the session claims a
 * routing it has not applied. That failure is silent and looks like an outage —
 * requests go to the wrong host with no credential and come back 401. The
 * DeepSeek lane learned this the expensive way; the durable fix there was to
 * re-run at client construction, and the same backstop applies here.
 *
 * Idempotent, and safe to call at any time.
 */
export function applyOpencodeWire(): void {
  for (const [key, written] of mirroredKeys) {
    if (process.env[key] === written) delete process.env[key]
  }
  mirroredKeys = new Map()

  const lane = getOpencodeLane()
  if (!lane) return

  const baseUrl = process.env[OPENCODE_BASE_URL_ENV]?.trim()
  if (!baseUrl) return

  const claim = (key: string, value: string): void => {
    process.env[key] = value
    mirroredKeys.set(key, value)
  }

  const model = process.env[OPENCODE_MODEL_ENV]?.trim()
  const tierGroup = lane === 'messages' ? 'messages' : 'openai'
  const targets = TIER_ENV_TARGETS[tierGroup]

  if (lane === 'messages') {
    claim('ANTHROPIC_BASE_URL', baseUrl)
    // ANTHROPIC_API_KEY, not ANTHROPIC_AUTH_TOKEN. The two are not
    // interchangeable at the wire: the SDK turns `apiKey` into `x-api-key` and
    // `authToken` into `Authorization: Bearer`, and Zen's /messages lane accepts
    // ONLY the former. Verified against the live endpoint with a real key —
    // Bearer alone answers `{"type":"AuthError","message":"Missing API key."}`,
    // x-api-key alone gets through to the account check, and sending both is
    // fine. Mirroring the token to AUTH_TOKEN made every OpenCode Claude
    // session 401, and no unit test could see it: they assert which env key was
    // set, not which header that key becomes.
    if (runtimeToken && !process.env.ANTHROPIC_API_KEY?.trim()) {
      claim('ANTHROPIC_API_KEY', runtimeToken)
    }
    if (model && !process.env.ANTHROPIC_MODEL?.trim()) {
      claim('ANTHROPIC_MODEL', model)
    }
  } else {
    claim('OPENAI_BASE_URL', baseUrl)
    claim('OPENAI_WIRE_API', lane === 'responses' ? 'responses' : 'chat')
    if (runtimeToken && !process.env.OPENAI_API_KEY?.trim()) {
      claim('OPENAI_API_KEY', runtimeToken)
    }
    if (model && !process.env.OPENAI_MODEL?.trim()) {
      claim('OPENAI_MODEL', model)
    }
  }

  OPENCODE_TIER_ENVS.forEach((from, index) => {
    const value = process.env[from]?.trim()
    const to = targets[index]
    if (value && to && !process.env[to]?.trim()) claim(to, value)
  })
}
