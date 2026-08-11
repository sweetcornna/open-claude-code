/**
 * The shared two-step provider setup: connection details, then a model picked
 * from whatever the endpoint actually serves.
 *
 * Step 1 collects Base URL + API Key and asks the endpoint about them — see
 * endpointRequests.ts for what that means per provider. Step 2 turns the answer
 * into a picker for the default model and each tier override. When the model
 * request fails — wrong URL, no key, a gateway that does not implement /models
 * — the same step 2 renders as plain text inputs with the failure reason shown,
 * so a working endpoint is never blocked by a missing model list. A credential
 * the endpoint outright REFUSES is the other case, and it does not reach step 2
 * at all.
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
  activeSubscriptionAuth,
  PROVIDER_SETUP_SPECS,
  type ProviderSetupSpec,
  type ProviderSetupValues,
  specForSubscriptionAuth,
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
import { runEndpointRequests } from './endpointRequests.js';
import { applyDeepSeekAnthropicWire } from 'src/utils/model/deepseekWire.js';
import { prefillTierFields } from './tierPersistence.js';
import { applyProviderSaveEnv, planProviderSave, type ProviderSaveOutcome } from './savePlan.js';
import { EFFORT_LEVELS } from 'src/utils/model/effort.js';
import { getSettingsForSource } from 'src/utils/settings/settings.js';
import { normalizeProviderBaseURL } from 'src/utils/network/providerUrl.js';

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
  /**
   * Settings written; the flow is finished. The outcome says whether the
   * session's model selection is still meaningful — see ProviderSaveOutcome.
   */
  onSaved: (outcome: ProviderSaveOutcome) => void;
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
    const enteredBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    const retryState: ProviderEndpointSetupStatus = {
      state: 'provider_endpoint_setup',
      kind: status.kind,
      phase: 'editing',
      baseUrl: enteredBaseUrl,
      apiKey: trimmedApiKey,
      ...(status.wireApi ? { wireApi: status.wireApi } : {}),
      activeField: 'base_url',
    };

    if (!enteredBaseUrl && spec.baseUrlRequired) {
      onError('Base URL is required. Enter the full server URL, including https:// or http://.', retryState);
      return;
    }

    let normalizedBaseUrl = enteredBaseUrl;
    if (enteredBaseUrl) {
      try {
        const parsed = new URL(enteredBaseUrl);
        if (parsed.hash) {
          onError('Base URL must not contain a #fragment.', retryState);
          return;
        }
        normalizedBaseUrl = normalizeProviderBaseURL(enteredBaseUrl, spec.urlKind);
      } catch {
        onError('Invalid Base URL. Enter the full server URL, including https:// or http://.', retryState);
        return;
      }
    }
    if (!trimmedApiKey && spec.apiKeyRequired) {
      onError('API Key is required so the server can authorize the model-list request.', {
        ...retryState,
        baseUrl: normalizedBaseUrl,
        activeField: 'api_key',
      });
      return;
    }

    setStatus({
      state: 'provider_endpoint_setup',
      kind: status.kind,
      phase: 'fetching',
      baseUrl: normalizedBaseUrl,
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

    // An unset base URL is legal for every provider but OpenAI; the request
    // still has to go somewhere, so it goes to the same default the provider
    // would use at runtime. It is deliberately not written to settings later.
    const effectiveBaseUrl = status.baseUrl || spec.defaultBaseUrl;

    void runEndpointRequests({
      spec,
      baseURL: effectiveBaseUrl,
      apiKey: status.apiKey,
      signal: controller.signal,
    }).then(outcome => {
      if (disposed || controller.signal.aborted) return;
      if (!outcome.proceed) {
        // A credential this endpoint refuses stops here, one screen before
        // anything is written. Coming back lands on the API Key field with the
        // endpoint still filled in, so correcting it is a keystroke rather than
        // a restart.
        onError(outcome.message, {
          state: 'provider_endpoint_setup',
          kind: status.kind,
          phase: 'editing',
          baseUrl: status.baseUrl,
          apiKey: status.apiKey,
          ...(status.wireApi ? { wireApi: status.wireApi } : {}),
          activeField: 'api_key',
        });
        return;
      }
      setStatus(buildModelStep(status, spec, outcome.models, outcome.failureReason));
    });

    return () => {
      disposed = true;
      controller.abort();
      if (fetchControllerRef.current === controller) fetchControllerRef.current = null;
    };
    // `onError` is left out on purpose: the host passes an inline arrow, so
    // including it would abort and restart the request on every render of the
    // screen above. It only ever closes over a stable state setter, so the
    // handler captured on the first pass is the same one a later render builds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Built-in tables are failure fallbacks for official endpoints only. A
  // compatible wire protocol does not prove that a custom endpoint serves GPT
  // or Claude models, and a successful /models response is authoritative.
  const preset = spec.presetModels?.(status) ?? [];
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
  const ids = new Set(models.map(model => model.id));
  const keep = (value: string): string => (ids.has(value) ? value : '');
  return {
    ...base,
    entryMode: 'catalog',
    models,
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
  // Model-only mode. The credentials belong to a subscription login, so the
  // spec's own answers about them (which field is mandatory, what the heading
  // names) are the wrong ones — the table says what changes, not this file.
  const credentialsLocked = status.credentialEditing === 'locked';
  const baseSpec = PROVIDER_SETUP_SPECS[status.kind];
  const subscriptionAuth = credentialsLocked ? activeSubscriptionAuth(baseSpec) : undefined;
  const spec = specForSubscriptionAuth(baseSpec, subscriptionAuth);
  // There was no step 1 in this run, so "back" is the host's business and the
  // heading must not advertise a step the user never saw.
  const showsEndpointStep = spec.hasEndpointStep && !credentialsLocked;
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
  /**
   * Whether the user has moved the effort picker off where it opened.
   *
   * The picker is the only widget that can save, so "the user pressed Enter"
   * cannot distinguish choosing a value from walking past the field. What can:
   * the prefill is empty both when nothing is configured AND when the tiers
   * disagree, and in the second case the user opening the form is precisely
   * the one who wants "(model default)" applied to all of them. A ref rather
   * than state because it must be readable inside the same save that the
   * picker's onChange starts, before any re-render.
   */
  const effortTouchedRef = useRef(false);

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
        ...(status.credentialEditing ? { credentialEditing: status.credentialEditing } : {}),
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
    // provider/key screens, so "back" is the host's business, not ours. Same
    // for model-only mode: there is no endpoint form to go back to, and
    // opening one would present a blank API key field over a live login.
    if (!showsEndpointStep) {
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
  }, [onCancel, setStatus, showsEndpointStep, status]);

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

  const doSave = async (valuesToSave: ProviderSetupValues = values): Promise<void> => {
    const invalid = spec.validate(valuesToSave);
    if (invalid) {
      onError(invalid.message, retryStatus(invalid.field === 'maxContext' ? 'max_context' : invalid.field));
      return;
    }

    const maxContextValue = parseMaxContextInput(valuesToSave.maxContext);
    if (maxContextValue === null) {
      onError(
        'Invalid max context: enter a token count like 128000 (or 128k / 1m), or leave it empty.',
        retryStatus('max_context'),
      );
      return;
    }

    // What to write is decided in one pure place (savePlan.ts) so the rules —
    // which keys a subscription session must not touch, when "(model default)"
    // means "clear", what counts as changing provider — are testable without
    // rendering a form.
    const existingSettings = getSettingsForSource('userSettings');
    const plan = planProviderSave({
      spec,
      status,
      values: valuesToSave,
      contextTokens: maxContextValue === undefined ? undefined : Number(maxContextValue),
      effortTouched: effortTouchedRef.current,
      existingSettings,
      processEnv: process.env,
    });

    const { error } = updateSettingsForSource('userSettings', {
      modelType: spec.modelType,
      model: undefined,
      env: plan.env as unknown as Record<string, string>,
      ...(Object.keys(plan.modelSettings).length > 0 ? { modelSettings: plan.modelSettings } : {}),
      ...(plan.clearFlatEffort ? { effortLevel: undefined } : {}),
    } as unknown as Parameters<typeof updateSettingsForSource>[1]);
    if (error) {
      onError('Failed to save settings. Please try again.', retryStatus(activeField));
      return;
    }

    applyProviderSaveEnv(plan.env, existingSettings?.env, process.env);
    // This writes provider env straight to the process, bypassing managedEnv,
    // so the DeepSeek mirror has to be re-run here by hand. Without it a
    // first-time login leaves the session claiming the Anthropic wire
    // (getAPIProvider() flips as soon as the keys land) without applying it —
    // requests go to api.anthropic.com unauthenticated and come back
    // "Not logged in · Please run /login".
    applyDeepSeekAnthropicWire();
    await spec.afterSave?.({ credentialsConfigured: plan.credentialsConfigured });
    onSaved(plan.outcome);
  };

  const handleSubmit = (): void => {
    // Save on the LAST field, whichever that is. Naming max_context here meant
    // that adding the effort field after it left the new field unreachable:
    // Enter still saved from the field before it.
    if (fields.indexOf(activeField) === fields.length - 1) {
      void doSave();
      return;
    }
    step(1);
  };

  const modelOptions =
    status.entryMode === 'catalog'
      ? status.models.map(model => ({ label: model.displayName?.trim() || model.id, value: model.id }))
      : [];

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
            onFocus={
              field === 'effort'
                ? focused => {
                    // Fires once on mount with the opening value; anything else
                    // is the user having navigated.
                    if (focused !== value) effortTouchedRef.current = true;
                  }
                : undefined
            }
            onChange={selected => {
              setValue(field, selected);
              if (field === 'effort') {
                void doSave({ ...values, effort: selected });
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
        {showsEndpointStep ? ' — Step 2 of 2' : ''}
      </Text>
      {subscriptionAuth && (
        <Text dimColor>
          Signed in with your {subscriptionAuth.label}. That login owns the credentials — nothing here touches them, and
          this form only changes which model each tier uses.
        </Text>
      )}
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
          ? `Use ↑↓ and Enter to choose each model. Enter on thinking effort saves. Esc goes ${showsEndpointStep ? 'back to Step 1' : 'back'}.`
          : `Enter or Tab moves to the next field. Enter on thinking effort saves. Esc goes ${showsEndpointStep ? 'back to Step 1' : 'back'}.`}
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
