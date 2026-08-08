import { Box, Dialog, Text } from '@anthropic/ink';
import * as React from 'react';
import { useState } from 'react';
import { ProviderSetupWizard } from '../../components/providerSetup/ProviderSetupWizard.js';
import { buildModelStepFromEnvironment } from '../../components/providerSetup/fromEnvironment.js';
import type { ProviderSetupStatus } from '../../components/providerSetup/state.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { getInitialSettings } from '../../utils/settings/settings.js';

/**
 * `/models-setting` — repoint the tier aliases without redoing login.
 *
 * The same wizard step the login flows end on, seeded from the env keys already
 * in effect. Nothing about the endpoint or the credentials is asked for again:
 * they are read back out, carried through unchanged, and written out with the
 * new model assignment.
 */
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const initial = buildModelStepFromEnvironment();
  if (!initial) {
    // The command remains registered so a provider configured during this
    // session can open it without restarting.
    return (
      <Dialog title="Model tiers" onCancel={() => onDone('Model tiers unchanged.')}>
        <Text dimColor>
          This session has no configurable model tiers. Run /login to set up an API-key provider first.
        </Text>
      </Dialog>
    );
  }
  return <ModelTierSetup initial={initial} onDone={onDone} context={context} />;
}

function ModelTierSetup({
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

  return (
    <Dialog title="Model tiers" onCancel={() => onDone('Model tiers unchanged.')}>
      <Box flexDirection="column" gap={1}>
        {error ? <Text color="error">{error}</Text> : null}
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
          onCancel={() => onDone('Model tiers unchanged.')}
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
              ...(outcome.providerChanged ? { mainLoopModel: null, mainLoopModelForSession: null } : {}),
              effortValue: undefined,
            }));
            onDone('Model tiers updated.');
          }}
        />
      </Box>
    </Dialog>
  );
}
