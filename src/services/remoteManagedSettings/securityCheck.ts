/**
 * Managed-settings security check — disabled in the open-source build.
 *
 * The interactive approval dialog this used to render belongs to a
 * remote-managed-settings deployment story that occ does not ship, so the check
 * always passes. It stays as a named seam rather than being inlined at the call
 * site so a deployment that does need it has one obvious place to implement.
 *
 * Previously this was a hand-written `securityCheck.jsx` stub shadowing an
 * 85-line `securityCheck.tsx` that rendered the real dialog: the import
 * specifier decided which one ran, the TypeScript everyone read was not the
 * code that shipped, and the dialog it pulled in was dead weight nothing could
 * reach. What is here now is what runs.
 */

import type { SettingsJson } from '../../utils/settings/types.js'

export type SecurityCheckResult = 'approved' | 'rejected' | 'no_check_needed'

/**
 * Parameters are kept so the seam matches what a real implementation needs —
 * the previous and incoming settings it would have to diff.
 */
export async function checkManagedSettingsSecurity(
  _cachedSettings: SettingsJson | null,
  _newSettings: SettingsJson,
): Promise<SecurityCheckResult> {
  return 'no_check_needed'
}

/** True when the caller may proceed with the synced settings. */
export function handleSecurityCheckResult(
  _result: SecurityCheckResult,
): boolean {
  return true
}
