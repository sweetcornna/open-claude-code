/**
 * The shared two-step provider setup: connection details, then a model picked
 * from whatever the endpoint actually serves.
 *
 * Step 1 collects Base URL + API Key and does nothing else with them but ask
 * the endpoint `GET /models`. Step 2 turns that answer into a picker for the
 * default model and each tier override. When the request fails — wrong URL, no
 * key, a gateway that does not implement /models — the same step 2 renders as
 * plain text inputs with the failure reason shown, so a working endpoint is
 * never blocked by a missing model list.
 *
 * Nothing is written to settings until step 2 is submitted: the model request
 * runs on credentials that exist only in this component's state, which is the
 * reason it goes through modelCatalog/fetchExplicit.ts rather than the normal
 * env-reading fetcher.
 *
 * Everything provider-specific lives in ./specs.ts.
 */

import { Box, Text } from '@anthropic/ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useKeybinding } from 'src/keybindings/useKeybinding.js';
import { updateSettingsForSource } from 'src/utils/settings/settings.js';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { Select } from '../CustomSelect/select.js';
import { Spinner } from '../Spinner.js';
import TextInput from '../TextInput.js';
import {
  PROVIDER_SETUP_SPECS,
  type ProviderSetupSpec,
  type ProviderSetupValues,
  TIER_LABELS,
  type TierField,
} from './specs.js';
import {
  type EndpointField,
  type ProviderEndpointSetupStatus,
  type ProviderModelField,
  type ProviderModelSetupStatus,
  type ProviderSetupStatus,
  TIER_STATUS_KEYS,
} from './state.js';
import { parseMaxContextInput } from './maxContext.js';
import { applyDeepSeekAnthropicWire } from 'src/utils/model/deepseekWire.js';
import { buildTierSettings, prefillTierFields } from './tierPersistence.js';
import { EFFORT_LEVELS } from 'src/utils/model/effort.js';
import type { TierEffort } from 'src/utils/model/tierDefaults.js';
import { getSettingsForSource } from 'src/utils/settings/settings.js';

export type ProviderSetupWizardProps = {
  status: ProviderSetupStatus;
  setStatus: (status: ProviderSetupStatus) => void;
  /** Surface a validation/save failure, with the state to come back to. */
  onError: (message: string, retry: ProviderSetupStatus) => void;
  /**
   * Esc out of the wizard — back to whatever came before it. May return `false`
   * to decline the keypress (see backFrom in ConsoleOAuthFlow); the wizard
   * forwards that so the event reaches the handler that is actually current.
   */
  onCancel: () => void | false;
  /** Settings written; the flow is finished. */
  onSaved: () => void;
};

export function ProviderSetupWizard(props: ProviderSetupWizardProps): React.ReactNode {
  return props.status.state === 'provider_endpoint_setup' ? (
    <EndpointStep {...props} status={props.status} />
  ) : (
    <ModelStep {...props} status={props.status} />
  );
}

// ─── Step 1: connection details ──────────────────────────────────────────────

function EndpointStep({
  status,
  setStatus,
  onError,
  onCancel,
}: ProviderSetupWizardProps & { status: ProviderEndpointSetupStatus }): React.ReactNode {
  const spec = PROVIDER_SETUP_SPECS[status.kind];
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [apiKey, setApiKey] = useState(status.apiKey);
  const [activeField, setActiveField] = useState<EndpointField>(status.activeField);
  const [cursorOffset, setCursorOffset] = useState(() =>
    status.activeField === 'base_url' ? status.baseUrl.length : status.apiKey.length,
  );
  const fetchControllerRef = useRef<AbortController | null>(null);
  const inputColumns = Math.max(20, useTerminalSize().columns - 18);

  const editingStatus = useCallback(
    (field: EndpointField): ProviderEndpointSetupStatus => ({
      state: 'provider_endpoint_setup',
      kind: status.kind,
      phase: 'editing',
      baseUrl,
      apiKey,
      ...(status.wireApi ? { wireApi: status.wireApi } : {}),
      activeField: field,
    }),
    [apiKey, baseUrl, status.kind, status.wireApi],
  );

  const beginModelFetch = useCallback(() => {
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    const retryState: ProviderEndpointSetupStatus = {
      state: 'provider_endpoint_setup',
      kind: status.kind,
      phase: 'editing',
      baseUrl: trimmedBaseUrl,
      apiKey: trimmedApiKey,
      ...(status.wireApi ? { wireApi: status.wireApi } : {}),
      activeField: 'base_url',
    };

    if (!trimmedBaseUrl && spec.baseUrlRequired) {
      onError('Base URL is required. Enter the full server URL, including https:// or http://.', retryState);
      return;
    }
    if (trimmedBaseUrl) {
      try {
        new URL(trimmedBaseUrl);
      } catch {
        onError('Invalid Base URL. Enter the full server URL, including https:// or http://.', retryState);
        return;
      }
    }
    if (!trimmedApiKey && spec.apiKeyRequired) {
      onError('API Key is required so the server can authorize the model-list request.', {
        ...retryState,
        activeField: 'api_key',
      });
      return;
    }

    setStatus({
      state: 'provider_endpoint_setup',
      kind: status.kind,
      phase: 'fetching',
      baseUrl: trimmedBaseUrl,
      apiKey: trimmedApiKey,
      ...(status.wireApi ? { wireApi: status.wireApi } : {}),
      activeField: 'api_key',
    });
  }, [apiKey, baseUrl, onError, setStatus, spec, status.kind, status.wireApi]);

  useEffect(() => {
    if (status.phase !== 'fetching') return;

    const controller = new AbortController();
    fetchControllerRef.current = controller;
    let disposed = false;
    let failureReason = 'the request failed';

    // An unset base URL is legal for every provider but OpenAI; the request
    // still has to go somewhere, so it goes to the same default the provider
    // would use at runtime. It is deliberately not written to settings later.
    const effectiveBaseUrl = status.baseUrl || spec.defaultBaseUrl;

    const request: Promise<Awaited<ReturnType<ProviderSetupSpec['fetchModels']>>> =
      !status.apiKey && !spec.apiKeyRequired
        ? Promise.resolve(null).then(models => {
            failureReason = 'no API key was provided, so the model list could not be requested';
            return models;
          })
        : spec.fetchModels({
            baseURL: effectiveBaseUrl,
            apiKey: status.apiKey,
            signal: controller.signal,
            onError: reason => {
              failureReason = reason;
            },
          });

    void request.then(models => {
      if (disposed || controller.signal.aborted) return;
      setStatus(buildModelStep(status, spec, models, failureReason));
    });

    return () => {
      disposed = true;
      controller.abort();
      if (fetchControllerRef.current === controller) fetchControllerRef.current = null;
    };
  }, [setStatus, spec, status]);

  useKeybinding(
    'confirm:no',
    () => {
      if (status.phase === 'fetching') {
        fetchControllerRef.current?.abort();
        setActiveField('api_key');
        setStatus(editingStatus('api_key'));
        return;
      }
      onCancel();
    },
    { context: 'Confirmation' },
  );

  const switchTo = useCallback(
    (field: EndpointField) => {
      setActiveField(field);
      setCursorOffset((field === 'base_url' ? baseUrl : apiKey).length);
    },
    [apiKey, baseUrl],
  );

  useKeybinding('tabs:next', () => switchTo(activeField === 'base_url' ? 'api_key' : 'base_url'), {
    context: 'FormField',
  });
  useKeybinding('tabs:previous', () => switchTo(activeField === 'base_url' ? 'api_key' : 'base_url'), {
    context: 'FormField',
  });

  const handleSubmit = (): void => {
    if (activeField === 'base_url') {
      switchTo('api_key');
      return;
    }
    beginModelFetch();
  };

  if (status.phase === 'fetching') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{spec.title(status)} — Fetch Models</Text>
        <Box>
          <Spinner />
          <Text>Fetching available models from {status.baseUrl || spec.defaultBaseUrl}…</Text>
        </Box>
        <Text dimColor>Esc cancels the request and returns to endpoint setup.</Text>
      </Box>
    );
  }

  const renderRow = (field: EndpointField, label: string, value: string, mask: boolean): React.ReactNode => {
    const active = activeField === field;
    return (
      <Box>
        <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
          {` ${label} `}
        </Text>
        <Text> </Text>
        {active ? (
          <TextInput
            value={value}
            onChange={field === 'base_url' ? setBaseUrl : setApiKey}
            onSubmit={handleSubmit}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={inputColumns}
            mask={mask ? '*' : undefined}
            focus={true}
          />
        ) : value ? (
          <Text color="success">{mask ? maskSecret(value) : value}</Text>
        ) : (
          <Text dimColor>{field === 'base_url' ? spec.defaultBaseUrl : '(not set)'}</Text>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{spec.title(status)} — Step 1 of 2</Text>
      <Text dimColor>{spec.endpointHint(status)} occ will request GET /models before any settings are saved.</Text>
      <Box flexDirection="column" gap={1}>
        {renderRow('base_url', 'Base URL', baseUrl, false)}
        {renderRow('api_key', 'API Key ', apiKey, true)}
      </Box>
      <Text dimColor>
        Enter moves to the next field · Enter on API Key fetches the model list · Tab switches · Esc goes back
      </Text>
    </Box>
  );
}

function maskSecret(value: string): string {
  return value.slice(0, 8) + '·'.repeat(Math.max(0, value.length - 8));
}

/**
 * Seed step 2 from the environment so an existing configuration shows up as
 * the current selection. In catalog mode a remembered value that the endpoint
 * no longer serves is dropped — leaving it selected would let the user save a
 * model this server cannot answer for.
 */
export function buildModelStep(
  status: ProviderEndpointSetupStatus,
  spec: ProviderSetupSpec,
  models: Awaited<ReturnType<ProviderSetupSpec['fetchModels']>>,
  failureReason: string,
): ProviderModelSetupStatus {
  const base = {
    state: 'provider_model_setup' as const,
    kind: status.kind,
    baseUrl: status.baseUrl,
    apiKey: status.apiKey,
    ...(status.wireApi ? { wireApi: status.wireApi } : {}),
    model: process.env[spec.env.model] ?? '',
    ...prefillTierFields(getSettingsForSource('userSettings')?.modelSettings),
    haikuModel: process.env[spec.env.tiers.haiku_model] ?? '',
    sonnetModel: process.env[spec.env.tiers.sonnet_model] ?? '',
    opusModel: process.env[spec.env.tiers.opus_model] ?? '',
    fableModel: process.env[spec.env.tiers.fable_model] ?? '',
    activeField: 'model' as const,
  };

  // occ's own table for this provider, where one exists. Merged with the
  // endpoint's answer so a server that omits a model occ knows about still
  // offers it, and used alone when the request failed.
  const preset = spec.presetModels?.() ?? [];
  if (!models) {
    if (preset.length === 0) {
      return { ...base, entryMode: 'manual', fetchError: failureReason };
    }
    return {
      ...base,
      entryMode: 'catalog',
      models: preset,
      catalogNote: `Could not fetch the model list from the server (${failureReason}). Showing the models occ knows for this provider — pick one or press Esc to fix the endpoint.`,
    };
  }
  const merged = [...models, ...preset.filter(extra => !models.some(model => model.id === extra.id))];
  const ids = new Set(merged.map(model => model.id));
  const keep = (value: string): string => (ids.has(value) ? value : '');
  return {
    ...base,
    entryMode: 'catalog',
    models: merged,
    model: keep(base.model),
    haikuModel: keep(base.haikuModel),
    sonnetModel: keep(base.sonnetModel),
    opusModel: keep(base.opusModel),
    fableModel: keep(base.fableModel),
  };
}

// ─── Step 2: model selection ─────────────────────────────────────────────────

function ModelStep({
  status,
  setStatus,
  onError,
  onCancel,
  onSaved,
}: ProviderSetupWizardProps & { status: ProviderModelSetupStatus }): React.ReactNode {
  const spec = PROVIDER_SETUP_SPECS[status.kind];
  const showsDefaultModel = spec.defaultModelField !== 'omitted';
  const fields: ProviderModelField[] = [
    ...(showsDefaultModel ? (['model'] as const) : []),
    ...spec.tiers,
    'max_context',
    'effort',
  ];

  const [values, setValues] = useState<ProviderSetupValues>(() => ({
    model: status.model,
    haiku_model: status.haikuModel,
    sonnet_model: status.sonnetModel,
    opus_model: status.opusModel,
    fable_model: status.fableModel,
    maxContext: status.maxContext,
    effort: status.effort,
  }));
  const [activeField, setActiveField] = useState<ProviderModelField>(status.activeField);
  const [cursorOffset, setCursorOffset] = useState(() => valueOf(status, status.activeField).length);
  const inputColumns = Math.max(20, useTerminalSize().columns - 24);

  const getValue = (field: ProviderModelField): string =>
    field === 'max_context' ? values.maxContext : field === 'effort' ? values.effort : values[field];

  const setValue = (field: ProviderModelField, value: string): void =>
    setValues(previous =>
      field === 'max_context'
        ? { ...previous, maxContext: value }
        : field === 'effort'
          ? { ...previous, effort: value }
          : { ...previous, [field]: value },
    );

  const retryStatus = useCallback(
    (field: ProviderModelField): ProviderModelSetupStatus => {
      const common = {
        state: 'provider_model_setup' as const,
        kind: status.kind,
        baseUrl: status.baseUrl,
        apiKey: status.apiKey,
        ...(status.wireApi ? { wireApi: status.wireApi } : {}),
        ...(status.providerLabel ? { providerLabel: status.providerLabel } : {}),
        model: values.model,
        maxContext: values.maxContext,
        effort: values.effort,
        haikuModel: values.haiku_model,
        sonnetModel: values.sonnet_model,
        opusModel: values.opus_model,
        fableModel: values.fable_model,
        activeField: field,
      };
      return status.entryMode === 'catalog'
        ? { ...common, entryMode: 'catalog', models: status.models }
        : { ...common, entryMode: 'manual', fetchError: status.fetchError };
    },
    [status, values],
  );

  const returnToEndpoint = useCallback((): void | false => {
    // No step 1 for the China presets — they arrive here from their own
    // provider/key screens, so "back" is the host's business, not ours.
    if (!spec.hasEndpointStep) {
      return onCancel();
    }
    setStatus({
      state: 'provider_endpoint_setup',
      kind: status.kind,
      phase: 'editing',
      baseUrl: status.baseUrl,
      apiKey: status.apiKey,
      ...(status.wireApi ? { wireApi: status.wireApi } : {}),
      activeField: 'base_url',
    });
  }, [onCancel, setStatus, spec, status]);

  // ↑/↓ belong to whichever widget the active field renders.
  //
  // The FormField context binds them to tabs:previous/next, so registering it
  // alongside a focused Select meant arrows moved to the next FIELD instead of
  // the next OPTION — the picker could not be driven at all. Tab keeps working
  // on text fields, where nothing else wants those keys.
  const activeFieldIsSelector = usesSelector(status.entryMode, activeField);

  // Esc stays here unconditionally: the Select's own onCancel prop does not
  // fire in this layout, so disabling this left Esc dead on every picker field.
  // Double-navigation is handled at the other end instead — ConsoleOAuthFlow's
  // backFrom() ignores a back step whose screen is no longer current.
  useKeybinding('confirm:no', returnToEndpoint, { context: 'Confirmation' });

  const step = useCallback(
    (delta: number) => {
      const next = fields[fields.indexOf(activeField) + delta];
      if (!next) return;
      setActiveField(next);
      setCursorOffset(getValue(next).length);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getValue reads current render's state
    [activeField, fields, values],
  );

  useKeybinding('tabs:next', () => step(1), {
    context: 'FormField',
    isActive: !activeFieldIsSelector,
  });
  useKeybinding('tabs:previous', () => step(-1), {
    context: 'FormField',
    isActive: !activeFieldIsSelector,
  });

  const doSave = (): void => {
    const invalid = spec.validate(values);
    if (invalid) {
      onError(invalid.message, retryStatus(invalid.field === 'maxContext' ? 'max_context' : invalid.field));
      return;
    }

    const maxContextValue = parseMaxContextInput(values.maxContext);
    if (maxContextValue === null) {
      onError(
        'Invalid max context: enter a token count like 128000 (or 128k / 1m), or leave it empty.',
        retryStatus('max_context'),
      );
      return;
    }

    // The max-context answer goes to settings.modelSettings, not to
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS. That key sits ABOVE the per-tier layer on
    // purpose — it is the last-resort correction for a window nobody can detect
    // — so a value written there at login would silently outrank everything the
    // user later sets in /model. Any value an older occ left behind is deleted
    // here for the same reason: leaving it would make the setting they just
    // chose invisible. One-way, and the field carries the old value forward
    // (see prefillTierFields), so nothing is lost.
    const env: Record<string, string | undefined> = {
      ...(spec.extraEnv?.(status) ?? {}),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: undefined,
    };
    // An empty Base URL stays empty: writing the provider default would pin the
    // session to today's endpoint instead of following the provider's own.
    if (status.baseUrl.trim()) env[spec.env.baseUrl] = status.baseUrl.trim();
    if (status.apiKey.trim()) env[spec.env.apiKey] = status.apiKey.trim();
    // `omitted` still assigns undefined — that deletes any value a previous
    // login left behind, which is the point (see defaultModelField's docs).
    env[spec.env.model] = showsDefaultModel ? values.model.trim() || undefined : undefined;
    for (const tier of spec.tiers) {
      env[spec.env.tiers[tier]] = values[tier].trim() || undefined;
    }

    const existingTierSettings = getSettingsForSource('userSettings')?.modelSettings;
    const modelSettings = buildTierSettings({
      tierModels: {
        haiku_model: values.haiku_model,
        sonnet_model: values.sonnet_model,
        opus_model: values.opus_model,
        fable_model: values.fable_model,
      },
      defaultModel: showsDefaultModel ? values.model : '',
      contextTokens: maxContextValue === undefined ? undefined : Number(maxContextValue),
      effort: (values.effort || undefined) as TierEffort | undefined,
      existing: existingTierSettings,
    });

    const { error } = updateSettingsForSource('userSettings', {
      modelType: spec.modelType,
      env: env as unknown as Record<string, string>,
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      // The flat effortLevel seeds AppState, which outranks the per-tier layer.
      // Written together they would produce the worst outcome: a value chosen
      // here that changes nothing. Same one-way migration /model-settings does.
      ...(values.effort ? { effortLevel: undefined } : {}),
    } as unknown as Parameters<typeof updateSettingsForSource>[1]);
    if (error) {
      onError('Failed to save settings. Please try again.', retryStatus(activeField));
      return;
    }

    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // This writes provider env straight to the process, bypassing managedEnv,
    // so the DeepSeek mirror has to be re-run here by hand. Without it a
    // first-time login leaves the session claiming the Anthropic wire
    // (getAPIProvider() flips as soon as the keys land) without applying it —
    // requests go to api.anthropic.com unauthenticated and come back
    // "Not logged in · Please run /login".
    applyDeepSeekAnthropicWire();
    spec.afterSave?.();
    onSaved();
  };

  const handleSubmit = (): void => {
    // Save on the LAST field, whichever that is. Naming max_context here meant
    // that adding the effort field after it left the new field unreachable:
    // Enter still saved from the field before it.
    if (fields.indexOf(activeField) === fields.length - 1) {
      doSave();
      return;
    }
    step(1);
  };

  const modelOptions =
    status.entryMode === 'catalog' ? status.models.map(model => ({ label: model.id, value: model.id })) : [];

  const renderField = (field: ProviderModelField, label: string, optional: boolean): React.ReactNode => {
    const active = activeField === field;
    const value = getValue(field);
    const isSelector = usesSelector(status.entryMode, field);
    // Effort is a fixed five-rung ladder, so it is a picker whether or not the
    // endpoint answered /models — nothing about it comes from the catalog.
    const configuredButUnlisted =
      field !== 'effort' && value && !modelOptions.some(option => option.value === value)
        ? [{ label: value, value }]
        : [];
    const options =
      field === 'effort'
        ? EFFORT_OPTIONS
        : optional
          ? [{ label: '(not set)', value: '' }, ...modelOptions, ...configuredButUnlisted]
          : [...modelOptions, ...configuredButUnlisted];

    return (
      <Box key={field} flexDirection="column">
        <Box>
          <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
            {` ${label} `}
          </Text>
          {!active && (
            <Text color={value ? 'success' : undefined}>
              {value || (field === 'effort' ? '(model default)' : optional ? '(not set)' : '')}
            </Text>
          )}
        </Box>
        {active && isSelector && (
          <Select
            key={`${field}:${value}`}
            options={options}
            defaultValue={value}
            defaultFocusValue={value || options[0]?.value}
            visibleOptionCount={9}
            onChange={selected => {
              setValue(field, selected);
              if (field === 'effort') {
                doSave();
                return;
              }
              step(1);
            }}
            onCancel={returnToEndpoint}
          />
        )}
        {active && !isSelector && (
          <Box marginLeft={2}>
            <TextInput
              value={value}
              onChange={next => setValue(field, next)}
              onSubmit={handleSubmit}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={inputColumns}
              focus={true}
            />
          </Box>
        )}
      </Box>
    );
  };

  const modelRequired = spec.defaultModelField === 'required';

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {spec.title(status)}
        {spec.hasEndpointStep ? ' — Step 2 of 2' : ''}
      </Text>
      {status.entryMode === 'manual' && (
        <Text color="warning">
          Could not fetch the model list from the server ({status.fetchError}). Enter model names manually.
        </Text>
      )}
      {status.entryMode === 'catalog' && status.catalogNote ? <Text color="warning">{status.catalogNote}</Text> : null}
      <Box flexDirection="column" gap={1}>
        {showsDefaultModel &&
          renderField('model', modelRequired ? 'Default model (required)' : 'Default model (optional)', !modelRequired)}
        {spec.tiers.map(tier => renderField(tier, `${TIER_LABELS[tier]} tier model`, true))}
        {renderField('max_context', 'Max context tokens (context window size, e.g. 128000 or 128k)', true)}
        {renderField('effort', 'Thinking effort', true)}
      </Box>
      <Text dimColor>
        {showsDefaultModel
          ? 'The default model handles requests unless a tier override is configured. '
          : 'Each tier is what /model haiku · sonnet · opus · fable resolves to; any other model stays reachable by its own id. '}
        Maximum context tokens controls when automatic context compaction begins. Both it and thinking effort are saved
        per tier — leave them empty to store each model&apos;s own family default, and adjust either later from /model
        or /model-settings.
      </Text>
      <Text dimColor>
        {status.entryMode === 'catalog'
          ? `Use ↑↓ and Enter to choose each model. Enter on thinking effort saves. Esc goes ${spec.hasEndpointStep ? 'back to Step 1' : 'back'}.`
          : `Enter or Tab moves to the next field. Enter on thinking effort saves. Esc goes ${spec.hasEndpointStep ? 'back to Step 1' : 'back'}.`}
      </Text>
    </Box>
  );
}

function valueOf(status: ProviderModelSetupStatus, field: ProviderModelField): string {
  if (field === 'model') return status.model;
  if (field === 'max_context') return status.maxContext;
  if (field === 'effort') return status.effort;
  return status[TIER_STATUS_KEYS[field as TierField]];
}

/**
 * Which fields are driven by a Select rather than a text input.
 *
 * Model fields depend on the catalog request having succeeded; effort never
 * does — its options are occ's own five rungs — and max context is free text
 * by nature.
 */
function usesSelector(entryMode: ProviderModelSetupStatus['entryMode'], field: ProviderModelField): boolean {
  if (field === 'effort') return true;
  if (field === 'max_context') return false;
  return entryMode === 'catalog';
}

const EFFORT_OPTIONS: { label: string; value: string }[] = [
  { label: '(model default)', value: '' },
  ...EFFORT_LEVELS.map(level => ({ label: level, value: level })),
];
