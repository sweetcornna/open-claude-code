/**
 * Turning a verified OpenCode credential into an active session — or refusing
 * to.
 *
 * Out of the screen for the reason savePlan.ts gives: the rule here is one an
 * Ink render cannot exercise, so left inside the component it was never
 * exercised at all. And the rule is the whole fix — a sign-in that cannot be
 * used must write NOTHING. Every write below activates the provider somewhere a
 * later reader trusts (`settings.json`, `process.env`, the mirror's claim
 * table), and doing any of them for a credential the endpoint refuses produces
 * the worst available outcome: a REPL that looks configured, names a model, and
 * answers `API Error [OpenAI]: Invalid API key` to everything — which reads as
 * a broken provider rather than a failed login.
 *
 * So the refusal is a return value, not an exception, and it comes before the
 * first write rather than after the last one.
 */

import { applyProviderSaveEnv } from 'src/components/providerSetup/savePlan.js'
import type { OpencodeAccessCheck } from 'src/services/auth/opencode/index.js'
import { applyDeepSeekAnthropicWire } from 'src/utils/model/deepseekWire.js'
import {
  applyOpencodeWire,
  setOpencodeRuntimeCredential,
} from 'src/utils/model/opencodeWire.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/utils/settings/settings.js'
import { buildOpencodeConsoleEnv } from './loginPlan.js'

export type OpencodeActivation =
  | { activated: true }
  | { activated: false; message: string }

export type OpencodeActivationArgs = {
  /** Inference base URL of the product the user chose. */
  baseUrl: string
  /** That product's display name, for the refusal message. */
  label: string
  /** The other product's name, so the message can point somewhere. */
  otherLabel: string
  /** Live access token; never persisted outside the 0600 credential file. */
  accessToken: string
  /** Verdict from verifyOpencodeAccess. */
  access: OpencodeAccessCheck
}

/**
 * What the user is told when the endpoint refuses the account.
 *
 * It has to name the PRODUCT and the URL. The service's own message says only
 * "Invalid API key", which for someone who just completed a browser sign-in is
 * actively misleading — there is no key, the sign-in worked, and the thing that
 * failed is entitlement to one of two endpoints that differ by a single path
 * segment. Without those two facts there is nothing to act on.
 */
function refusal(
  label: string,
  otherLabel: string,
  baseUrl: string,
  reason: string,
): string {
  return (
    `Signed in, but ${label} refused the account: ${reason} ` +
    `${label} (${baseUrl}) is billed separately, and a subscription to ${otherLabel} does not cover it. ` +
    `Nothing was configured — retry, or press Esc to pick ${otherLabel} or an API key instead.`
  )
}

export function activateOpencodeConsoleSession({
  baseUrl,
  label,
  otherLabel,
  accessToken,
  access,
}: OpencodeActivationArgs): OpencodeActivation {
  if (!access.ok) {
    return {
      activated: false,
      message: refusal(label, otherLabel, baseUrl, access.reason),
    }
  }

  // `applyProviderSaveEnv` rather than a plain loop so clearing
  // OPENCODE_API_KEY takes back only what occ itself wrote — a key exported in
  // the user's shell is theirs, and occ hands the whole environment to every
  // Bash tool call.
  const previous = getSettingsForSource('userSettings')
  const env = buildOpencodeConsoleEnv(baseUrl)
  const { error } = updateSettingsForSource('userSettings', {
    modelType: 'opencode',
    env,
  } as unknown as Parameters<typeof updateSettingsForSource>[1])
  if (error) {
    return {
      activated: false,
      message: 'Failed to save settings. Please try again.',
    }
  }
  applyProviderSaveEnv(env, previous?.env, process.env)
  setOpencodeRuntimeCredential(accessToken)
  applyOpencodeWire()
  // Switching provider mid-session must also tear down a DeepSeek mirror left
  // by a previous configuration; the apply releases its own claim before
  // deciding again, so this is the teardown too.
  applyDeepSeekAnthropicWire()
  return { activated: true }
}
