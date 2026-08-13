import * as React from 'react';
import { ProviderSettingsPanel } from '../../components/providerSettings/ProviderSettingsPanel.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { getIsNonInteractiveSession } from '../../bootstrap/state/flags.js';
import { runProviderSettingsCommand } from './actions.js';
import { rehydrateProviderSession } from './sessionRehydrate.js';
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
    onDone(await runProviderSettingsCommand(parsed, context));
    return;
  }

  return (
    <ProviderSettingsPanel
      onClose={message => onDone(message)}
      onProviderSwitched={() => rehydrateProviderSession(context)}
    />
  );
}
