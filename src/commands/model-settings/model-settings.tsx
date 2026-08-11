import * as React from 'react';
import { buildModelStepFromEnvironment } from '../../components/providerSetup/fromEnvironment.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import {
  getModelTier,
  MODEL_SETTINGS_SLOTS,
  type ModelSettingsSlot,
  type ModelTier,
} from '../../utils/model/modelTier.js';
import { getTierDefaults } from '../../utils/model/tierDefaults.js';
import { formatContextTokens, getTierOverride } from '../../utils/model/tierSettings.js';
import { getDefaultMainLoopModel, getMainLoopModel } from '../../utils/model/model.js';
import { parseUserSpecifiedModel } from '../../utils/model/model.js';
import { parseArgs, resetTierSettings, usage, writeTierSettings } from './state.js';
import { ModelTierSetup } from './tierWizard.js';

const COMMON_HELP_ARGS = ['help', '--help', '-h', '?'];

/** Human-readable summary of what each tier resolves to right now. */
function describeAll(): string {
  const lines = ['Model settings (env still wins over these):', ''];
  const models = new Map<string, ModelTier[]>();
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const model = safeResolve(slot);
    const tier = slot === 'default' ? undefined : slot;
    const defaults = getTierDefaults(model, tier);
    const override = getTierOverride(slot);
    const effort = override?.effort ?? defaults.effort;
    const tokens = override?.contextTokens ?? defaults.contextTokens;
    const marks = [
      override?.effort !== undefined ? 'effort set' : undefined,
      override?.contextTokens !== undefined ? 'context set' : undefined,
    ].filter(Boolean);
    const suffix = marks.length > 0 ? `  (${marks.join(', ')})` : '  (defaults)';
    lines.push(
      `  ${slot.padEnd(7)} ${model.padEnd(24)} effort=${effort.padEnd(6)} context=${formatContextTokens(tokens)}${suffix}`,
    );
    if (tier) models.set(model, [...(models.get(model) ?? []), tier]);
  }
  lines.push(...shadowWarnings(), ...ambiguityWarnings(models), '', usage());
  return lines.join('\n');
}

/**
 * Both env knobs outrank everything written here, and the flat `effortLevel`
 * seeds AppState, which also outranks it. Saying nothing would leave the user
 * setting a value and watching nothing happen — the exact failure this command
 * exists to fix.
 */
function shadowWarnings(): string[] {
  const warnings: string[] = [];
  const contextEnv = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (contextEnv) {
    warnings.push(`  ! CLAUDE_CODE_MAX_CONTEXT_TOKENS=${contextEnv} overrides every context value above.`);
  }
  const effortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  if (effortEnv) {
    warnings.push(`  ! CLAUDE_CODE_EFFORT_LEVEL=${effortEnv} overrides every effort value above.`);
  }
  return warnings.length > 0 ? ['', ...warnings] : [];
}

/**
 * Several tiers pinned to one model id is a normal third-party setup, and once
 * the alias is resolved nothing in the request says which one asked. Reads
 * prefer whichever of them is configured, then the most capable — worth
 * stating, because configuring two of them differently cannot work.
 */
function ambiguityWarnings(models: Map<string, ModelTier[]>): string[] {
  const shared = [...models.entries()].filter(([, tiers]) => tiers.length > 1);
  if (shared.length === 0) return [];
  return [
    '',
    ...shared.map(
      ([model, tiers]) =>
        `  ! ${tiers.join(', ')} all resolve to ${model}; the configured tier wins, then ${getModelTier(model) ?? tiers[0]}.`,
    ),
  ];
}

/**
 * Resolving a slot can throw: Gemini's resolver requires configuration, and the
 * `default` slot goes through the subscription/auth chain, which throws outright
 * when nothing is logged in yet. The panel must still render — it is the one
 * view that works on every session — so fall back to the slot name. The slot is
 * what matters for the defaults lookup anyway.
 */
function safeResolve(slot: ModelSettingsSlot): string {
  try {
    return (slot === 'default' ? getDefaultMainLoopModel() : parseUserSpecifiedModel(slot)) ?? slot;
  } catch {
    return slot;
  }
}

/**
 * `/model-settings` (alias `/models-setting`) — one command for the three axes
 * that all land in `settings.modelSettings`: which model each tier resolves to,
 * its thinking effort and its context window.
 *
 * Bare opens the interactive editor; anything else is the scriptable form,
 * answered without rendering the way `/provider-settings` does it. The rules
 * exercised by the argument form live in ./state.ts, which is what makes them
 * testable without an Ink tree.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim() || '';

  if (COMMON_HELP_ARGS.includes(trimmed)) {
    onDone(usage());
    return;
  }

  const parsed = parseArgs(trimmed);

  switch (parsed.kind) {
    case 'panel': {
      const initial = buildModelStepFromEnvironment();
      if (initial) return <ModelTierSetup initial={initial} onDone={onDone} context={context} />;
      // No configurable provider: bedrock / vertex / foundry configure models
      // through their own consoles, and a plain first-party session has no
      // `*_DEFAULT_<TIER>_MODEL` keys to point anywhere. The wizard therefore
      // has nothing to edit — but effort and context are still theirs to set,
      // and the text panel below is exactly the view `/model-settings` showed
      // those sessions. Falling back to it rather than to the old
      // `/models-setting` "nothing to configure here" dialog is the whole
      // point of the merge: one name must not be *less* useful than the two it
      // replaced. `show` and the `<slot> …` forms work on these sessions too.
      onDone(describeAll());
      return;
    }

    case 'show':
      onDone(describeAll());
      return;

    case 'error':
      onDone(parsed.message);
      return;

    case 'reset': {
      const { error } = resetTierSettings(parsed.tier);
      onDone(
        error
          ? `Could not update settings: ${error.message}`
          : `Cleared overrides for ${parsed.tier}. Now: ${summarize(parsed.tier)}`,
      );
      return;
    }

    case 'set': {
      const { error } = writeTierSettings(parsed.tier, {
        effort: parsed.effort,
        contextTokens: parsed.contextTokens,
      });
      if (error) {
        onDone(`Could not update settings: ${error.message}`);
        return;
      }
      const note = parsed.effort !== undefined ? '\nCleared the older global effortLevel so this takes effect.' : '';
      onDone(`${parsed.tier}: ${summarize(parsed.tier)}${note}`);
      return;
    }
  }
}

function summarize(tier: ModelSettingsSlot): string {
  const model = safeResolve(tier);
  const defaults = getTierDefaults(model, tier === 'default' ? undefined : tier);
  const override = getTierOverride(tier);
  const effort = override?.effort ?? defaults.effort;
  const tokens = override?.contextTokens ?? defaults.contextTokens;
  return `effort=${effort} context=${formatContextTokens(tokens)}`;
}

// Referenced so the current main-loop model is resolvable from this module for
// future panel work without another import round-trip.
export { getMainLoopModel };
