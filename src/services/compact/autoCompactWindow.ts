/**
 * Auto-compact window resolution (official 2.1.228 parity).
 *
 * The auto-compact window is "how full the context is allowed to get before
 * auto-summarization kicks in". It is NOT a context-window override: the model's
 * real window is resolved elsewhere (`getContextWindowForModel`, whose own
 * precedence chain is env > tiered settings > built-in default and must stay the
 * only such chain). This module only ever *narrows* that number — the effective
 * window is `min(modelContextWindow, configured)`.
 *
 * Precedence, with the official source labels attached so `/autocompact` can
 * explain where the active value came from:
 *
 *   env         CLAUDE_CODE_AUTO_COMPACT_WINDOW
 *   settings    settings.json `autoCompactWindow`
 *   clientdata  (unreachable in occ: no client-data plane)
 *   experiment  (unreachable in occ: GrowthBook is a no-op stub)
 *   model-default / unknown-model
 *               (unreachable in occ: upstream keys these off an internal table
 *                of small-window model ids plus a model-recognition oracle we
 *                deliberately do not carry — inventing one would silently move
 *                the compaction point for every third-party model)
 *   auto        no override; the model's own window is the window
 *
 * The label union is kept complete on purpose: `/autocompact`'s status text
 * renders every arm, so adding one of the currently-unreachable sources later
 * needs no change here or in the command.
 */

import { validateBoundedIntEnvVar } from '../../utils/config/envValidation.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  AUTO_COMPACT_WINDOW_ENV_VAR,
  AUTO_COMPACT_WINDOW_MAX_TOKENS,
  AUTO_COMPACT_WINDOW_MIN_TOKENS,
  normalizeAutoCompactWindowSetting,
} from './autoCompactWindowValue.js'

export {
  AUTO_COMPACT_WINDOW_ENV_VAR,
  AUTO_COMPACT_WINDOW_MAX_TOKENS,
  AUTO_COMPACT_WINDOW_MIN_TOKENS,
  normalizeAutoCompactWindowSetting,
  parseAutoCompactWindowInput,
} from './autoCompactWindowValue.js'

/** Official source labels, in the order they are consulted. */
export const AUTO_COMPACT_WINDOW_SOURCES = [
  'env',
  'settings',
  'clientdata',
  'experiment',
  'model-default',
  'unknown-model',
  'auto',
] as const

export type AutoCompactWindowSource =
  (typeof AUTO_COMPACT_WINDOW_SOURCES)[number]

export type ResolvedAutoCompactWindow = {
  /** Effective window actually used downstream: min(model window, configured). */
  window: number
  /** What the winning source asked for, before the model cap. */
  configured: number
  /** Which layer won. */
  source: AutoCompactWindowSource
}

export type AutoCompactWindowContext = {
  autoCompactWindow?: number
  autoCompactWindowOverride?: boolean
}

/**
 * Read `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, honouring the 100k–1M bounds.
 * Returns `undefined` when unset or unparseable, so the next layer wins.
 */
export function getAutoCompactWindowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[AUTO_COMPACT_WINDOW_ENV_VAR]
  if (!raw) {
    return undefined
  }
  const validated = validateBoundedIntEnvVar(
    AUTO_COMPACT_WINDOW_ENV_VAR,
    raw,
    AUTO_COMPACT_WINDOW_MIN_TOKENS,
    AUTO_COMPACT_WINDOW_MAX_TOKENS,
  )
  if (validated.status === 'invalid') {
    return undefined
  }
  return Math.max(AUTO_COMPACT_WINDOW_MIN_TOKENS, validated.effective)
}

/**
 * Resolve the effective auto-compact window.
 *
 * @param modelContextWindow the model's real context window, already resolved by
 *   `getContextWindowForModel`. This function never re-derives it.
 * @param settingsWindow raw `settings.autoCompactWindow` value (may be invalid).
 * @param env process env, injectable for tests.
 */
export function resolveAutoCompactWindow(
  modelContextWindow: number,
  settingsWindow?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAutoCompactWindow {
  const fromEnv = getAutoCompactWindowFromEnv(env)
  if (fromEnv !== undefined) {
    return {
      window: Math.min(modelContextWindow, fromEnv),
      configured: fromEnv,
      source: 'env',
    }
  }

  const fromSettings = normalizeAutoCompactWindowSetting(settingsWindow)
  if (fromSettings !== undefined) {
    return {
      window: Math.min(modelContextWindow, fromSettings),
      configured: fromSettings,
      source: 'settings',
    }
  }

  return {
    window: modelContextWindow,
    configured: modelContextWindow,
    source: 'auto',
  }
}

/** Raw `settings.autoCompactWindow`, unvalidated — resolve* decides what to do with it. */
function readAutoCompactWindowSetting(): number | undefined {
  const raw = getInitialSettings().autoCompactWindow
  return typeof raw === 'number' ? raw : undefined
}

/**
 * Resolve using the live settings file. The single entry point for production
 * callers; tests should prefer the pure `resolveAutoCompactWindow`.
 */
export function resolveActiveAutoCompactWindow(
  modelContextWindow: number,
  context?: AutoCompactWindowContext,
): ResolvedAutoCompactWindow {
  return resolveAutoCompactWindow(
    modelContextWindow,
    context
      ? context.autoCompactWindowOverride
        ? context.autoCompactWindow
        : (context.autoCompactWindow ?? readAutoCompactWindowSetting())
      : readAutoCompactWindowSetting(),
  )
}

export function resolveInitialAutoCompactWindow(
  cliWindow: number | 'auto' | undefined,
  settingsWindow: unknown = readAutoCompactWindowSetting(),
): AutoCompactWindowContext {
  if (cliWindow !== undefined) {
    return {
      autoCompactWindow: cliWindow === 'auto' ? undefined : cliWindow,
      autoCompactWindowOverride: true,
    }
  }
  return {
    autoCompactWindow: normalizeAutoCompactWindowSetting(settingsWindow),
    autoCompactWindowOverride: false,
  }
}

/** True when something is actively narrowing the window (i.e. not `auto`). */
export function isAutoCompactWindowOverridden(
  resolved: ResolvedAutoCompactWindow,
): boolean {
  return resolved.source !== 'auto'
}
