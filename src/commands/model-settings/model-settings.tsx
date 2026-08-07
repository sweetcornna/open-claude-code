import type * as React from 'react';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getModelTier, MODEL_TIERS, type ModelTier } from '../../utils/model/modelTier.js';
import { getTierDefaults } from '../../utils/model/tierDefaults.js';
import { formatContextTokens, getTierOverride } from '../../utils/model/tierSettings.js';
import { getMainLoopModel } from '../../utils/model/model.js';
import { parseUserSpecifiedModel } from '../../utils/model/model.js';
import { parseArgs, resetTierSettings, usage, writeTierSettings } from './state.js';

const COMMON_HELP_ARGS = ['help', '--help', '-h', '?'];

/** Human-readable summary of what each tier resolves to right now. */
function describeAll(): string {
  const lines = ['Per-tier model settings (env still wins over these):', ''];
  const models = new Map<string, ModelTier[]>();
  for (const tier of MODEL_TIERS) {
    const model = safeResolve(tier);
    const defaults = getTierDefaults(model, tier);
    const override = getTierOverride(tier);
    const effort = override?.effort ?? defaults.effort;
    const tokens = override?.contextTokens ?? defaults.contextTokens;
    const marks = [
      override?.effort !== undefined ? 'effort set' : undefined,
      override?.contextTokens !== undefined ? 'context set' : undefined,
    ].filter(Boolean);
    const suffix = marks.length > 0 ? `  (${marks.join(', ')})` : '  (defaults)';
    lines.push(
      `  ${tier.padEnd(7)} ${model.padEnd(24)} effort=${effort.padEnd(6)} context=${formatContextTokens(tokens)}${suffix}`,
    );
    models.set(model, [...(models.get(model) ?? []), tier]);
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
 * Resolving an alias can throw for providers that require configuration
 * (Gemini's resolver does). The panel must still render, so fall back to the
 * alias itself — the tier is what matters for the defaults lookup anyway.
 */
function safeResolve(tier: ModelTier): string {
  try {
    return parseUserSpecifiedModel(tier) ?? tier;
  } catch {
    return tier;
  }
}

export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  const trimmed = args?.trim() || '';

  if (COMMON_HELP_ARGS.includes(trimmed)) {
    onDone(usage());
    return;
  }

  const parsed = parseArgs(trimmed);

  switch (parsed.kind) {
    case 'panel':
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

function summarize(tier: ModelTier): string {
  const model = safeResolve(tier);
  const defaults = getTierDefaults(model, tier);
  const override = getTierOverride(tier);
  const effort = override?.effort ?? defaults.effort;
  const tokens = override?.contextTokens ?? defaults.contextTokens;
  return `effort=${effort} context=${formatContextTokens(tokens)}`;
}

// Referenced so the current main-loop model is resolvable from this module for
// future panel work without another import round-trip.
export { getMainLoopModel };
