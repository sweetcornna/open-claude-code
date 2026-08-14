import React from 'react';
import { Text, Dialog } from '@anthropic/ink';
import type { ValidationError } from '../utils/settings/validation.js';
import { Select } from './CustomSelect/index.js';
import { ValidationErrorsList } from './ValidationErrorsList.js';

type Props = {
  settingsErrors: ValidationError[];
  onContinue: () => void;
  /**
   * Hand the errors to the session as a prefilled first prompt. Optional so
   * callers that have no REPL to prefill (tests, non-interactive shells) can
   * omit it — the option is hidden when it is absent.
   */
  onFix?: () => void;
  onExit: () => void;
};

export type InvalidSettingsChoice = 'fix' | 'exit' | 'continue';

/**
 * The dialog's option list.
 *
 * Extracted as a pure function because the dialog itself cannot be rendered in
 * a unit test — `Select` takes over stdin and the static renderer never
 * settles. This is the part with a decision in it, so it is the part that gets
 * pinned.
 *
 * "Fix with Claude" leads when available: skipping a settings file drops
 * *every* setting in it, and the user usually cannot tell from the symptom
 * which key broke. It is omitted entirely when the caller passed no handler,
 * so the dialog never advertises an option that does nothing.
 */
export function invalidSettingsOptions(options: {
  canFix: boolean;
}): Array<{ label: string; value: InvalidSettingsChoice }> {
  return [
    ...(options.canFix ? ([{ label: 'Fix with Claude', value: 'fix' }] as const) : []),
    { label: 'Exit and fix manually', value: 'exit' },
    { label: 'Continue without these settings', value: 'continue' },
  ];
}

/**
 * Dialog shown when settings files have validation errors.
 *
 * Three exits: hand the errors to Claude, quit and edit by hand, or continue
 * with the offending files skipped.
 */
export function InvalidSettingsDialog({ settingsErrors, onContinue, onFix, onExit }: Props): React.ReactNode {
  function handleSelect(value: string): void {
    if (value === 'exit') {
      onExit();
    } else if (value === 'fix') {
      onFix?.();
    } else {
      onContinue();
    }
  }

  return (
    <Dialog title="Settings Error" onCancel={onExit} color="warning">
      <ValidationErrorsList errors={settingsErrors} />
      <Text dimColor>Files with errors are skipped entirely, not just the invalid settings.</Text>
      <Select options={invalidSettingsOptions({ canFix: Boolean(onFix) })} onChange={handleSelect} />
    </Dialog>
  );
}
