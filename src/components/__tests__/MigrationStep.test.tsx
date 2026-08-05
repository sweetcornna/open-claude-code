import { expect, test } from 'bun:test';
import type { MigrationResult } from '../../config/migrateFromClaude.js';
import { shouldSkipOAuthAfterMigration } from '../MigrationStep.js';

/**
 * The wizard's migration step used to swallow its own result: `onDone` took no
 * arguments, so Onboarding rendered ConsoleOAuthFlow immediately after copying
 * the user's token. With a migrated `forceLoginMethod` in settings that flow
 * starts an OAuth round trip on mount, which overwrites what was just migrated.
 *
 * The Select-driven half is not rendered here on purpose — Ink's test mode does
 * not pump concurrent state updates, so multi-keystroke tests in this repo are
 * unreliable (see WorkflowsPanel.test.tsx and WorkspaceKeyInput.test.tsx). What
 * IS pinned is the decision itself, which is the part with a rule in it.
 */

function result(overrides: Partial<MigrationResult> = {}): MigrationResult {
  return {
    copied: [],
    mcpServersImported: 0,
    errors: [],
    notes: [],
    credentialsMigrated: false,
    credentialsAvailable: false,
    ...overrides,
  };
}

test('a migration that copied credentials skips the OAuth step', () => {
  expect(shouldSkipOAuthAfterMigration(result({ credentialsMigrated: true, credentialsAvailable: true }))).toBe(true);
});

test('an existing occ login also skips it — no-clobber kept a working token', () => {
  // credentialsMigrated is false here (we wrote nothing), but /login is still
  // pointless. Keying the decision on `credentialsMigrated` would send this
  // user through OAuth for a token they already have.
  expect(shouldSkipOAuthAfterMigration(result({ credentialsAvailable: true }))).toBe(true);
});

test('a credential-free migration still needs the OAuth step', () => {
  expect(shouldSkipOAuthAfterMigration(result({ copied: ['skills', 'settings.json'] }))).toBe(false);
});

test('a failed credential migration does not skip the OAuth step', () => {
  // The failure path is exactly when the user needs /login most.
  expect(shouldSkipOAuthAfterMigration(result({ errors: ['credentials: keychain is locked'] }))).toBe(false);
});

test('skipping the migration entirely leaves the OAuth step in place', () => {
  expect(shouldSkipOAuthAfterMigration(null)).toBe(false);
});
