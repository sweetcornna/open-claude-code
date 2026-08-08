import { feature } from 'bun:bundle'
import type { PermissionMode } from '../../../types/permissions.js'
import { isEnvTruthy } from '../../../utils/config/envUtils.js'
import { resolveInitialPermissionModeFallback } from '../../../utils/permissions/PermissionMode.js'
import { resolvePermissionMode } from '../utils.js'

/* eslint-disable @typescript-eslint/no-require-imports */
// Mirrors permissionSetup.ts: the auto-mode gate lives behind
// TRANSCRIPT_CLASSIFIER, so only pull the module in when the flag is compiled
// in. With the flag off the require never runs and auto is unreachable anyway.
const autoModeGateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../../utils/permissions/permissionSetup.js') as typeof import('../../../utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

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
      !isAcpBypassPermissionModeAvailable()
    ) {
      throw new Error(
        'Mode not available: bypassPermissions cannot run as root (start the agent as a non-root user, or set IS_SANDBOX=1).',
      )
    }

    return metaResolved
  }

  if (settingsMode === undefined || settingsMode === null) {
    return resolveAcpFallbackPermissionMode()
  }

  const settingsResolved = resolveConfiguredPermissionMode(settingsMode)
  return settingsResolved ?? 'default'
}

/**
 * Implicit mode for an ACP session that carries neither `_meta.permissionMode`
 * nor `permissions.defaultMode`.
 *
 * This used to be a bare `return 'auto'`, which reported a mode the session
 * could not actually honor: with TRANSCRIPT_CLASSIFIER compiled out the
 * classifier path is dead, and neither the auto-mode circuit breaker nor
 * CLAUDE_CODE_REMOTE were consulted. Route through the shared resolver so the
 * ACP surface obeys exactly the same guards as the CLI surface.
 *
 * ACP counts as an **interactive** session. `getIsNonInteractiveSession()` is
 * derived from TTY-ness (main.tsx), and `occ --acp` speaks JSON-RPC over piped
 * stdio, so that global reports "non-interactive" — but the ACP client owns a
 * live `session/request_permission` channel (see createAcpCanUseTool in
 * ../permissions.ts) and a human answers it in the editor. The headless
 * argument for forcing 'default' (no way to prompt ⇒ auto silently approves)
 * therefore does not apply here, so we pass `isNonInteractiveSession: false`
 * deliberately rather than reading the TTY-derived global.
 */
function resolveAcpFallbackPermissionMode(): PermissionMode {
  let autoModeSupported = false
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    autoModeSupported = true
  }

  return resolveInitialPermissionModeFallback({
    // Callers only reach here after establishing that neither
    // _meta.permissionMode nor permissions.defaultMode was supplied.
    hasExplicitPermissionMode: false,
    autoModeSupported,
    autoModeCircuitBroken:
      autoModeGateModule?.getAutoModeEnabledStateIfCached() === 'disabled',
    isRemote: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    isNonInteractiveSession: false,
  })
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

/**
 * Whether bypassPermissions is selectable by ACP clients.
 *
 * The previous implementation required a local opt-in (ACP_PERMISSION_MODE env var,
 * CLAUDE_CODE_ACP_ALLOW_BYPASS_PERMISSIONS env var, or settings.permissions.defaultMode).
 * That gate made the mode invisible to standard clients unless the operator already
 * pre-configured it — defeating the point of exposing it through the ACP mode list.
 *
 * The only remaining guard is the process-level one: bypass must not silently run
 * as root (where every skipped permission check is a privilege boundary crossed),
 * unless explicitly marked as a sandbox.
 */
export function isAcpBypassPermissionModeAvailable(): boolean {
  return isProcessBypassPermissionModeAvailable()
}

function isProcessBypassPermissionModeAvailable(): boolean {
  if (process.env.IS_SANDBOX) return true
  if (typeof process.geteuid === 'function') return process.geteuid() !== 0
  if (typeof process.getuid === 'function') return process.getuid() !== 0
  return true
}
