import type { SettingsJson } from '../settings/types.js'

type ComputerUseSettings = Pick<SettingsJson, 'computerUse'>

/**
 * The builtin backend is the compatibility default. External mode removes all
 * name-based builtin behavior so a user-configured stdio server can use the
 * normal MCP connection and permission pipeline.
 */
export function isBuiltinComputerUseBackend(
  settings: ComputerUseSettings,
): boolean {
  return settings.computerUse?.backend !== 'external'
}
