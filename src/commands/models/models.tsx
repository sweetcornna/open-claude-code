import { Box, Dialog, Text } from '@anthropic/ink';
import * as React from 'react';
import { useState } from 'react';
import { ProviderSetupWizard } from '../../components/providerSetup/ProviderSetupWizard.js';
import { buildModelStepFromEnvironment } from '../../components/providerSetup/fromEnvironment.js';
import type { ProviderSetupStatus } from '../../components/providerSetup/state.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

/**
 * `/models` — repoint the tier aliases without redoing login.
 *
 * The same wizard step the login flows end on, seeded from the env keys already
 * in effect. Nothing about the endpoint or the credentials is asked for again:
 * they are read back out, carried through unchanged, and written out with the
 * new model assignment.
 */
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  const initial = buildModelStepFromEnvironment();
  if (!initial) {
    // isEnabled() hides the command in this case; reachable only if the provider
    // changed between listing and running.
    return (
      <Dialog title="Model tiers" onCancel={() => onDone('Model tiers unchanged.')}>
        <Text dimColor>
          This session has no configurable model tiers. Run /login to set up an API-key provider first.
        </Text>
      </Dialog>
    );
  }
  return <ModelTierSetup initial={initial} onDone={onDone} />;
}

function ModelTierSetup({
  initial,
  onDone,
}: {
  initial: ProviderSetupStatus;
  onDone: LocalJSXCommandOnDone;
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
          onSaved={() => onDone('Model tiers updated.')}
        />
      </Box>
    </Dialog>
  );
}
