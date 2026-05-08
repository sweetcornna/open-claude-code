import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { Select } from './CustomSelect/select.js';
import { PermissionDialog } from './permissions/PermissionDialog.js';

type ToolSearchHintItem = {
  name: string;
  description: string;
  score: number;
};

type Props = {
  tools: ToolSearchHintItem[];
  onSelect: (toolName: string) => void;
  onDismiss: () => void;
};

const AUTO_DISMISS_MS = 30_000;

export function ToolSearchHint({ tools, onSelect, onDismiss }: Props): React.ReactNode {
  const onSelectRef = React.useRef(onSelect);
  const onDismissRef = React.useRef(onDismiss);
  onSelectRef.current = onSelect;
  onDismissRef.current = onDismiss;

  React.useEffect(() => {
    const timeoutId = setTimeout(ref => ref.current(), AUTO_DISMISS_MS, onDismissRef);
    return () => clearTimeout(timeoutId);
  }, []);

  const options = tools.map(t => ({
    label: `${t.name} — ${t.description.slice(0, 60)} (score: ${t.score.toFixed(2)})`,
    value: t.name,
  }));

  options.push({ label: 'Dismiss', value: '__dismiss__' });

  return (
    <PermissionDialog title="Tool Recommendation">
      <Select
        options={options}
        onChange={value => {
          if (value === '__dismiss__') {
            onDismissRef.current();
          } else {
            onDismissRef.current();
            onSelectRef.current(value);
          }
        }}
      />
    </PermissionDialog>
  );
}
