import { Box, Dialog, Text } from '@anthropic/ink';
import * as React from 'react';
import { useState } from 'react';
import { ProviderSetupWizard } from '../../components/providerSetup/ProviderSetupWizard.js';
import type { ProviderSetupStatus } from '../../components/providerSetup/state.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { getInitialEffortSetting } from '../../utils/model/effort.js';
import { getInitialSettings } from '../../utils/settings/settings.js';

/**
 * The interactive half of `/model-settings` (was its own `/models-setting`).
 *
 * The same wizard step the login flows end on, seeded from the env keys already
 * in effect. Nothing about the endpoint or the credentials is asked for again:
 * they are read back out, carried through unchanged, and written out with the
 * new model assignment. That step already collects all three axes this command
 * owns — the per-tier model ids, thinking effort and max context — which is why
 * merging the two commands did not need a second UI built next to it.
 */
export function ModelTierSetup({
  initial,
  onDone,
  context,
}: {
  initial: ProviderSetupStatus;
  onDone: LocalJSXCommandOnDone;
  context: LocalJSXCommandContext;
}): React.ReactNode {
  const [status, setStatus] = useState<ProviderSetupStatus>(initial);
  const [error, setError] = useState<string | null>(null);
  const globalEffort = getInitialSettings().effortLevel;

  return (
    <Dialog title="Model settings" onCancel={() => onDone('Model settings unchanged.')}>
      <Box flexDirection="column" gap={1}>
        {error ? <Text color="error">{error}</Text> : null}
        {globalEffort ? (
          <Text color="warning">
            Global /effort is {globalEffort}; it overrides per-slot effort. Run /effort auto to use the values saved
            here.
          </Text>
        ) : null}
        <ProviderSetupWizard
          status={status}
          setStatus={next => {
            setError(null);
            setStatus(next);
          }}
          onError={(message, retry) => {
            setError(message);
            setStatus(retry);
          }}
          onCancel={() => onDone('Model settings unchanged.')}
          onSaved={outcome => {
            context.setAppState(prev => ({
              ...prev,
              settings: getInitialSettings(),
              // A pure effort / context / tier-mapping edit leaves an
              // in-session `/model` choice perfectly valid — a tier alias
              // re-resolves on every request. Only a different provider,
              // endpoint or default model makes the current selection wrong,
              // and clearing it unconditionally meant someone who came here to
              // change thinking effort left with a different model too.
              ...(outcome.providerChanged
                ? {
                    mainLoopModel: null,
                    mainLoopModelForSession: null,
                    effortValue: getInitialEffortSetting(),
                    sessionModelSettingsOverrides: {},
                  }
                : {}),
            }));
            onDone('Model settings updated.');
          }}
        />
      </Box>
    </Dialog>
  );
}
