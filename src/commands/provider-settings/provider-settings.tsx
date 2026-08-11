import * as React from 'react';
import { ProviderSettingsPanel } from '../../components/providerSettings/ProviderSettingsPanel.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { runProviderSettingsCommand } from './actions.js';
import { parseArgs } from './state.js';

/**
 * `/provider-settings` — bare opens the panel, anything else is the scriptable
 * form.
 *
 * The argument form is answered without rendering, the way `/model-settings`
 * does both: the rules it exercises live in ./state.ts and ./actions.ts, which
 * is also what makes them testable without an Ink tree.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const parsed = parseArgs(args);
  if (parsed.kind !== 'panel') {
    onDone(await runProviderSettingsCommand(parsed));
    return;
  }

  return (
    <ProviderSettingsPanel
      onClose={message => onDone(message)}
      onProviderSwitched={() =>
        context.setAppState(prev => ({
          ...prev,
          // settings.env was rewritten under the session by activateProfile().
          settings: getInitialSettings(),
          // The previous provider's model is not necessarily one this provider
          // serves, and a stale pin outlives the switch as a 404 per request.
          mainLoopModel: null,
          mainLoopModelForSession: null,
        }))
      }
    />
  );
}
