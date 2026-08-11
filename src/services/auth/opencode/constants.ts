/**
 * OpenCode endpoints and wire constants.
 *
 * Two different hosts, two different jobs, and conflating them is the easiest
 * mistake to make here:
 *
 *   console.opencode.ai — the ACCOUNT plane. Device-code OAuth lives here, and
 *     so does `/api/config`, which describes the provider/model catalog the
 *     signed-in org is entitled to. Nothing is ever inferred from it.
 *   opencode.ai/zen/… — the INFERENCE plane. Three wire protocols behind one
 *     base URL (verified against the live service, all three 401 without a
 *     credential): `/messages` speaks Anthropic, `/responses` and
 *     `/chat/completions` speak OpenAI.
 *
 * The inference plane is TWO products sold behind one account, and they are not
 * the same endpoint. Getting this wrong is not a routing detail: a Go
 * subscriber's key sent to the Zen base URL is billed against the Zen credit
 * balance and answers
 * `{"type":"error","error":{"type":"CreditsError","message":"Insufficient
 * balance…"}}` — which is how the split was found in the first place.
 *
 * Values match `packages/core/src/plugin/provider/opencode.ts` in sst/opencode.
 * `opencode-cli` is that client's own device-flow client_id; occ reuses it
 * because the console only issues device codes to registered clients, and the
 * token it mints is scoped to the user's account either way.
 */

/** Account plane: device OAuth + the entitlement catalog. */
export const OPENCODE_CONSOLE_URL = 'https://console.opencode.ai'

/**
 * Inference plane — Zen: pay-as-you-go against a credit balance.
 *
 * All three wire protocols hang off this base, and its catalog is the broad one
 * (61 models, Claude included).
 */
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/**
 * Inference plane — Go: the flat monthly subscription.
 *
 * A different endpoint with a different, smaller catalog: 25 open-coding models
 * and NO Claude at any tier (read verbatim from `GET /zen/go/v1/models`, 200,
 * OpenAI-shaped, 2026-08-10). Verified live on this base: `/chat/completions`
 * answers 200 with a real completion carrying `"cost":"0"` — the subscription
 * is not metered — and `/responses` answers 200 for the one GPT id it serves.
 * `/messages` exists but only FORWARDS, exactly as on Zen, so with no Claude in
 * the catalog it is never the right lane here.
 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Device-flow client identifier, as registered by the opencode CLI. */
export const OPENCODE_CLIENT_ID = 'opencode-cli'

/** RFC 8628 device-code grant. */
export const DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code'

/** Credential file under occConfigDir(), 0600. */
export const OPENCODE_AUTH_FILE = 'opencode-auth.json'

/**
 * Env key holding a Zen or service-account API key.
 *
 * Named after opencode's own variable so a machine already configured for the
 * opencode CLI needs nothing new.
 */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'

/**
 * Refresh this far before the access token actually lapses.
 *
 * A request that starts inside the margin still has to finish; 60s covers a
 * slow streaming handshake without refreshing on every call.
 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000

/** Added to the poll interval when the server answers `slow_down`. */
export const SLOW_DOWN_BACKOFF_MS = 5_000
