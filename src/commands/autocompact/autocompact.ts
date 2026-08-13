/**
 * `/autocompact` — inspect and set the auto-compact window (official 2.1.228 parity).
 *
 * The window is the fullness threshold that triggers auto-summarization. It is
 * NOT a context-window override: the effective value is always
 * `min(model context window, configured)`, and the model's window keeps coming
 * from `getContextWindowForModel` alone.
 */

import { getSdkBetas } from '../../bootstrap/state.js'
import {
  AUTO_COMPACT_WINDOW_ENV_VAR,
  AUTO_COMPACT_WINDOW_MAX_TOKENS,
  AUTO_COMPACT_WINDOW_MIN_TOKENS,
  type AutoCompactWindowSource,
  parseAutoCompactWindowInput,
  resolveActiveAutoCompactWindow,
  type ResolvedAutoCompactWindow,
} from '../../services/compact/autoCompactWindow.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import type { ModelSettingsSlot } from '../../utils/model/modelTier.js'
import { getContextWindowForModel } from '../../utils/session/context.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { formatTokens } from '../../utils/text/format.js'

/** Words that mean "go back to tracking the model window". */
const RESET_WORDS = new Set(['auto', 'reset', 'unset', 'default'])

function describeSource(
  source: AutoCompactWindowSource,
  configured: number,
  cappedSuffix: string,
): string {
  switch (source) {
    case 'auto':
      return 'auto'
    case 'experiment':
    case 'clientdata':
      return `auto (${formatTokens(configured)} tokens)${cappedSuffix}`
    case 'env':
      return `${formatTokens(configured)} tokens (from ${AUTO_COMPACT_WINDOW_ENV_VAR})${cappedSuffix}`
    case 'unknown-model':
      return `${formatTokens(configured)} tokens (default for an unrecognized model)${cappedSuffix}`
    case 'model-default':
      return `${formatTokens(configured)} tokens (default for this model)${cappedSuffix}`
    case 'settings':
      return `${formatTokens(configured)} tokens (from settings)${cappedSuffix}`
  }
}

/** Render the no-argument status panel. */
export function formatAutoCompactWindowStatus(
  resolved: ResolvedAutoCompactWindow,
  autoCompactEnabled: boolean,
): string {
  const { window, configured, source } = resolved
  const cappedSuffix =
    configured > window ? ` · capped to ${formatTokens(window)} by model` : ''

  const lines = [
    `Auto-compact window: ${describeSource(source, configured, cappedSuffix)}`,
  ]
  if (!autoCompactEnabled) {
    lines.push('Auto-compact is currently disabled (see /config)')
  }
  lines.push(
    "Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.",
  )
  lines.push(
    'The auto setting picks a window tuned for your model and is strongly recommended for the best cost and performance.',
  )
  if (source === 'env' || source === 'settings') {
    lines.push(
      'Overriding auto may result in high token usage, especially when resuming long sessions.',
    )
  }
  return lines.join('\n')
}

function modelContextWindow(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): number {
  return getContextWindowForModel(model, getSdkBetas(), settingsSlot)
}

/**
 * Apply a new window value. Returns the user-facing result text.
 *
 * The env var wins over settings, so writing settings while the env var is set
 * would silently do nothing — we refuse instead of pretending it took effect.
 */
export function applyAutoCompactWindow(
  rawArgs: string,
  model: string,
  settingsSlot?: ModelSettingsSlot,
  onApplied?: (value: number | undefined) => void,
): string {
  const window = modelContextWindow(model, settingsSlot)
  if (resolveActiveAutoCompactWindow(window).source === 'env') {
    return `${AUTO_COMPACT_WINDOW_ENV_VAR} is set and takes precedence. Unset it to change this setting.`
  }

  const normalized = rawArgs.trim().toLowerCase()
  const parsed = RESET_WORDS.has(normalized)
    ? 'auto'
    : parseAutoCompactWindowInput(normalized)

  if (parsed === undefined) {
    return (
      `Couldn't parse '${rawArgs.trim()}'. Expected 'auto' or ` +
      `${formatTokens(AUTO_COMPACT_WINDOW_MIN_TOKENS)}–${formatTokens(AUTO_COMPACT_WINDOW_MAX_TOKENS)} tokens ` +
      `(e.g. 500k, 200000, or 200 as shorthand)`
    )
  }

  const value = parsed === 'auto' ? undefined : parsed
  const { error } = updateSettingsForSource('userSettings', {
    autoCompactWindow: value,
  })
  if (error) {
    return `Couldn't save setting: ${error.message}`
  }

  // Re-read: a higher-priority source (or a project/policy settings file that
  // out-ranks userSettings) may still be dictating the effective value, and
  // saying "set to X" when X is not what runs is the bug worth avoiding here.
  const effectiveSetting = getInitialSettings().autoCompactWindow
  onApplied?.(effectiveSetting)
  const after = resolveActiveAutoCompactWindow(window, {
    autoCompactWindow: effectiveSetting,
    autoCompactWindowOverride: true,
  })
  const overridden = after.source === 'env' || effectiveSetting !== value

  if (parsed === 'auto') {
    return overridden
      ? `Auto-compact window set to auto in settings, but a higher-priority override is active (${formatTokens(after.window)} tokens)`
      : 'Auto-compact window set to auto'
  }

  let suffix = ''
  if (overridden) {
    suffix = `, but a higher-priority override is active (${formatTokens(after.window)} tokens)`
  } else if (after.window < parsed) {
    suffix = ` (capped to model limit of ${formatTokens(after.window)})`
  }
  return `Auto-compact window set to ${formatTokens(parsed)} tokens${suffix}`
}

export const call: LocalCommandCall = async (
  args,
  context,
): Promise<LocalCommandResult> => {
  const model = context.options.mainLoopModel
  const settingsSlot = context.options.modelSettingsSlot
  const trimmed = args.trim()

  if (!trimmed) {
    const state = context.getAppState()
    const resolved = resolveActiveAutoCompactWindow(
      modelContextWindow(model, settingsSlot),
      {
        autoCompactWindow: state.autoCompactWindow,
        autoCompactWindowOverride: state.autoCompactWindowOverride,
      },
    )
    return {
      type: 'text',
      value: formatAutoCompactWindowStatus(resolved, isAutoCompactEnabled()),
    }
  }

  return {
    type: 'text',
    value: applyAutoCompactWindow(trimmed, model, settingsSlot, value => {
      context.setAppState(prev => ({
        ...prev,
        autoCompactWindow: value,
        autoCompactWindowOverride: true,
      }))
    }),
  }
}
