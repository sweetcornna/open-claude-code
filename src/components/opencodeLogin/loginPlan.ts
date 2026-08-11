/**
 * What an OpenCode Console login writes, and what it hands to the model step.
 *
 * Pure, and separate from the screen, because the two decisions here are the
 * ones that are silently wrong rather than visibly wrong:
 *
 *   - which env keys a device login owns. It owns the two that ACTIVATE the
 *     provider, and it must clear `OPENCODE_API_KEY` — precedence is
 *     key-over-OAuth (services/auth/opencode/oauth.ts), so a key occ wrote on
 *     an earlier run would leave the login that just succeeded inert, with no
 *     symptom other than requests billed to the wrong credential.
 *   - that the model step it opens runs in model-only mode. The credential is
 *     an access token in a 0600 file that expires within the hour; the wizard
 *     writes its API-key field to `settings.env`, so handing it the token would
 *     persist a secret into a plain config file AND guarantee it is stale.
 *     `credentialEditing: 'locked'` is what stops that (savePlan.ts).
 */

import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import { OPENCODE_API_KEY_ENV } from 'src/services/auth/opencode/index.js'
import {
  OPENCODE_AUTH_MODE_ENV,
  OPENCODE_BASE_URL_ENV,
  OPENCODE_MODEL_ENV,
} from 'src/utils/model/opencodeWire.js'
import { PROVIDER_SETUP_SPECS } from 'src/components/providerSetup/specs.js'
import type { ProviderModelSetupStatus } from 'src/components/providerSetup/state.js'

/** Patch shape `updateSettingsForSource`/`applyProviderSaveEnv` both accept. */
export type OpencodeEnvPatch = Record<string, string | undefined>

/**
 * The env a Console device login owns.
 *
 * `OPENCODE_AUTH_MODE` is not a credential marker — it is the switch that
 * routes the session to OpenCode at all (opencodeWire.ts), so it is written by
 * the
 * key path too. What distinguishes this login is the absence of a key.
 */
export function buildOpencodeConsoleEnv(baseUrl: string): OpencodeEnvPatch {
  return {
    [OPENCODE_AUTH_MODE_ENV]: 'opencode',
    [OPENCODE_BASE_URL_ENV]: baseUrl,
    [OPENCODE_API_KEY_ENV]: undefined,
  }
}

/** One line naming the account, or undefined when the console said nothing. */
export function describeOpencodeAccount(account: {
  email?: string
  orgName?: string
}): string | undefined {
  const parts = [account.email, account.orgName].filter(
    (part): part is string => Boolean(part?.trim()),
  )
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export type OpencodeModelStepArgs = {
  /** Inference base URL the login configured. */
  baseUrl: string
  /** Entitlement/catalog answer, already lane-labelled; null when neither. */
  models: CatalogModel[] | null
  /** Max-context and effort as `prefillTierFields` reports them. */
  prefill: { maxContext: string; effort: string }
  /** Why the catalog is missing, for the manual fallback's banner. */
  fetchError?: string
  env?: NodeJS.ProcessEnv
}

/**
 * The model step to open once the tokens are stored.
 *
 * Seeded from the OPENCODE_* keys rather than from the login, so re-running it
 * shows the configuration the session is actually on. Values the catalog does
 * not list are dropped for the same reason `buildModelStep` drops them: a model
 * this account cannot reach must not stay selected just because it used to be.
 */
export function buildOpencodeModelStep({
  baseUrl,
  models,
  prefill,
  fetchError,
  env = process.env,
}: OpencodeModelStepArgs): ProviderModelSetupStatus {
  const tiers = PROVIDER_SETUP_SPECS.opencode.env.tiers
  const ids = new Set(models?.map(model => model.id) ?? [])
  const keep = (value: string | undefined): string => {
    const trimmed = value?.trim() ?? ''
    if (!trimmed) return ''
    return !models || ids.has(trimmed) ? trimmed : ''
  }

  const base = {
    state: 'provider_model_setup' as const,
    kind: 'opencode' as const,
    baseUrl,
    // Deliberately empty: the credential is the stored token, and this field is
    // what gets written to settings.env.
    apiKey: '',
    credentialEditing: 'locked' as const,
    model: keep(env[OPENCODE_MODEL_ENV]),
    maxContext: prefill.maxContext,
    effort: prefill.effort,
    haikuModel: keep(env[tiers.haiku_model]),
    sonnetModel: keep(env[tiers.sonnet_model]),
    opusModel: keep(env[tiers.opus_model]),
    fableModel: keep(env[tiers.fable_model]),
    activeField: 'model' as const,
  }

  if (!models || models.length === 0) {
    return {
      ...base,
      entryMode: 'manual',
      fetchError: fetchError ?? 'the model list could not be read',
    }
  }
  return { ...base, entryMode: 'catalog', models }
}
