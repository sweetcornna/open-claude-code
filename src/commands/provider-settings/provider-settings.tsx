import * as React from 'react';
import { ProviderSettingsPanel } from '../../components/providerSettings/ProviderSettingsPanel.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { getIsNonInteractiveSession } from '../../bootstrap/state/flags.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { runProviderSettingsCommand } from './actions.js';
import { parseArgs } from './state.js';

/**
 * `/provider-settings` (also `/providers`, `/provider`, `/api`) — bare opens
 * the panel, anything else is the scriptable form.
 *
 * The argument form is answered without rendering, the way `/model-settings`
 * does both: the rules it exercises live in ./state.ts and ./actions.ts, which
 * is also what makes them testable without an Ink tree.
 *
 * A headless run gets the LISTING for the bare form rather than an error about
 * interactivity — `/provider` answered headlessly before the two commands
 * merged, and runProviderSettingsCommand has always treated `panel` as "print
 * the useful half" for exactly this caller.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const parsed = parseArgs(args);
  if (parsed.kind !== 'panel' || getIsNonInteractiveSession()) {
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
          // activateProfile() restored this profile's per-tier effort and
          // deleted the legacy flat effortLevel. AppState is the flat value's
          // other home and outranks the per-tier layer, so leaving it here
          // would keep the previous provider's effort in force for the rest of
          // the session and make the restore look like it did nothing.
          // undefined is what lets getDefaultEffortForModel reach the tier
          // setting — the same reason ModelPicker clears it.
          effortValue: undefined,
        }))
      }
    />
  );
}
