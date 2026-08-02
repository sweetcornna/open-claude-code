import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { getPlatform } from '../process/platform.js'

/**
 * Get the path to the managed settings directory based on the current platform.
 *
 * These are occ's OWN enterprise policy locations, not Claude Code's.
 *
 * That distinction is deliberate and worth stating plainly: an MDM profile or
 * managed-settings.json deployed for Anthropic's Claude Code does NOT govern
 * occ, and occ does not read it. occ is a different binary from a different
 * publisher; silently obeying another product's policy file would be both
 * surprising and wrong (those policies can reference Anthropic-specific
 * infrastructure). Administrators who want to manage occ deploy policy to the
 * paths below, or point `OCC_MANAGED_SETTINGS_PATH` at their own location.
 */
export const getManagedFilePath = memoize(function (): string {
  // Ungated on purpose. The original only honoured its override when
  // USER_TYPE === 'ant', which meant no external administrator could relocate
  // the policy file at all — fine for a first-party build with an internal
  // fleet, useless for anyone actually deploying this.
  if (process.env.OCC_MANAGED_SETTINGS_PATH) {
    return process.env.OCC_MANAGED_SETTINGS_PATH
  }

  // Deprecated fallback, kept so existing ant-internal setups keep working.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  ) {
    return process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  }

  switch (getPlatform()) {
    case 'macos':
      return '/Library/Application Support/OpenClaudeCode'
    case 'windows':
      return 'C:\\Program Files\\OpenClaudeCode'
    default:
      return '/etc/occ'
  }
})

/**
 * Get the path to the managed-settings.d/ drop-in directory.
 * managed-settings.json is merged first (base), then files in this directory
 * are merged alphabetically on top (drop-ins override base, later files win).
 */
export const getManagedSettingsDropInDir = memoize(function (): string {
  return join(getManagedFilePath(), 'managed-settings.d')
})
