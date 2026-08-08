import z from 'zod/v4'
import { PAUSE_ICON } from '../../constants/figures.js'
// Types extracted to src/types/permissions.ts to break import cycles
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../types/permissions.js'
import { lazySchema } from '../collections/lazySchema.js'

// Re-export for backwards compatibility
export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
}

export const permissionModeSchema = lazySchema(() => z.enum(PERMISSION_MODES))
export const externalPermissionModeSchema = lazySchema(() =>
  z.enum(EXTERNAL_PERMISSION_MODES),
)

type ModeColorKey =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

const PERMISSION_MODE_CONFIG: Partial<
  Record<PermissionMode, PermissionModeConfig>
> = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  auto: {
    title: 'Auto',
    shortTitle: 'Auto',
    symbol: '⏵⏵',
    color: 'warning' as ModeColorKey,
    external: 'default' as ExternalPermissionMode,
  },
}

/**
 * Type guard to check if a PermissionMode is an ExternalPermissionMode.
 * auto is ant-only and excluded from external modes.
 */
export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  // External users can't have auto, so always true for them
  if (process.env.USER_TYPE !== 'ant') {
    return true
  }
  return mode !== 'auto' && mode !== 'bubble'
}

function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return getModeConfig(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default'
}

/**
 * Picks the permission mode for a session that carries **no** explicit
 * preference (no CLI flag, no `permissions.defaultMode`). Explicit
 * configuration never reaches this function — it wins everywhere, including in
 * headless sessions.
 *
 * `auto` hands approval to the transcript classifier, so every guard below is a
 * precondition for that being a real (and safe) delegation:
 *
 * - `autoModeSupported` — with `TRANSCRIPT_CLASSIFIER` compiled out the
 *   classifier path is dead code; reporting `auto` would be pure decoration.
 * - `autoModeCircuitBroken` — the classifier was kicked out; don't re-enter.
 * - `isRemote` — CCR only supports acceptEdits/plan.
 * - `isNonInteractiveSession` — `-p` / headless / SDK sessions cannot show a
 *   permission prompt, so `default` degrades to "deny and report" while `auto`
 *   would silently let the classifier approve writes and command execution in
 *   CI. Matching upstream Claude Code, unattended runs must opt in explicitly
 *   via `--permission-mode` or `--dangerously-skip-permissions`.
 *
 * Callers pass `isNonInteractiveSession` rather than having this module read
 * `getIsNonInteractiveSession()` directly: that global is derived from
 * TTY-ness, which is the wrong signal for front ends that own their own
 * prompting channel (see the ACP agent, which pipes stdio yet can prompt).
 */
export function resolveInitialPermissionModeFallback({
  hasExplicitPermissionMode,
  autoModeSupported,
  autoModeCircuitBroken,
  isRemote,
  isNonInteractiveSession,
}: {
  hasExplicitPermissionMode: boolean
  autoModeSupported: boolean
  autoModeCircuitBroken: boolean
  isRemote: boolean
  isNonInteractiveSession: boolean
}): PermissionMode {
  return !hasExplicitPermissionMode &&
    autoModeSupported &&
    !autoModeCircuitBroken &&
    !isRemote &&
    !isNonInteractiveSession
    ? 'auto'
    : 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  return getModeConfig(mode).shortTitle
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}
