import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { has1mContext, modelSupports1M, supportsContextWindow } from '../utils/session/context.js';
import { getModelSettingsSlot, getModelTier, type ModelSettingsSlot } from '../utils/model/modelTier.js';
import { buildAggregatedModels } from '../services/providerProfiles/aggregate.js';
import { activateProfileForModel } from '../services/providerProfiles/activate.js';
import { getMergedProviderEnv, loadProfilesFile } from '../services/providerProfiles/profiles.js';
import {
  buildAggregatedModelOptions,
  offeredModelIds,
  parseAggregatedOptionValue,
  sessionOwnedProfiles,
} from './providerSettings/aggregatedOptions.js';
import { formatContextTokens, getTierContextTokens, getTierOverride } from '../utils/model/tierSettings.js';
import { writeTierSettings } from '../commands/model-settings/state.js';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/model/fastMode.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/model/effort.js';
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js';
import { getModelOptions } from '../utils/model/modelOptions.js';
import { isModelAllowed } from '../utils/model/modelAllowlist.js';
import { getInitialSettings, getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint, Pane } from '@anthropic/ink';
import { effortLevelToSymbol } from './EffortIndicator.js';

export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  /** Overrides the dim header line below "Select model". */
  headerText?: string;
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .claude/settings.json via
   * install.ts) and should not leak to the user's global ~/.claude/settings.
   */
  skipSettingsWrite?: boolean;
};

const NO_PREFERENCE = '__NO_PREFERENCE__';

/**
 * Windows offered by the max-context cycler, smallest first. `null` is "use
 * the built-in default for this tier" and always leads.
 *
 * These are the windows real endpoints actually advertise — 128k is the
 * commodity OpenAI-compatible size, 272k is GPT-5's, 200k is Claude's and 1M
 * is what Claude's opt-in and DeepSeek V4 serve. A value already saved for the
 * focused tier is spliced in if it is not one of these, so a number typed into
 * `/model-settings` is never silently lost by cycling past it.
 */
const CONTEXT_LADDER = [128_000, 200_000, 272_000, 512_000, 1_000_000] as const;

/** Sentinel key for rows whose model belongs to no tier — see effortKeyForOption. */
const UNTIERED = '*';

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const maxVisible = 10;

  const initialValue = initial === null ? NO_PREFERENCE : initial;
  const [focusedValue, setFocusedValue] = useState<string | undefined>(initialValue);

  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));

  // Max context, chosen per tier. `null` means "back to the tier default",
  // which is a different thing from "not touched" (absent) — the first has to
  // clear an existing override, the second must leave it alone.
  const [contextByTier, setContextByTier] = useState<Map<string, number | null>>(() => new Map());

  // Set when an aggregated row could not be activated. Rendered instead of
  // closing the picker, since the selection did not take effect.
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const effortValue = useAppState(s => s.effortValue);
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined,
  );
  // Effort is per tier for the same reason max context is: one global level
  // cannot say "opus thinks hard, haiku stays cheap". Rows whose model belongs
  // to no tier share the UNTIERED key and still write the flat effortLevel.
  const [effortByTier, setEffortByTier] = useState<Map<string, EffortLevel>>(() => new Map());

  // Memoize all derived values to prevent re-renders
  const modelOptions = useMemo(() => getModelOptions(isFastMode ?? false), [isFastMode]);

  // Ensure the initial value is in the options list
  // This handles edge cases where the user's current model (e.g., 'haiku' for 3P users)
  // is not in the base options but should still be selectable and shown as selected
  const optionsWithInitial = useMemo(() => {
    if (initial !== null && !modelOptions.some(opt => opt.value === initial)) {
      return [
        ...modelOptions,
        {
          value: initial,
          label: modelDisplayString(initial),
          description: 'Current model',
        },
      ];
    }
    return modelOptions;
  }, [modelOptions, initial]);

  /**
   * The union of every profile that opted into aggregation, appended after the
   * active provider's own rows.
   *
   * Skipped entirely when this picker may not write settings: that flag marks
   * the assistant installer, whose model choice is project-scoped, and every
   * row here switches the whole session's provider when selected.
   *
   * `availableModels` applies here too. getModelOptions() filters its own list
   * and these rows arrive after it, so an org allowlist would otherwise be
   * bypassed by the one list assembled outside that function.
   */
  const aggregatedOptions = useMemo(() => {
    if (skipSettingsWrite) return [];
    const file = loadProfilesFile();
    // Both sides of the de-duplication are computed here and neither is the
    // raw option value: the ids come from resolving each row (a tier row's
    // value is an alias), and "the provider in use" comes from the live
    // configuration rather than from `file.active`, which a session configured
    // by /login never wrote. See aggregatedOptions.ts.
    const existingModelIds = offeredModelIds(
      optionsWithInitial.map(opt => (opt.value === null ? NO_PREFERENCE : opt.value)),
      resolveOptionModel,
    );
    return buildAggregatedModelOptions(buildAggregatedModels(file), {
      existingModelIds,
      sessionProfiles: sessionOwnedProfiles(file, {
        modelType: getSettingsForSource('userSettings')?.modelType,
        env: getMergedProviderEnv(),
      }),
    }).filter(opt => isModelAllowed(parseAggregatedOptionValue(opt.value)?.id ?? opt.value));
  }, [optionsWithInitial, skipSettingsWrite]);

  const selectOptions = useMemo(
    () => [
      ...optionsWithInitial.map(opt => ({
        ...opt,
        value: opt.value === null ? NO_PREFERENCE : opt.value,
      })),
      ...aggregatedOptions,
    ],
    [optionsWithInitial, aggregatedOptions],
  );
  const initialFocusValue = useMemo(
    () => (selectOptions.some(_ => _.value === initialValue) ? initialValue : (selectOptions[0]?.value ?? undefined)),
    [selectOptions, initialValue],
  );
  const visibleCount = Math.min(maxVisible, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);

  const focusedModelName = selectOptions.find(opt => opt.value === focusedValue)?.label;
  const focusedModel = resolveOptionModel(focusedValue);
  const focusedSlot = settingsSlotForOption(focusedValue);
  const focusedContextKey = focusedSlot ?? UNTIERED;
  // The window this row would run with: an in-picker choice, else whatever the
  // settings slot already resolves to (saved override, else provider-family default).
  const pickedContext = contextByTier.get(focusedContextKey);
  const savedContext = focusedModel ? getTierContextTokens(focusedModel, focusedSlot) : undefined;
  const focusedContextTokens = pickedContext ?? savedContext;
  const focusedContextIsDefault =
    pickedContext === null || (pickedContext === undefined && !hasSavedContextOverride(focusedSlot));
  // Both env knobs outrank everything the picker writes, so a session that has
  // one set would otherwise show the user changing a value that cannot take
  // effect. Say so rather than letting them find out later.
  const contextEnvOverride = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || undefined;
  const effortEnvOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL || undefined;
  const focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false;
  const focusedSupportsXhigh = focusedModel ? modelSupportsXhighEffort(focusedModel) : false;
  const focusedSupportsMax = focusedModel ? modelSupportsMaxEffort(focusedModel) : false;
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue);
  // Clamp display when selected effort isn't supported by the focused model.
  // resolveAppliedEffort() does the same downgrade at API-send time.
  const displayEffort =
    effort === 'max' && !focusedSupportsMax
      ? focusedSupportsXhigh
        ? 'xhigh'
        : 'high'
      : effort === 'xhigh' && !focusedSupportsXhigh
        ? 'high'
        : effort;

  const handleFocus = useCallback(
    (value: string) => {
      setFocusedValue(value);
      // Effort is per tier, so moving to a row belonging to a different tier
      // must show that tier's value — either what was chosen here already, or
      // its resolved setting. Carrying the previous row's level over was how a
      // single ← press on Opus silently re-labelled Haiku too.
      const key = settingsSlotForOption(value) ?? UNTIERED;
      const picked = effortByTier.get(key);
      if (picked !== undefined) {
        setEffort(picked);
      } else if (!hasToggledEffort && effortValue === undefined) {
        setEffort(getDefaultEffortLevelForOption(value));
      } else if (key !== UNTIERED) {
        setEffort(getDefaultEffortLevelForOption(value));
      }
    },
    [hasToggledEffort, effortValue, effortByTier],
  );

  // Effort level cycling keybindings
  const handleCycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (!focusedSupportsEffort) return;
      const next = cycleEffortLevel(
        effort ?? focusedDefaultEffort,
        direction,
        focusedSupportsXhigh,
        focusedSupportsMax,
      );
      setEffort(next);
      setEffortByTier(prev => new Map(prev).set(focusedContextKey, next));
      setHasToggledEffort(true);
    },
    [effort, focusedSupportsEffort, focusedSupportsXhigh, focusedSupportsMax, focusedDefaultEffort, focusedContextKey],
  );

  const handleCycleMaxContext = useCallback(() => {
    if (!focusedModel) return;
    setContextByTier(prev => {
      const next = new Map(prev);
      next.set(focusedContextKey, nextContextChoice(focusedModel, prev.get(focusedContextKey), focusedSlot));
      return next;
    });
  }, [focusedModel, focusedSlot, focusedContextKey]);

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
      'modelPicker:cycleMaxContext': () => handleCycleMaxContext(),
      // Retained so a keybindings.json that still names the old 1M toggle keeps
      // working — max context is what that key always did, one rung at a time.
      'modelPicker:toggle1M': () => handleCycleMaxContext(),
    },
    { context: 'ModelPicker' },
  );

  function handleSelect(value: string): void {
    logEvent('tengu_model_command_menu_effort', {
      effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    const selectedSlot = settingsSlotForOption(value);
    const selectedKey = selectedSlot ?? UNTIERED;
    const pickedEffort = effortByTier.get(selectedKey);
    const pickedContext = contextByTier.get(selectedKey);

    if (!skipSettingsWrite) {
      // EVERY tier touched in this session of the picker is saved, not just the
      // row that was finally chosen. Arrowing through the list adjusting each
      // tier and then pressing Enter once is the natural way to use this, and
      // discarding all but the last would silently throw that work away.
      // Per-tier is the real home for both axes, so the flat effortLevel goes:
      // writeTierSettings clears it when an effort is written, because it seeds
      // AppState, which outranks the per-tier layer. AppState.effortValue is
      // cleared for the same reason — undefined is what lets
      // getDefaultEffortForModel resolve the tier setting.
      const touched = new Set([...effortByTier.keys(), ...contextByTier.keys()]);
      let wroteEffort = false;
      for (const key of touched) {
        if (key === UNTIERED) continue;
        const slot = key as ModelSettingsSlot;
        const tierEffort = effortByTier.get(key);
        const tierContext = contextByTier.get(key);
        const patch: { effort?: EffortLevel; contextTokens?: number } = {};
        if (tierEffort !== undefined) patch.effort = tierEffort;
        if (tierContext != null) patch.contextTokens = tierContext;
        if (patch.effort !== undefined || patch.contextTokens !== undefined) {
          writeTierSettings(slot, patch);
        }
        if (tierContext === null) clearTierContext(slot);
        wroteEffort ||= tierEffort !== undefined;
      }
      if (wroteEffort) {
        setAppState(prev => ({ ...prev, effortValue: undefined }));
      }

      if (!selectedSlot) {
        // No tier to key on (a bare custom model id). Fall back to the flat
        // effortLevel, which is all this row can be described by.
        //
        // Prior comes from userSettings on disk — NOT merged settings (which
        // includes project/policy layers that must not leak into the user's
        // global ~/.claude/settings.json), and NOT AppState.effortValue (which
        // includes session-ephemeral sources like --effort CLI flag).
        // See resolvePickerEffortPersistence JSDoc.
        const effortLevel = resolvePickerEffortPersistence(
          effort,
          getDefaultEffortLevelForOption(value),
          getSettingsForSource('userSettings')?.effortLevel,
          hasToggledEffort,
        );
        const persistable = toPersistableEffort(effortLevel);
        if (persistable !== undefined) {
          updateSettingsForSource('userSettings', { effortLevel: persistable });
        }
        setAppState(prev => ({ ...prev, effortValue: effortLevel }));
      }
    }

    const selectedModel = resolveOptionModel(value);
    const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined;

    const aggregated = parseAggregatedOptionValue(value);
    if (aggregated) {
      // Selecting an aggregated model switches the session to the provider
      // that serves it. activateProfileForModel() delegates to
      // activateProfile(), which owns the whole-shape settings.env write and
      // the client-cache clear — there must be exactly one copy of that.
      const activated = activateProfileForModel(aggregated.selector);
      if ('error' in activated) {
        // Stay open: the row is real but the registry disagrees (a profile
        // deleted while this picker was on screen), and closing would leave
        // the user on the old provider with no explanation.
        setSelectionError(activated.error);
        return;
      }
      setSelectionError(null);
      // settings.env was just rewritten under the session.
      setAppState(prev => ({ ...prev, settings: getInitialSettings() }));
      onSelect(activated.model.id, selectedEffort);
      return;
    }

    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort);
      return;
    }
    // The `[1m]` suffix is downstream of the max-context choice, not a separate
    // switch: it is what makes betas.ts send context-1m-2025-08-07, so it goes
    // on exactly when the chosen window needs Anthropic's wide-context opt-in.
    // Third-party ids never take it — modelSupports1M is false for them and
    // their window comes from the setting alone.
    const baseValue = value.replace(/\[1m\]/i, '');
    const chosenTokens =
      pickedContext ?? (selectedModel ? getTierContextTokens(selectedModel, selectedSlot) : undefined);
    const wants1M =
      chosenTokens !== undefined &&
      chosenTokens !== null &&
      chosenTokens >= 1_000_000 &&
      !!selectedModel &&
      modelSupports1M(selectedModel);
    const finalValue = wants1M ? `${baseValue}[1m]` : baseValue;
    onSelect(finalValue, selectedEffort);
  }

  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            Select model
          </Text>
          <Text dimColor>
            {headerText ??
              'Choose a model for this and future sessions. Use ← → to adjust effort, Space to change max context.'}
          </Text>
          {focusedSlot && (
            <Text dimColor>
              Effort and max context are saved per model slot — this pair belongs to <Text bold>{focusedSlot}</Text>.
            </Text>
          )}
          {aggregatedOptions.length > 0 && (
            <Text dimColor>
              The last {aggregatedOptions.length} entries come from other saved providers (/provider-settings) —
              selecting one switches this session to that provider.
            </Text>
          )}
          {sessionModel && (
            <Text dimColor>
              Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode). Selecting a model
              will undo this.
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="column">
            <Select
              defaultValue={initialValue}
              defaultFocusValue={initialFocusValue}
              options={selectOptions}
              onChange={handleSelect}
              onFocus={handleFocus}
              onCancel={onCancel ?? (() => {})}
              visibleOptionCount={visibleCount}
            />
          </Box>
          {hiddenCount > 0 && (
            <Box paddingLeft={3}>
              <Text dimColor>and {hiddenCount} more…</Text>
            </Box>
          )}
        </Box>

        <Box marginBottom={1} flexDirection="column">
          {focusedSupportsEffort ? (
            <Text dimColor>
              <EffortLevelIndicator effort={displayEffort} /> {capitalize(displayEffort)} effort
              {displayEffort === focusedDefaultEffort ? ` (default)` : ``} <Text color="subtle">← → to adjust</Text>
            </Text>
          ) : (
            <Text color="subtle">
              <EffortLevelIndicator effort={undefined} /> Effort not supported
              {focusedModelName ? ` for ${focusedModelName}` : ''}
            </Text>
          )}
          {focusedContextTokens !== undefined && focusedContextTokens !== null ? (
            <Text dimColor>
              <EffortLevelIndicator effort={'high'} /> {formatContextTokens(focusedContextTokens)} max context
              {focusedContextIsDefault ? ' (default)' : ''}
              <Text color="subtle"> · Space to change</Text>
            </Text>
          ) : (
            <Text color="subtle">
              <EffortLevelIndicator effort={undefined} /> Max context not configurable
              {focusedModelName ? ` for ${focusedModelName}` : ''}
            </Text>
          )}
          {contextEnvOverride !== undefined && (
            <Text color="subtle">
              CLAUDE_CODE_MAX_CONTEXT_TOKENS={contextEnvOverride} overrides this — unset it for the setting to apply.
            </Text>
          )}
          {effortEnvOverride !== undefined && (
            <Text color="subtle">
              CLAUDE_CODE_EFFORT_LEVEL={effortEnvOverride} overrides this — unset it for the setting to apply.
            </Text>
          )}
          {selectionError !== null && <Text color="error">{selectionError}</Text>}
        </Box>

        {isFastModeEnabled() ? (
          showFastModeNotice ? (
            <Box marginBottom={1}>
              <Text dimColor>
                Fast mode is <Text bold>ON</Text> and available with {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching
                to other models turn off fast mode.
              </Text>
            </Box>
          ) : isFastModeAvailable() && !isFastModeCooldown() ? (
            <Box marginBottom={1}>
              <Text dimColor>
                Use <Text bold>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).
              </Text>
            </Box>
          ) : null
        ) : null}
      </Box>

      {isStandaloneCommand && (
        <Text dimColor italic>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" />
            </Byline>
          )}
        </Text>
      )}
    </Box>
  );

  if (!isStandaloneCommand) {
    return content;
  }

  return <Pane color="permission">{content}</Pane>;
}

/**
 * The concrete model an option row runs with.
 *
 * Exported for `__tests__/modelPickerOptions.test.ts`: this and
 * settingsSlotForOption are the two places an aggregated selector could be
 * mistaken for a tier alias, and that is worth pinning without rendering.
 */
export function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === NO_PREFERENCE) return getDefaultMainLoopModel();
  // An aggregated row already names a concrete model id, as the owning
  // provider serves it. parseUserSpecifiedModel would try to read it as one of
  // occ's aliases and answer for a different model entirely.
  const aggregated = parseAggregatedOptionValue(value);
  if (aggregated) return aggregated.id;
  return parseUserSpecifiedModel(value);
}

/**
 * Which tier's settings the highlighted row edits.
 *
 * Rows for a tier carry the alias as their value ('opus', 'sonnet[1m]'), so
 * that answer stays exact even when multiple rows resolve to the same model id.
 * Bare ids from the provider catalog continue through the tier reverse lookup.
 */
export function settingsSlotForOption(value?: string): ModelSettingsSlot | undefined {
  if (!value) return undefined;
  if (value === NO_PREFERENCE) return 'default';
  // An aggregated row is a provider's own model id, never a SELECTION of a
  // tier — and a provider is free to serve a model literally named `opus`.
  // Passing that to getModelSettingsSlot as the selection would let a relay's
  // id capture the opus slot and quietly re-point that tier's effort and max
  // context. Only the reverse lookup (does any *_DEFAULT_<TIER>_MODEL pin this
  // id) can answer for these rows.
  const aggregated = parseAggregatedOptionValue(value);
  if (aggregated) return getModelTier(aggregated.id);
  const model = resolveOptionModel(value);
  return model ? getModelSettingsSlot(model, value) : undefined;
}

function hasSavedContextOverride(slot: ModelSettingsSlot | undefined): boolean {
  return slot !== undefined && getTierOverride(slot)?.contextTokens !== undefined;
}

/** Drop just this slot's contextTokens, leaving any effort override in place. */
function clearTierContext(slot: ModelSettingsSlot): void {
  const current = getSettingsForSource('userSettings')?.modelSettings ?? {};
  const existing = { ...(current[slot] ?? {}) };
  delete existing.contextTokens;
  updateSettingsForSource('userSettings', {
    modelSettings: { ...current, [slot]: Object.keys(existing).length > 0 ? existing : undefined },
  });
}

/**
 * Next rung of the max-context cycler: default → each supported window in
 * ascending order → back to default.
 *
 * `undefined` (untouched) starts from whatever the tier resolves to now, so
 * the first press moves off the current value rather than jumping to the
 * bottom of the ladder.
 */
function nextContextChoice(
  model: string,
  current: number | null | undefined,
  slot: ModelSettingsSlot | undefined,
): number | null {
  const saved = hasSavedContextOverride(slot) ? getTierContextTokens(model, slot) : undefined;
  const rungs = [...new Set([...CONTEXT_LADDER, ...(saved !== undefined ? [saved] : [])])]
    .filter(tokens => supportsContextWindow(model, tokens))
    .sort((a, b) => a - b);
  if (rungs.length === 0) return null;

  const currentTokens = current === undefined ? saved : current;
  if (currentTokens === null || currentTokens === undefined) return rungs[0]!;
  const index = rungs.indexOf(currentTokens);
  if (index === -1) return rungs[0]!;
  // Past the top rung is "back to the tier default", which is how an override
  // gets cleared without a second key.
  return index === rungs.length - 1 ? null : rungs[index + 1]!;
}

function EffortLevelIndicator({ effort }: { effort?: EffortLevel }): React.ReactNode {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>;
}

function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  includeXhigh: boolean,
  includeMax: boolean,
): EffortLevel {
  const levels: EffortLevel[] = [
    'low',
    'medium',
    'high',
    ...(includeXhigh ? (['xhigh'] as const) : []),
    ...(includeMax ? (['max'] as const) : []),
  ];
  // If the current level isn't in the cycle (e.g. 'max' after switching to a
  // non-Opus model), clamp to 'high'.
  const idx = levels.indexOf(current);
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high');
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!;
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!;
  }
}

function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel();
  const defaultValue = getDefaultEffortForModel(resolved, settingsSlotForOption(value));
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high';
}
