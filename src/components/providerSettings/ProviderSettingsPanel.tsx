/**
 * /provider-settings — the saved provider profiles, and which of them feed the
 * aggregated model list.
 *
 * Four things a row can do:
 *   - Enter switches this session to that profile. That is `activateProfile()`
 *     and only that: the whole-shape settings.env write plus the client-cache
 *     clear lives there and must have exactly one implementation.
 *   - Space opts the profile into (or out of) the aggregated `/model` list.
 *     Strict opt-in — having once fetched a model list is not consent to
 *     splice it into every other provider's picker.
 *   - `r` re-reads that profile's `/models` endpoint into its snapshot, using
 *     the credentials the PROFILE saved, so a provider you are not currently
 *     talking to can still be refreshed.
 *   - `d` twice deletes it. Twice because there is no undo and the registry is
 *     the only copy of a relay's endpoint.
 *
 * Credentials are never rendered. The rows show endpoints, model counts and
 * whether a key exists — never the key, not even masked.
 *
 * Interaction copies /search-setting and /web-tools: ↑/↓ move, Space/Enter
 * act, Esc closes (or cancels an in-flight refresh first), Ctrl+C/D exit
 * through the shared hook.
 */

import { Box, Text, useInput } from '@anthropic/ink';
import * as React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { refreshProfileCatalog } from '../../commands/provider-settings/catalogRefresh.js';
import {
  buildProviderRows,
  describeCredential,
  EMPTY_REGISTRY_HINT,
  summarizeAggregate,
  type ProviderRow,
} from '../../commands/provider-settings/state.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { buildAggregatedModels } from '../../services/providerProfiles/aggregate.js';
import { activateProfile, deleteProfile } from '../../services/providerProfiles/activate.js';
import { loadProfilesFile, updateProfileCatalog } from '../../services/providerProfiles/profiles.js';

type ProviderSettingsPanelProps = {
  onClose: (message?: string) => void;
  /** Session state to re-seed after a switch. Absent in tests and previews. */
  onProviderSwitched?: () => void;
};

export function ProviderSettingsPanel({ onClose, onProviderSwitched }: ProviderSettingsPanelProps): React.ReactNode {
  const insideModal = useIsInsideModal();
  const { rows: terminalRows } = useTerminalSize();
  const contentHeight = insideModal ? terminalRows + 1 : Math.max(14, Math.min(Math.floor(terminalRows * 0.7), 26));
  useExitOnCtrlCDWithKeybindings();

  // Bumped after every mutation so the registry is re-read from disk rather
  // than patched in memory: activateProfile and updateProfileCatalog each
  // rewrite the whole file, and a locally patched copy would drift from it.
  const [version, setVersion] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const refreshAbort = useRef<AbortController | undefined>(undefined);

  const { rows, aggregateSummary } = useMemo(() => {
    // `version` is the dependency: it is what says the file changed.
    void version;
    const file = loadProfilesFile();
    const providerRows = buildProviderRows(file);
    return {
      rows: providerRows,
      aggregateSummary: summarizeAggregate(providerRows, buildAggregatedModels(file)),
    };
  }, [version]);

  const reload = useCallback(() => setVersion(v => v + 1), []);
  const boundedCursor = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);
  const current: ProviderRow | undefined = rows[boundedCursor];

  const switchTo = useCallback(
    (row: ProviderRow) => {
      const result = activateProfile(row.name);
      if ('error' in result) {
        setNotice(result.error);
        return;
      }
      // Same reseed the login wizard does: settings.env was rewritten under
      // the session, and a model chosen for the previous provider is not
      // necessarily one this one serves.
      onProviderSwitched?.();
      reload();
      setNotice(`Switched to "${row.name}" (${result.profile.modelType}).`);
    },
    [onProviderSwitched, reload],
  );

  const toggleAggregate = useCallback(
    (row: ProviderRow) => {
      const result = updateProfileCatalog(row.name, { aggregate: !row.aggregate });
      if ('error' in result) {
        setNotice(result.error);
        return;
      }
      reload();
      if (row.aggregate) {
        setNotice(`"${row.name}" no longer contributes to the aggregated model list.`);
      } else if (row.modelCount === 0) {
        setNotice(`"${row.name}" is in the aggregated list but has no models yet — press R to read them.`);
      } else {
        setNotice(`"${row.name}" contributes ${row.modelCount} models to the aggregated list.`);
      }
    },
    [reload],
  );

  const refresh = useCallback(
    (row: ProviderRow) => {
      if (busy) return;
      const controller = new AbortController();
      refreshAbort.current = controller;
      setBusy(row.name);
      setNotice(`Reading the model list for "${row.name}"… (Esc cancels)`);

      void refreshProfileCatalog(row.name, { signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted) {
            setNotice(`Refresh of "${row.name}" cancelled.`);
            return;
          }
          if ('error' in result) {
            setNotice(result.error);
            return;
          }
          reload();
          setNotice(`Read ${result.models.length} models for "${row.name}".`);
        })
        .catch((error: unknown) => {
          // refreshProfileCatalog is documented not to throw; if it ever does,
          // the panel must still come back to a usable state.
          setNotice(`Refresh of "${row.name}" failed: ${String(error)}`);
        })
        .finally(() => {
          if (refreshAbort.current === controller) refreshAbort.current = undefined;
          setBusy(null);
        });
    },
    [busy, reload],
  );

  const remove = useCallback(
    (row: ProviderRow) => {
      if (pendingDelete !== row.name) {
        setPendingDelete(row.name);
        setNotice(`Press D again to delete "${row.name}". There is no undo.`);
        return;
      }
      setPendingDelete(null);
      const result = deleteProfile(row.name);
      if ('error' in result) {
        setNotice(result.error);
        return;
      }
      setCursor(c => Math.max(0, Math.min(c, rows.length - 2)));
      reload();
      setNotice(`Deleted "${row.name}".`);
    },
    [pendingDelete, reload, rows.length],
  );

  useInput((input, key) => {
    if (key.upArrow) {
      setPendingDelete(null);
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setPendingDelete(null);
      setCursor(c => Math.min(c + 1, Math.max(0, rows.length - 1)));
      return;
    }
    if (key.escape) {
      // Cancel before closing: a refresh left running behind a closed panel
      // would write a snapshot nobody is waiting for.
      if (busy && refreshAbort.current) {
        refreshAbort.current.abort();
        refreshAbort.current = undefined;
        setNotice('Cancelling…');
        return;
      }
      onClose('Provider settings closed.');
      return;
    }
    if (!current || busy) return;
    if (key.return) {
      switchTo(current);
      return;
    }
    if (input === ' ') {
      toggleAggregate(current);
      return;
    }
    if (input === 'r' || input === 'R') {
      refresh(current);
      return;
    }
    if (input === 'd' || input === 'D') {
      remove(current);
    }
  });

  const nameWidth = Math.max(1, ...rows.map(row => row.name.length));
  const typeWidth = Math.max(1, ...rows.map(row => row.modelType.length));

  return (
    <Box flexDirection="column" padding={1} height={contentHeight}>
      <Text bold>Provider profiles</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Enter switches this session to a profile. Space adds its models to the aggregated /model list, where a model
          served by two providers is tagged with the one that owns it.
        </Text>
      </Box>

      {rows.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{EMPTY_REGISTRY_HINT}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((row, index) => {
            const isCursor = index === boundedCursor;
            return (
              <Box key={row.name} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={row.active ? 'success' : undefined}>
                    {isCursor ? '›' : ' '} {row.active ? '*' : ' '} {row.aggregate ? '[x]' : '[ ]'}{' '}
                  </Text>
                  <Text
                    bold={row.active}
                    backgroundColor={isCursor ? 'suggestion' : undefined}
                    color={isCursor ? 'inverseText' : undefined}
                  >
                    {row.name.padEnd(nameWidth)}
                  </Text>
                  <Text dimColor>
                    {'  '}
                    {row.modelType.padEnd(typeWidth)}
                    {'  '}
                    {String(row.modelCount).padStart(3)} models
                    {busy === row.name ? '  reading…' : ''}
                  </Text>
                </Box>
                {isCursor ? (
                  <Box marginLeft={6} flexDirection="column">
                    <Text dimColor>
                      {row.endpoint ?? '(provider default endpoint)'} · {describeCredential(row)}
                    </Text>
                    {row.notes ? <Text dimColor>{row.notes}</Text> : null}
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{aggregateSummary}</Text>
      </Box>

      {notice ? (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {busy
            ? '↑↓ navigate · Esc cancel refresh'
            : '↑↓ navigate · Enter switch · Space aggregate · R refresh models · D delete · Esc close'}
        </Text>
      </Box>
    </Box>
  );
}
