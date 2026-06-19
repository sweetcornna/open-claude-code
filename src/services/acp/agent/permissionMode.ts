import type { PermissionMode } from '../../../types/permissions.js'
import { resolvePermissionMode } from '../utils.js'

export const permissionModeIds: readonly PermissionMode[] = [
  'auto',
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'plan',
]

export function isPermissionMode(modeId: string): modeId is PermissionMode {
  return (permissionModeIds as readonly string[]).includes(modeId)
}

export function resolveSessionPermissionMode(
  metaMode: unknown,
  hasMetaMode: boolean,
  settingsMode: unknown,
): PermissionMode {
  if (hasMetaMode) {
    const metaResolved = resolveRequiredPermissionMode(
      metaMode,
      '_meta.permissionMode',
    )
    if (
      metaResolved === 'bypassPermissions' &&
      !isAcpBypassPermissionModeAvailable(settingsMode)
    ) {
      throw new Error(
        'Mode not available: bypassPermissions requires a local ACP bypass opt-in.',
      )
    }

    return metaResolved
  }

  const settingsResolved = resolveConfiguredPermissionMode(settingsMode)
  return settingsResolved ?? 'default'
}

function resolveRequiredPermissionMode(
  mode: unknown,
  source: string,
): PermissionMode {
  if (mode === undefined || mode === null) {
    throw new Error(`Invalid ${source}: expected a string.`)
  }

  return resolvePermissionMode(mode, source) as PermissionMode
}

function resolveConfiguredPermissionMode(
  mode: unknown,
): PermissionMode | undefined {
  if (mode === undefined || mode === null) return undefined

  try {
    return resolvePermissionMode(
      mode,
      'permissions.defaultMode',
    ) as PermissionMode
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(
      '[ACP] Invalid permissions.defaultMode, using default:',
      reason,
    )
    return undefined
  }
}

export function hasOwnField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return !!value && Object.hasOwn(value, key)
}

export function isAcpBypassPermissionModeAvailable(
  settingsMode?: unknown,
): boolean {
  return (
    isProcessBypassPermissionModeAvailable() &&
    (isAcpBypassLocallyEnabled() ||
      isSettingsBypassPermissionMode(settingsMode))
  )
}

function isProcessBypassPermissionModeAvailable(): boolean {
  if (process.env.IS_SANDBOX) return true
  if (typeof process.geteuid === 'function') return process.geteuid() !== 0
  if (typeof process.getuid === 'function') return process.getuid() !== 0
  return true
}

function isAcpBypassLocallyEnabled(): boolean {
  return (
    process.env.ACP_PERMISSION_MODE === 'bypassPermissions' ||
    isTruthyEnv(process.env.CLAUDE_CODE_ACP_ALLOW_BYPASS_PERMISSIONS)
  )
}

function isSettingsBypassPermissionMode(settingsMode: unknown): boolean {
  try {
    return resolvePermissionMode(settingsMode) === 'bypassPermissions'
  } catch {
    return false
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}
