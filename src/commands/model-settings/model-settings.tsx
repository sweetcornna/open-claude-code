import type * as React from 'react';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { MODEL_TIERS, type ModelTier } from '../../utils/model/modelTier.js';
import { getTierDefaults } from '../../utils/model/tierDefaults.js';
import { getTierOverride } from '../../utils/model/tierSettings.js';
import { getMainLoopModel } from '../../utils/model/model.js';
import { parseUserSpecifiedModel } from '../../utils/model/model.js';
import { parseArgs, resetTierSettings, usage, writeTierSettings } from './state.js';

const COMMON_HELP_ARGS = ['help', '--help', '-h', '?'];

/** Human-readable summary of what each tier resolves to right now. */
function describeAll(): string {
  const lines = ['Per-tier model settings (env still wins over these):', ''];
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
      `  ${tier.padEnd(7)} ${model.padEnd(24)} effort=${effort.padEnd(6)} context=${formatTokens(tokens)}${suffix}`,
    );
  }
  lines.push('', usage());
  return lines.join('\n');
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

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
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
  return `effort=${effort} context=${formatTokens(tokens)}`;
}

// Referenced so the current main-loop model is resolvable from this module for
// future panel work without another import round-trip.
export { getMainLoopModel };
