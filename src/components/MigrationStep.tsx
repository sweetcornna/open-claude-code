import React, { useCallback, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { realFsProbe } from '../cli/handlers/migrate.js';
import {
  describeMigrationPlan,
  executeMigration,
  isMigrationSuppressed,
  type MigrationPlan,
  type MigrationResult,
  planHasWork,
  planMigrationFromClaude,
} from '../config/migrateFromClaude.js';
import { Select } from './CustomSelect/select.js';
import { PressEnterToContinue } from './PressEnterToContinue.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';

/**
 * Whether the onboarding wizard should offer the migration step at all.
 * Cheap synchronous probes only — called while assembling the steps array.
 * Offers only when a legacy ~/.claude setup exists, nothing was migrated
 * before, and there is actually something to copy.
 */
export function shouldOfferMigration(): MigrationPlan | null {
  if (isMigrationSuppressed()) return null;
  try {
    // Planned in the default (credential-free) mode: this only decides whether
    // to SHOW the step. The chosen mode is re-planned in runMigration below.
    const plan = planMigrationFromClaude(realFsProbe);
    if (!plan.sourceExists || plan.alreadyMigrated) return null;
    if (!planHasWork(plan)) return null;
    return plan;
  } catch {
    // A probe failure must never block first-run — `occ migrate` stays available.
    return null;
  }
}

type Phase = { kind: 'ask' } | { kind: 'running' } | { kind: 'done'; result: MigrationResult };

/**
 * Whether the wizard should skip its OAuth step after the migration step.
 *
 * Lives here rather than inline in Onboarding so the rule is one named,
 * testable thing. It is `credentialsAvailable`, not `credentialsMigrated`:
 * "occ already had a login and no-clobber kept it" also means /login is
 * pointless. Getting this wrong is not cosmetic — a migrated `settings.json`
 * carrying `forceLoginMethod` makes ConsoleOAuthFlow start an OAuth round trip
 * immediately, which would overwrite the token the previous step just copied.
 */
export function shouldSkipOAuthAfterMigration(result: MigrationResult | null): boolean {
  return result?.credentialsAvailable === true;
}

/**
 * First-run migration offer: shows what an `occ migrate` would copy from the
 * official Claude Code's ~/.claude and lets the user run it or skip. Skipping
 * writes nothing — the user can run `occ migrate` any time later. Reuses the
 * exact plan/execute functions the CLI command uses (read-only source, session
 * history never copied, credentials only on explicit request).
 */
export function MigrationStep({
  plan,
  onDone,
  execute = executeMigration,
}: {
  plan: MigrationPlan;
  /**
   * Receives the result so the wizard can decide what to do next — see
   * {@link shouldSkipOAuthAfterMigration}. `null` when the user skipped.
   */
  onDone(result: MigrationResult | null): void;
  /** Injected in tests; production runs the real migration. */
  execute?: (plan: MigrationPlan) => Promise<MigrationResult>;
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });

  const runMigration = useCallback(
    (migrateCredentials: boolean) => {
      // Re-plan rather than reusing `plan`: the credential decision is baked in
      // at plan time, and the prop was built in the default (credential-free)
      // mode just to decide whether to show this step.
      const effectivePlan = planMigrationFromClaude(realFsProbe, { migrateCredentials });
      setPhase({ kind: 'running' });
      void execute(effectivePlan)
        .then(result => setPhase({ kind: 'done', result }))
        .catch((e: unknown) =>
          setPhase({
            kind: 'done',
            result: {
              copied: [],
              mcpServersImported: 0,
              errors: [(e as Error).message],
              notes: [],
              credentialsMigrated: false,
              credentialsAvailable: false,
            },
          }),
        );
    },
    [execute],
  );

  useKeybindings(
    {
      'confirm:yes': () => {
        if (phase.kind !== 'done') return false;
        onDone(phase.result);
      },
    },
    { context: 'Confirmation', isActive: phase.kind === 'done' },
  );

  if (phase.kind === 'running') {
    return (
      <Box paddingLeft={1}>
        <Text>Migrating…</Text>
      </Box>
    );
  }

  if (phase.kind === 'done') {
    const { result } = phase;
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Migration complete</Text>
        <Text>
          Copied: {result.copied.join(', ') || 'nothing'}
          {result.mcpServersImported > 0 ? ` · ${result.mcpServersImported} MCP server(s)` : ''}
        </Text>
        {result.notes.length > 0 && (
          <Box flexDirection="column">
            {result.notes.map(note => (
              <Text key={note} dimColor>
                {note}
              </Text>
            ))}
          </Box>
        )}
        {result.credentialsMigrated && (
          // Said plainly and every time: the refresh token is rotated by the
          // server and both CLIs now hold the same one, so a refresh on either
          // side logs the other out. Users who hit this without warning read it
          // as occ breaking their official install.
          <Box flexDirection="column">
            <Text color="warning">Both CLIs now share one login.</Text>
            <Text dimColor>
              The server rotates the OAuth refresh token, so whichever CLI refreshes first invalidates the other. Pick
              one for day-to-day use; on the other, expect to run /login again.
            </Text>
          </Box>
        )}
        {result.errors.length > 0 && (
          <Box flexDirection="column">
            {result.errors.map(err => (
              <Text key={err} color="error">
                failed: {err}
              </Text>
            ))}
            <Text dimColor>Fix permissions and re-run `occ migrate --force` later.</Text>
          </Box>
        )}
        <PressEnterToContinue />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Migrate your Claude Code setup?</Text>
      <Box flexDirection="column" width={80}>
        {/* modeDetails:false — the mode is what the Select below is asking. */}
        {describeMigrationPlan(plan, { modeDetails: false })
          .split('\n')
          .map((line, i) => (
            <Text key={`${i}-${line.slice(0, 20)}`} dimColor={!line.startsWith('Found')}>
              {line}
            </Text>
          ))}
      </Box>
      <Select
        options={[
          {
            label: 'Yes, copy everything including account credentials',
            value: 'migrate-with-credentials',
          },
          {
            label: 'Yes, but skip credentials (settings, plugins, skills & MCP only)',
            value: 'migrate',
          },
          { label: 'No, start fresh (run `occ migrate` any time later)', value: 'skip' },
        ]}
        onChange={value => {
          if (value === 'migrate-with-credentials') {
            runMigration(true);
          } else if (value === 'migrate') {
            runMigration(false);
          } else {
            onDone(null);
          }
        }}
        onCancel={() => onDone(null)}
      />
    </Box>
  );
}
