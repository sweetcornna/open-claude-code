/**
 * Proving an OpenCode API key before the wizard lets it configure a session.
 *
 * The Console sign-in's hole, on the other credential kind. Step 1's only
 * request is `GET /models`, which BOTH products serve publicly (verified: 200
 * with no credential at all) — so a typo'd key, a Go key pasted against Zen's
 * URL, or a key belonging to another org all produce a full picker of real
 * model ids and a complete save. The first thing that ever sends the key is the
 * user's first prompt, which comes back `API Error [OpenAI]: Invalid API key` —
 * a message that reads as a broken provider rather than a bad credential, and
 * leaves no obvious way back.
 *
 * So the key is exercised while the wizard is still on step 1. That placement
 * is the whole of the "nothing is written before the verdict" guarantee here:
 * step 1 writes nothing at all, so a refusal cannot leave a half-configured
 * session behind — the same invariant activateSession.ts enforces for the
 * device flow, obtained for free rather than by hand.
 *
 * The probe's contract is documented on `verifyOpencodeAccess` and is not
 * re-derived here (the gateway authenticates BEFORE it validates the body, so
 * an empty `messages` array is free and never runs inference; only `AuthError`
 * counts as a refusal, since an unknown model id answers `ModelError` and is
 * still stamped 401; a transport throw is inconclusive rather than a verdict).
 * It is a parameter so this decision is testable without a network — and it has
 * to be, because a WRONG key is the one input that cannot be handed to the live
 * service on a user's behalf.
 */

import { verifyOpencodeAccess } from 'src/services/auth/opencode/index.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import {
  isFreeZenModel,
  OPENCODE_PRODUCTS,
  opencodeProductForBaseUrl,
  type OpencodeProduct,
  ZEN_PUBLIC_KEY,
} from './opencodeCatalog.js'

type OpencodeFormCredential = {
  /** Endpoint the form is pointed at; the wizard has already defaulted it. */
  baseURL: string
  /** Exactly what the API Key field holds. Empty is a case, not a gap. */
  apiKey: string
  /** The catalog answer, for naming a model the endpoint actually serves. */
  models: CatalogModel[] | null
  signal?: AbortSignal
}

/**
 * Shaped to `ProviderSetupSpec['verifyCredential']` structurally rather than by
 * importing its types: specs.ts imports THIS module, and a type-only back edge
 * is still an edge the cycle ratchet counts. The assignment in the spec table
 * is the compiler-checked link between the two.
 */
export async function verifyOpencodeFormCredential(
  { baseURL, apiKey, models, signal }: OpencodeFormCredential,
  probe: typeof verifyOpencodeAccess = verifyOpencodeAccess,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = apiKey.trim()
  const product = opencodeProductForBaseUrl(baseURL)
  // The "free models only" entry point does not leave the field empty — it
  // hands the form Zen's public bearer outright — so the two have to be the
  // same case here. Told apart, that entry would be probed as a real key
  // against the first of Zen's 61 models, which is a paid one.
  const anonymous = key.length === 0 || key === ZEN_PUBLIC_KEY
  const model = probeModel(models, product, anonymous)
  // Nothing to probe with: an endpoint occ ships no table for, whose /models
  // request also failed. Treated like a transport throw — inconclusive is not a
  // refusal, and blocking a setup on it would be a worse failure than the one
  // this check exists to prevent.
  if (!model) return { ok: true }

  // An empty key is a real configuration rather than an omission, and it means
  // different things on the two products — so the endpoint is asked rather than
  // guessed. On Zen it is the free tier: `Bearer public` is what sst/opencode's
  // own plugin sends with no credential, the free ids answer it with real
  // completions, and the probe passes. Go has no free tier — there is not one
  // `-free` id in its 25-model catalog — so the same bearer is expected to come
  // back `AuthError`, which is exactly the verdict a Go user needs BEFORE a
  // session is built on it. That expectation is not hard-coded: if Go ever does
  // answer, the credential is accepted. What occ owns is the explanation
  // attached when it refuses.
  const check = await probe(
    { token: key || ZEN_PUBLIC_KEY, kind: 'key' },
    baseURL,
    model,
    signal,
  )
  if (check.ok) return { ok: true }
  return {
    ok: false,
    message: refusal({
      baseURL,
      product,
      hasKey: !anonymous,
      reason: check.reason,
    }),
  }
}

/**
 * A model id the probe can name.
 *
 * The live catalog first — it is the endpoint's own answer — then occ's shipped
 * table for the product. A free id is preferred when there is no key: the
 * public bearer is entitled to those and to nothing else, so probing a paid
 * model with it would be asking a different question than the one this check
 * exists to answer.
 */
function probeModel(
  models: CatalogModel[] | null,
  product: OpencodeProduct | undefined,
  anonymous: boolean,
): string | undefined {
  const listed = (models ?? [])
    .map(model => model.id.trim())
    .filter(id => id.length > 0)
  const candidates =
    listed.length > 0
      ? listed
      : product
        ? [...OPENCODE_PRODUCTS[product].models]
        : []
  return (
    (anonymous ? candidates.find(isFreeZenModel) : undefined) ?? candidates[0]
  )
}

/**
 * What the user is told, and why it cannot just be the service's own sentence.
 *
 * "Invalid API key." names nothing that can be acted on. The two facts that
 * make it actionable are which PRODUCT refused and at which URL — they are one
 * path segment apart on the same host, they are billed separately, and a key
 * for one is simply not a credential for the other. The way out has to be
 * spelled out too, because both of them (swap the base URL, or sign in with the
 * Console account instead) are one screen away and neither is discoverable from
 * a 401.
 *
 * The credential itself never appears here. It is not logged, not echoed, and
 * not persisted anywhere but the 0600 file the device flow writes.
 */
function refusal({
  baseURL,
  product,
  hasKey,
  reason,
}: {
  baseURL: string
  product: OpencodeProduct | undefined
  hasKey: boolean
  reason: string
}): string {
  const label = product ? OPENCODE_PRODUCTS[product].label : 'OpenCode'
  const other = product === 'go' ? 'zen' : product === 'zen' ? 'go' : undefined
  const parts = [
    `${label} (${baseURL}) refused ${
      hasKey ? 'this API key' : 'a request with no API key'
    }: ${reason}`,
  ]
  if (!hasKey) {
    parts.push(
      product === 'go'
        ? `${OPENCODE_PRODUCTS.go.label} has no free tier — all ${OPENCODE_PRODUCTS.go.models.length} of its models need a credential.`
        : "With the API Key field empty occ sends OpenCode's public bearer, which only the free models answer.",
    )
  }
  if (other) {
    const alternative = OPENCODE_PRODUCTS[other]
    parts.push(
      `${label} and ${alternative.label} are billed separately and neither covers the other; ` +
        `for ${alternative.label} (${alternative.billing}) put ${alternative.baseUrl} in Base URL instead.`,
    )
  }
  // No keystroke is named: the two hosts of this wizard recover differently
  // (the login flow shows an error screen that Enter dismisses back to the
  // form, `/models-setting` puts the form straight back with the message above
  // it), and a message that names the wrong key is worse than one that names
  // none.
  parts.push(
    'Nothing was configured. Correct the endpoint or the key and try again, ' +
      'or go back and sign in with an OpenCode Console account instead.',
  )
  return parts.join(' ')
}
