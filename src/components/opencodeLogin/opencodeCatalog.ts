/**
 * The OpenCode catalogs occ ships, and how an OpenCode model id is presented.
 *
 * ── Two products, one account, two endpoints ──
 *
 * OpenCode sells Zen and Go behind the same login, and they are NOT the same
 * base URL:
 *
 *   Zen  https://opencode.ai/zen/v1     pay-as-you-go against a credit balance
 *   Go   https://opencode.ai/zen/go/v1  flat monthly subscription
 *
 * Which table a session is offered is therefore decided by the base URL's
 * PATH, never by its host. A host-only test passes for both products — that
 * was the bug: a Go subscriber whose live `/models` fetch failed was handed
 * Zen's 61 models, most of which their subscription does not serve, and
 * choosing one bills the Zen credit balance instead of the subscription. The
 * failure is `{"type":"CreditsError","message":"Insufficient balance…"}`, which
 * says nothing about products or URLs.
 *
 * Anything that is neither — a self-hosted gateway, or an unrecognised path on
 * opencode.ai itself — gets NO table. A compatible wire protocol is not catalog
 * ownership, and a path OpenCode has not published yet is not a product occ can
 * describe.
 *
 * ── Why occ ships these tables at all ──
 *
 * Shipping a third-party model table is normally the wrong move — CLAUDE.md
 * says so for Gemini and Grok, because hand-maintaining somebody else's ids is
 * the exact chore endpoint discovery exists to remove. OpenCode is the
 * exception, for one reason: `GET {base}/models` is public on both products
 * (200 with no credential), so both lists below were READ off the service
 * rather than invented, and they are only ever a fallback — a successful live
 * fetch always replaces them (see buildModelStep in ProviderSetupWizard).
 * Read 2026-08-10: 61 Zen models, 25 Go models.
 *
 * ── The lane suffix ──
 *
 * Both products serve several wire protocols behind one base URL, and which one
 * a session speaks is decided by the model it is configured for
 * (opencodeWire.ts). That is invisible in a picker of bare ids, so every option
 * is labelled with the path its model actually lands on.
 *
 * The known limitation this makes visible: in this phase a session speaks ONE
 * protocol. Pinning `opus` to `claude-opus-5` (/messages) and `haiku` to
 * `gpt-5.6-luna` (/responses) therefore puts one of them on the wrong lane —
 * the default model wins, because that is what the lane is derived from.
 * Per-request routing is what fixes it, and it is a larger change than this.
 *
 * Labels only. The value saved is always `model.id`, never the label.
 */

import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
} from 'src/services/auth/opencode/constants.js'
import {
  laneForModel,
  type OpencodeLane,
} from 'src/utils/model/opencodeWire.js'

/**
 * Bearer value Zen accepts for its free tier with no account behind it.
 *
 * Not a secret and not occ's invention: sst/opencode's own provider plugin
 * sends `apiKey: "public"` when no credential is present, and the free models
 * answer with a real completion (verified against `mimo-v2.5-free`). Zen only —
 * Go has no free tier and no `-free` ids in its catalog.
 */
export const ZEN_PUBLIC_KEY = 'public'

const LANE_PATHS: Record<OpencodeLane, string> = {
  messages: '/messages',
  responses: '/responses',
  chat: '/chat/completions',
}

/**
 * The public Zen catalog as of 2026-08-10, in the order the service returns it
 * (capability-descending within each family, free tier last).
 */
const ZEN_MODEL_IDS: readonly string[] = [
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex-spark',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-nano',
  'grok-build-0.1',
  'grok-4.5',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'big-pickle',
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'ling-3.0-flash-free',
  'ling-3.0-tiny-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
  'laguna-s-2.1-free',
  'longcat-2.0-free',
]

/**
 * The public Go catalog as of 2026-08-10, in the order `GET
 * /zen/go/v1/models` returns it.
 *
 * All 25 are open-coding models and there is NO Claude at any tier — which is
 * why offering Zen's table here is not a cosmetic mismatch: `claude-opus-5`
 * would look like a valid pick, route the session onto /messages (laneForModel
 * derives that from the id), and Go's /messages only forwards, so the upstream
 * answers `Invalid request: messages must not be empty` with occ nowhere in the
 * message. `gpt-5.6-luna` is the one id here that takes /responses; the other
 * 24 take /chat/completions, which laneForModel already gets right unchanged.
 */
const GO_MODEL_IDS: readonly string[] = [
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'qwen3.7-max',
  'qwen3.8-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'hy3',
  'hy3-preview',
  'gpt-5.6-luna',
  'grok-4.5',
]

/** Which of the two products an endpoint is. */
export type OpencodeProduct = 'zen' | 'go'

/**
 * Everything that differs between the two products, in one table.
 *
 * `billing` is UI copy rather than decoration: picking the wrong product is
 * only ever discovered through a CreditsError that explains none of this, so
 * every screen that offers a choice says which one charges what.
 */
export const OPENCODE_PRODUCTS: Record<
  OpencodeProduct,
  {
    label: string
    baseUrl: string
    billing: string
    models: readonly string[]
  }
> = {
  zen: {
    label: 'OpenCode Zen',
    baseUrl: OPENCODE_ZEN_BASE_URL,
    billing: 'pay-as-you-go, billed against a credit balance',
    models: ZEN_MODEL_IDS,
  },
  go: {
    label: 'OpenCode Go',
    baseUrl: OPENCODE_GO_BASE_URL,
    billing: 'flat monthly subscription, no per-token charge',
    models: GO_MODEL_IDS,
  },
}

/** host + path, so a trailing slash or a protocol swap still matches. */
function endpointIdentity(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

/**
 * Which product a base URL names, or undefined for an endpoint occ does not
 * recognise.
 *
 * Matched on host AND path: both products live on `opencode.ai`, so a
 * host-only comparison answers "official OpenCode" for either and cannot tell
 * them apart. An empty value means the field was left blank, which the wizard
 * resolves to the spec default — Zen.
 */
export function opencodeProductForBaseUrl(
  baseUrl: string | undefined,
): OpencodeProduct | undefined {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return 'zen'
  const identity = endpointIdentity(trimmed)
  if (!identity) return undefined
  for (const product of ['zen', 'go'] as const) {
    if (identity === endpointIdentity(OPENCODE_PRODUCTS[product].baseUrl)) {
      return product
    }
  }
  return undefined
}

/**
 * Whether an id answers without an account.
 *
 * A rule rather than a copy of the nine ids, so a new free model does not need
 * a release to be described correctly. Zen-only by construction: Go ships no
 * `-free` ids and no `big-pickle`. Used for explanatory copy only — the live
 * catalog stays the source of truth for what exists.
 */
export function isFreeZenModel(id: string): boolean {
  return id.endsWith('-free') || id === 'big-pickle'
}

/** The path a model's requests will be sent to. */
export function laneSuffixFor(model: string): string {
  return LANE_PATHS[laneForModel(model)]
}

/**
 * Annotate catalog entries with the lane their requests take.
 *
 * Applied to whatever the endpoint answered as well as to the shipped tables:
 * the routing consequence is the same either way, and a user comparing
 * `claude-opus-5` with `gpt-5.6-sol` has no other way to see that the choice
 * also changes the protocol.
 */
export function withLaneLabels(
  models: CatalogModel[] | null,
): CatalogModel[] | null {
  if (!models) return models
  return models.map(model => ({
    ...model,
    displayName: `${model.displayName?.trim() || model.id} · ${laneSuffixFor(
      model.id,
    )}`,
  }))
}

/**
 * The shipped table for this endpoint, lane-labelled, as the wizard's fallback
 * catalog — empty for anything that is not one of the two known products.
 */
export function opencodePresetModels(
  baseUrl: string | undefined,
): CatalogModel[] {
  const product = opencodeProductForBaseUrl(baseUrl)
  if (!product) return []
  const ids = OPENCODE_PRODUCTS[product].models
  return withLaneLabels(ids.map(id => ({ id }))) ?? []
}
