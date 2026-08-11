/**
 * One text field asking for a profile name — used by the add flow's naming
 * step and by rename, because both are the same question with the same rules
 * (`validateNewProfileName` / `planProfileRename` reject the same strings) and
 * a second layout would drift from the first the moment one of them grew a
 * hint.
 *
 * Esc is `confirm:no` rather than a raw key check, matching the setup wizard:
 * the panel's own useInput is switched off while this is on screen, so the only
 * handler that can answer for Esc is this one.
 */

import { Box, Text } from '@anthropic/ink';
import * as React from 'react';
import { useState } from 'react';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import TextInput from '../TextInput.js';

type ProfileNamePromptProps = {
  title: string;
  hint: string;
  value: string;
  /** Why the last submission was refused; the field keeps what was typed. */
  error?: string | undefined;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function ProfileNamePrompt({
  title,
  hint,
  value,
  error,
  onChange,
  onSubmit,
  onCancel,
}: ProfileNamePromptProps): React.ReactNode {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const columns = Math.max(20, useTerminalSize().columns - 18);

  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box>
        <Text backgroundColor="suggestion" color="inverseText">
          {' Name '}
        </Text>
        <Text> </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={columns}
          focus={true}
        />
      </Box>
      {error ? <Text color="warning">{error}</Text> : null}
      <Text dimColor>Enter confirms · Esc cancels</Text>
    </Box>
  );
}
