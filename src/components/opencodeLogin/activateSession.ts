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
  /**
   * Inference base URL this session will use.
   *
   * For a Console login that is `provider.opencode.api` out of `/api/config`,
   * not a product constant — the OAuth token is accepted there and refused by
   * Zen, so the constant was the bug. It falls back to the chosen product's URL
   * only when the console described no provider at all.
   */
  baseUrl: string
  /** That product's display name, for the refusal message. */
  label: string
  /** The other product's name, so the message can point somewhere. */
  otherLabel: string
  /** Live access token; never persisted outside the 0600 credential file. */
  accessToken: string
  /**
   * Set when `baseUrl` came from the console's own config.
   *
   * Carried into `OPENCODE_INFERENCE_PLANE` so the mirror stops choosing lanes:
   * that plane is OpenAI-compatible only.
   */
  plane?: 'console'
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
  plane?: 'console',
): string {
  // On the Console plane the two-products sentence would be a lie: that
  // endpoint is the account's own inference proxy, named by the console itself,
  // so there is no sibling product to switch to and nothing about credit
  // balances to explain. What is left to say is that the credential was refused
  // at the endpoint the console pointed at.
  if (plane === 'console') {
    return (
      `Signed in, but the OpenCode Console refused the account at its own inference endpoint (${baseUrl}): ${reason} ` +
      'Nothing was configured — press Enter to retry, or Esc to use an API key instead.'
    )
  }
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
  plane,
  access,
}: OpencodeActivationArgs): OpencodeActivation {
  if (!access.ok) {
    return {
      activated: false,
      message: refusal(label, otherLabel, baseUrl, access.reason, plane),
    }
  }

  // `applyProviderSaveEnv` rather than a plain loop so clearing
  // OPENCODE_API_KEY takes back only what occ itself wrote — a key exported in
  // the user's shell is theirs, and occ hands the whole environment to every
  // Bash tool call.
  const previous = getSettingsForSource('userSettings')
  const env = buildOpencodeConsoleEnv(baseUrl, plane)
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
  // The endpoint goes into the runtime slot alongside the token so the very
  // first request of this session is built from the console's own answer rather
  // than from whatever `OPENCODE_BASE_URL` held a moment ago. The 0600 file
  // carries the same value for every later process.
  setOpencodeRuntimeCredential(accessToken, {
    ...(plane === 'console' ? { baseUrl } : {}),
  })
  applyOpencodeWire()
  // Switching provider mid-session must also tear down a DeepSeek mirror left
  // by a previous configuration; the apply releases its own claim before
  // deciding again, so this is the teardown too.
  applyDeepSeekAnthropicWire()
  return { activated: true }
}
