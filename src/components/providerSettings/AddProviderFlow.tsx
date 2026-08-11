/**
 * Adding a provider from inside /provider-settings.
 *
 * Wiring only: which screen comes next, whether the "save what is running now"
 * offer applies, whether a name is acceptable and what the finished add reads
 * as are all decided in ../../commands/provider-settings/addFlow.ts — including
 * the reason this flow ACTIVATES what it adds rather than pretending to roll
 * back to whatever the session was on. Ink's test mode does not pump concurrent
 * updates, so a decision taken inside a render is a decision nothing can check.
 *
 * The setup form itself is the shared ProviderSetupWizard, unchanged and
 * un-forked: PROVIDER_SETUP_SPECS is the one table of providers, and a second
 * form would answer differently about the next one added to it.
 *
 * Nothing is written before the wizard's own save. Esc out of any earlier
 * screen leaves the registry and the session exactly as they were.
 */

import { Box, Text } from '@anthropic/ink';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  addableProviderEntries,
  afterAggregateAnswered,
  afterKindChosen,
  afterNameSubmitted,
  afterPreserveAnswered,
  beginAddFlow,
  describeAddOutcome,
  sessionProfileMatch,
  suggestSnapshotName,
  type AddFlowState,
  type AddProviderEntry,
} from '../../commands/provider-settings/addFlow.js';
import { saveCurrentAsProfile } from '../../services/providerProfiles/activate.js';
import {
  getMergedProviderEnv,
  loadProfilesFile,
  updateProfileCatalog,
} from '../../services/providerProfiles/profiles.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { Select } from '../CustomSelect/select.js';
import { ProviderSetupWizard } from '../providerSetup/ProviderSetupWizard.js';
import { PROVIDER_SETUP_SPECS, type ProviderSetupKind } from '../providerSetup/specs.js';
import type { ProviderSetupStatus } from '../providerSetup/state.js';
import { ProfileNamePrompt } from './ProfileNamePrompt.js';

export type AddProviderResult = {
  /** Registry key to put the cursor on, when the profile really was saved. */
  focus?: string;
  notice: string;
  /** The new profile joined the aggregate and has no snapshot yet. */
  refreshCatalog: boolean;
};

type AddProviderFlowProps = {
  /** Esc, at any point before the wizard saves. Nothing was written. */
  onCancel: (message?: string) => void;
  /** The wizard saved: settings.env now describes the new provider. */
  onFinished: (result: AddProviderResult) => void;
};

export function AddProviderFlow({ onCancel, onFinished }: AddProviderFlowProps): React.ReactNode {
  const entries = useMemo(() => addableProviderEntries(PROVIDER_SETUP_SPECS), []);
  const [flow, setFlow] = useState<AddFlowState>(beginAddFlow);
  const [wizardStatus, setWizardStatus] = useState<ProviderSetupStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The menu entry with its kind still typed, which the flow state drops. */
  const typedEntry = useCallback(
    (entry: AddProviderEntry): AddProviderEntry<ProviderSetupKind> | undefined =>
      entries.find(candidate => candidate.value === entry.value),
    [entries],
  );

  const chooseKind = useCallback(
    (value: string) => {
      const entry = entries.find(candidate => candidate.value === value);
      if (!entry) return;
      const file = loadProfilesFile();
      setFlow(
        afterKindChosen(entry, {
          savedAs: sessionProfileMatch(file, getMergedProviderEnv()),
          suggestion: suggestSnapshotName(file, getInitialSettings().modelType),
        }),
      );
    },
    [entries],
  );

  const preserveCurrent = useCallback((state: Extract<AddFlowState, { step: 'preserve' }>) => {
    // The same snapshot `/provider-settings save <name>` takes, and the reason
    // this screen exists: it is what makes switching back a row away.
    const saved = saveCurrentAsProfile({ name: state.suggestion });
    setNotice(
      'error' in saved
        ? `The current setup was not saved: ${saved.error}`
        : `Saved the current setup as "${state.suggestion}".`,
    );
    setFlow(afterPreserveAnswered(state));
  }, []);

  const enterSetup = useCallback(
    (state: Extract<AddFlowState, { step: 'aggregate' }>, aggregate: boolean) => {
      const next = afterAggregateAnswered(state, aggregate);
      const entry = typedEntry(state.entry);
      if (next.step !== 'setup' || !entry) return;
      setWizardStatus({
        state: 'provider_endpoint_setup',
        kind: entry.kind,
        phase: 'editing',
        baseUrl: entry.baseUrl,
        // Never seeded from the session: the credential in the environment
        // belongs to the provider being kept, not to the one being added.
        apiKey: '',
        ...(entry.wireApi ? { wireApi: entry.wireApi } : {}),
        activeField: 'base_url',
      });
      setFlow(next);
    },
    [typedEntry],
  );

  const captureSaved = useCallback(
    (state: Extract<AddFlowState, { step: 'setup' }>) => {
      // settings.env already describes the new provider — the wizard wrote it —
      // so this snapshots what the session is now running, exactly like `save`.
      const captured = saveCurrentAsProfile({ name: state.name });
      const outcome = describeAddOutcome({
        name: state.name,
        aggregate: state.aggregate,
        capture: 'error' in captured ? { error: captured.error } : { modelType: captured.profile.modelType },
      });
      let notice = outcome.notice;
      if (outcome.enrollAggregate) {
        const enrolled = updateProfileCatalog(state.name, { aggregate: true });
        if ('error' in enrolled) notice = `${notice} ${enrolled.error}`;
      }
      onFinished({
        ...('error' in captured ? {} : { focus: state.name }),
        notice,
        refreshCatalog: outcome.refreshCatalog && !('error' in captured),
      });
    },
    [onFinished],
  );

  const banner = notice ? (
    <Box marginBottom={1}>
      <Text dimColor>{notice}</Text>
    </Box>
  ) : null;

  if (flow.step === 'kind') {
    return (
      <Box flexDirection="column" padding={1}>
        {banner}
        <Text bold>Add a provider</Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          {/* Stated before anything is chosen, because it is the one surprise
              this flow could spring: setup writes the live configuration. */}
          <Text dimColor>
            The setup form writes the live configuration, so this session ends up on whatever you configure here. It is
            saved as a profile at the same time, so Enter on any row switches back.
          </Text>
        </Box>
        <Select
          options={entries.map(entry => ({
            label: entry.label,
            value: entry.value,
            description: entry.description,
          }))}
          visibleOptionCount={9}
          onChange={chooseKind}
          onCancel={() => onCancel('Add cancelled.')}
        />
      </Box>
    );
  }

  if (flow.step === 'preserve') {
    const state = flow;
    return (
      <Box flexDirection="column" padding={1}>
        {banner}
        <Text bold>Save what this session is running first?</Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <Text dimColor>
            The current configuration matches no saved profile, so once the setup form writes over it there is nothing
            to switch back to. Saving it now is the return trip.
          </Text>
        </Box>
        <Select
          options={[
            {
              label: `Save it as "${state.suggestion}"`,
              value: 'save',
              description: 'Then Enter on that row brings this session back',
            },
            {
              label: 'Continue without saving',
              value: 'skip',
              description: 'The current configuration is replaced and not kept',
            },
          ]}
          onChange={value => (value === 'save' ? preserveCurrent(state) : setFlow(afterPreserveAnswered(state)))}
          onCancel={() => onCancel('Add cancelled.')}
        />
      </Box>
    );
  }

  if (flow.step === 'name') {
    const state = flow;
    return (
      <Box flexDirection="column" padding={1}>
        {banner}
        <ProfileNamePrompt
          title={`Name the ${state.entry.label} profile`}
          hint="Letters, digits, dot, underscore and dash. This is the name you switch back to."
          value={state.draft}
          error={state.error}
          onChange={draft => setFlow({ step: 'name', entry: state.entry, draft })}
          onSubmit={() => setFlow(afterNameSubmitted(state, loadProfilesFile()))}
          onCancel={() => onCancel('Add cancelled.')}
        />
      </Box>
    );
  }

  if (flow.step === 'aggregate') {
    const state = flow;
    return (
      <Box flexDirection="column" padding={1}>
        {banner}
        <Text bold>Add &quot;{state.name}&quot; to the aggregated /model list?</Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <Text dimColor>
            Aggregating puts this provider&apos;s models in the same picker as the others. Picking one there switches
            the session to it. You can change this later with Space.
          </Text>
        </Box>
        <Select
          options={[
            {
              label: 'Yes, aggregate its models',
              value: 'yes',
              description: 'Its model list is read once the setup form is done',
            },
            { label: 'No, keep it out for now', value: 'no', description: 'Space on its row adds it later' },
          ]}
          onChange={value => enterSetup(state, value === 'yes')}
          onCancel={() => onCancel('Add cancelled.')}
        />
      </Box>
    );
  }

  if (!wizardStatus) return null;
  const state = flow;
  return (
    <Box flexDirection="column" padding={1}>
      {banner}
      <ProviderSetupWizard
        status={wizardStatus}
        setStatus={setWizardStatus}
        // The wizard hands back the state to come back to, so the failure is
        // reported over a form that still holds what was typed.
        onError={(message, retry) => {
          setNotice(message);
          setWizardStatus(retry);
        }}
        onCancel={() => onCancel('Add cancelled — nothing was configured.')}
        onSaved={() => captureSaved(state)}
      />
    </Box>
  );
}
