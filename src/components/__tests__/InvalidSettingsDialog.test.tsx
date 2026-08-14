/**
 * The settings-error dialog's escape hatches.
 *
 * The component itself is not rendered here: `Select` claims stdin and the
 * static renderer never settles (same reason FleetList.test.tsx avoids
 * keystroke pumping). The option list — the part with a decision in it — is a
 * pure function and is pinned directly. No mocks.
 */
import { describe, expect, test } from 'bun:test';
import { invalidSettingsOptions } from '../InvalidSettingsDialog.js';

describe('invalidSettingsOptions', () => {
  test('offers "Fix with Claude" first when a fix handler is wired', () => {
    // Leads on purpose: skipping the file drops every setting in it, and the
    // user usually cannot tell which key broke from the symptom.
    expect(invalidSettingsOptions({ canFix: true })).toEqual([
      { label: 'Fix with Claude', value: 'fix' },
      { label: 'Exit and fix manually', value: 'exit' },
      { label: 'Continue without these settings', value: 'continue' },
    ]);
  });

  test('hides the fix option when no handler is supplied', () => {
    // Callers with no REPL to prefill must not advertise an option that no-ops.
    expect(invalidSettingsOptions({ canFix: false })).toEqual([
      { label: 'Exit and fix manually', value: 'exit' },
      { label: 'Continue without these settings', value: 'continue' },
    ]);
  });
});
