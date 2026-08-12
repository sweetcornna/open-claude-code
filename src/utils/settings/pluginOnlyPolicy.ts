import { isSafeMode } from '../config/envUtils.js'
import { getSettingsForSource } from './settings.js'
import type { CUSTOMIZATION_SURFACES } from './types.js'

export type CustomizationSurface = (typeof CUSTOMIZATION_SURFACES)[number]

/**
 * Check whether a customization surface is locked to plugin-only sources
 * by the managed `strictPluginOnlyCustomization` policy — or by `--safe-mode`.
 *
 * "Locked" means user-level (~/.occ/*) and project-level (.occ/*)
 * sources are skipped for that surface. Managed (policySettings) and
 * plugin-provided sources always load regardless — the policy is admin-set,
 * so managed sources are already admin-controlled, and plugins are gated
 * separately via `strictKnownMarketplaces`.
 *
 * `true` locks all four surfaces; array form locks only those listed.
 * Absent/undefined → nothing locked (the default).
 *
 * WHY SAFE MODE SHARES THIS PREDICATE
 *
 * `--safe-mode` wants precisely the same cut for skills/agents/hooks/mcp:
 * drop user- and project-authored definitions, keep the admin-managed ones
 * ("Admin-managed (policy) settings still apply"). The residual difference —
 * that this policy keeps plugin-provided items — is empty under safe mode,
 * because the plugin loader itself returns nothing there (see
 * `loadAllPlugins()` in utils/plugins/pluginLoader.ts). Routing safe mode
 * through the existing predicate means every surface loader that already
 * honours the policy honours safe mode too, with no second family of gates
 * to keep in sync.
 */
export function isRestrictedToPluginOnly(
  surface: CustomizationSurface,
): boolean {
  if (isSafeMode()) return true
  const policy =
    getSettingsForSource('policySettings')?.strictPluginOnlyCustomization
  if (policy === true) return true
  if (Array.isArray(policy)) return policy.includes(surface)
  return false
}

/**
 * Sources that bypass strictPluginOnlyCustomization. Admin-trusted because:
 *   plugin — gated separately by strictKnownMarketplaces
 *   policySettings — from managed settings, admin-controlled by definition
 *   built-in / builtin / bundled — ship with the CLI, not user-authored
 *
 * Everything else (userSettings, projectSettings, localSettings, flagSettings,
 * mcp, undefined) is user-controlled and blocked when the relevant surface
 * is locked. Covers both AgentDefinition.source ('built-in' with hyphen) and
 * Command.source ('builtin' no hyphen, plus 'bundled').
 */
const ADMIN_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  'plugin',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
])

/**
 * Whether a customization's source is admin-trusted under
 * strictPluginOnlyCustomization. Use this to gate frontmatter-hook
 * registration and similar per-item checks where the item carries a
 * source tag but the surface's filesystem loader already ran.
 *
 * Pattern at call sites:
 *   const allowed = !isRestrictedToPluginOnly(surface) || isSourceAdminTrusted(item.source)
 *   if (item.hooks && allowed) { register(...) }
 */
export function isSourceAdminTrusted(source: string | undefined): boolean {
  return source !== undefined && ADMIN_TRUSTED_SOURCES.has(source)
}
