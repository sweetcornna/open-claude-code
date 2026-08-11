/**
 * Pure argument parsing and persistence for /model-settings (alias
 * /models-setting).
 *
 * Split from the component the way EffortPanel splits effortPanelState, so the
 * rules are testable without rendering: what the user typed, what it means,
 * and what lands in settings.json.
 */

import {
  MODEL_SETTINGS_SLOTS,
  type ModelSettingsSlot,
} from '../../utils/model/modelTier.js'
import type { TierEffort } from '../../utils/model/tierDefaults.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const EFFORT_LEVELS: readonly TierEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export type ParsedCommand =
  | { kind: 'panel' }
  | { kind: 'show' }
  | {
      kind: 'set'
      tier: ModelSettingsSlot
      effort?: TierEffort
      contextTokens?: number
    }
  | { kind: 'reset'; tier: ModelSettingsSlot }
  | { kind: 'error'; message: string }

/**
 * Accepts `128000`, `128k`, `1m`. Mirrors parseMaxContextInput's vocabulary so
 * the two entry points agree; kept local because that module is wired into the
 * provider-setup wizard's tri-state form semantics, which do not apply here.
 */
export function parseContextTokens(raw: string): number | undefined {
  const text = raw.trim().toLowerCase()
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text)
  if (!m) return undefined
  const value = Number.parseFloat(m[1]!)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const scale = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1
  const tokens = Math.round(value * scale)
  return tokens > 0 ? tokens : undefined
}

export function parseArgs(args: string | undefined): ParsedCommand {
  const parts = (args ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { kind: 'panel' }
  if (parts[0] === 'show' || parts[0] === 'current') return { kind: 'show' }

  const tier = parts[0]!.toLowerCase() as ModelSettingsSlot
  if (!(MODEL_SETTINGS_SLOTS as readonly string[]).includes(tier)) {
    return {
      kind: 'error',
      message: `Unknown settings slot "${parts[0]}". Expected one of: ${MODEL_SETTINGS_SLOTS.join(', ')}.`,
    }
  }
  if (parts.length === 1) return { kind: 'error', message: usage() }
  // Lowercase the verb too — the tier was already normalised above, and a
  // half-normalised parser is exactly the kind of thing that reads as "the
  // command silently did nothing".
  const verb = parts[1]!.toLowerCase()
  if (verb === 'reset') return { kind: 'reset', tier }

  if (verb === 'effort') {
    const level = (parts[2] ?? '').toLowerCase() as TierEffort
    if (!EFFORT_LEVELS.includes(level)) {
      return {
        kind: 'error',
        message: `Unknown effort "${parts[2] ?? ''}". Expected one of: ${EFFORT_LEVELS.join(', ')}.`,
      }
    }
    return { kind: 'set', tier, effort: level }
  }

  if (verb === 'context') {
    const tokens = parseContextTokens(parts[2] ?? '')
    if (tokens === undefined) {
      return {
        kind: 'error',
        message: `Could not read "${parts[2] ?? ''}" as a token count. Try 200000, 272k or 1m.`,
      }
    }
    return { kind: 'set', tier, contextTokens: tokens }
  }

  return { kind: 'error', message: usage() }
}

export function usage(): string {
  return [
    'Usage:',
    '  /model-settings                         edit models, effort and context',
    '  /model-settings show                    print the effective values',
    '  /model-settings default effort max      set the provider default',
    '  /model-settings opus effort max         set effort for one tier',
    '  /model-settings opus context 1m         set the window (200000 / 272k / 1m)',
    '  /model-settings opus reset              drop this slot’s overrides',
  ].join('\n')
}

/**
 * Persist one tier's overrides.
 *
 * Also clears the legacy flat `effortLevel` whenever a per-tier effort is
 * written. That key seeds AppState at startup and AppState outranks the
 * per-tier layer, so leaving it would produce the worst possible outcome: the
 * user sets a value here and nothing changes. One-way migration, documented.
 */
export function writeTierSettings(
  tier: ModelSettingsSlot,
  patch: { effort?: TierEffort; contextTokens?: number },
): { error: Error | null } {
  const current = getSettingsForSource('userSettings')?.modelSettings ?? {}
  const existing = current[tier] ?? {}
  const next = { ...current, [tier]: { ...existing, ...patch } }
  return updateSettingsForSource('userSettings', {
    modelSettings: next,
    ...(patch.effort !== undefined ? { effortLevel: undefined } : {}),
  })
}

export function resetTierSettings(tier: ModelSettingsSlot): {
  error: Error | null
} {
  const current = getSettingsForSource('userSettings')?.modelSettings ?? {}
  return updateSettingsForSource('userSettings', {
    modelSettings: { ...current, [tier]: undefined },
  })
}
