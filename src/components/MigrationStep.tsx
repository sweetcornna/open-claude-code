import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { realFsProbe } from '../cli/handlers/migrate.js';
import {
  describeMigrationPlan,
  executeMigration,
  isMigrationSuppressed,
  type MigrationPlan,
  type MigrationResult,
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
    const plan = planMigrationFromClaude(realFsProbe);
    if (!plan.sourceExists || plan.alreadyMigrated) return null;
    if (plan.items.length === 0 && plan.mcpServerCount === 0) return null;
    return plan;
  } catch {
    // A probe failure must never block first-run — `occ migrate` stays available.
    return null;
  }
}

type Phase = { kind: 'ask' } | { kind: 'running' } | { kind: 'done'; result: MigrationResult };

/**
 * First-run migration offer: shows what an `occ migrate` would copy from the
 * official Claude Code's ~/.claude and lets the user run it or skip. Skipping
 * writes nothing — the user can run `occ migrate` any time later. Reuses the
 * exact plan/execute functions the CLI command uses (read-only source, never
 * copies credentials or session history).
 */
export function MigrationStep({ plan, onDone }: { plan: MigrationPlan; onDone(): void }): React.ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });

  const runMigration = useCallback(
    (skipAccountData: boolean) => {
      // Re-plan rather than reusing `plan`: the account-bound exclusions are
      // decided at plan time, so the prop (built without them) would still
      // carry plugins, skills and MCP servers.
      const effectivePlan = skipAccountData ? planMigrationFromClaude(realFsProbe, { skipAccountData: true }) : plan;
      setPhase({ kind: 'running' });
      void executeMigration(effectivePlan)
        .then(result => setPhase({ kind: 'done', result }))
        .catch((e: unknown) =>
          setPhase({
            kind: 'done',
            result: { copied: [], mcpServersImported: 0, errors: [(e as Error).message] },
          }),
        );
    },
    [plan],
  );

  useKeybindings(
    {
      'confirm:yes': () => {
        if (phase.kind !== 'done') return false;
        onDone();
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
        {describeMigrationPlan(plan)
          .split('\n')
          .map((line, i) => (
            <Text key={`${i}-${line.slice(0, 20)}`} dimColor={!line.startsWith('Found')}>
              {line}
            </Text>
          ))}
      </Box>
      <Select
        options={[
          { label: 'Yes, copy my settings and extensions', value: 'migrate' },
          {
            label: 'Yes, but skip account data (no plugins, skills or MCP servers)',
            value: 'migrate-no-account',
          },
          { label: 'No, start fresh (run `occ migrate` any time later)', value: 'skip' },
        ]}
        onChange={value => {
          if (value === 'migrate') {
            runMigration(false);
          } else if (value === 'migrate-no-account') {
            runMigration(true);
          } else {
            onDone();
          }
        }}
        onCancel={onDone}
      />
    </Box>
  );
}
