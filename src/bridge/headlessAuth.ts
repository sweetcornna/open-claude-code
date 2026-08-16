/**
 * Credential gate for the non-interactive bridge entrypoints.
 *
 * `bridgeMain()` runs account preparation before it looks for a token: on an
 * account-mode server a fresh process legitimately starts with nothing in
 * memory, and the stored refresh credential is what turns that into an access
 * token. The daemon's `remoteControl` worker skipped that step, so with the
 * default public server it saw an empty token store and reported the claude.ai
 * login error — advice that cannot fix an account-server problem.
 *
 * Kept in its own leaf module (rather than inline in `bridgeMain.ts`) so the
 * decision can be tested against injected fakes without pulling the 3k-line
 * bridge, and so both entrypoints answer the question the same way.
 */

import { BIN_NAME } from '../constants/brand.js'
import { errorMessage } from '../utils/runtime/errors.js'
import { BRIDGE_LOGIN_ERROR } from './types.js'

/** The subset of `RemoteControlAuthPreparation` this gate reads. */
export type HeadlessAuthPreparation = {
  status: 'authenticated' | 'login_required' | 'legacy'
}

type HeadlessCredentialDeps = {
  /** True for anything that is not Anthropic's own bridge. */
  selfHosted: boolean
  baseUrl: string
  /**
   * `prepareRemoteControlAuthentication`. Restores the base-URL-scoped stored
   * credential and exchanges the refresh token for an access token, so it is
   * the step that populates what `getAccessToken` reads.
   */
  prepare: (baseUrl: string) => Promise<HeadlessAuthPreparation>
  getAccessToken: () => string | undefined
}

/**
 * Establish an account credential for a headless bridge, or throw with an
 * error the operator can act on.
 *
 * Every failure is a plain `Error`, not `BridgeHeadlessPermanentError`: the
 * daemon supervisor retries those with backoff and parks after repeated rapid
 * failures, which is the behaviour we want. A worker that starts before the
 * user logs in should pick the credential up on a later cycle rather than
 * needing a manual unpark.
 */
export async function ensureHeadlessBridgeCredential(
  deps: HeadlessCredentialDeps,
): Promise<void> {
  const { selfHosted, baseUrl, prepare, getAccessToken } = deps

  if (selfHosted) {
    let prepared: HeadlessAuthPreparation
    try {
      prepared = await prepare(baseUrl)
    } catch (error) {
      // Unreachable or misconfigured server. Transient by nature, and naming
      // the URL is the difference between a fixable report and a mystery.
      throw new Error(
        `Unable to reach the Remote Control server at ${baseUrl}: ${errorMessage(error)}`,
      )
    }
    if (prepared.status === 'login_required') {
      throw new Error(
        `auth_required: no Remote Control account credential for ${baseUrl}. ` +
          `Run \`${BIN_NAME}\` and use \`/remote-control login\`, then restart the daemon worker.`,
      )
    }
  }

  if (!getAccessToken()) {
    throw new Error(
      selfHosted
        ? `The Remote Control server at ${baseUrl} did not provide a usable login. ` +
            'It may be running a pre-0.2 build that has no account support.'
        : BRIDGE_LOGIN_ERROR,
    )
  }
}
