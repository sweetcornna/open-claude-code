/**
 * The `allow_remote_control` organization policy gate.
 *
 * Extracted from the full prerequisite check because it applies to strictly
 * more subcommands than the rest of it: `status` and `logout` must honour the
 * policy (status talks to the server), but must not be blocked by a stale
 * minimum-version or entitlement check — refusing to log out of a server the
 * policy already forbids would strand the stored credential.
 */
export async function checkRemoteControlPolicy(): Promise<string | null> {
  const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import(
    '../../services/policyLimits/index.js'
  )
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    return "Remote Control is disabled by your organization's policy."
  }
  return null
}
