import * as React from 'react';
import { Box, Text, stringWidth, wrapText } from '@anthropic/ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { formatNumber } from '../utils/text/format.js';
import type { Theme } from '../utils/terminal/theme.js';

type Props = {
  agentType: string;
  description?: string;
  name?: string;
  descriptionColor?: keyof Theme;
  taskDescription?: string;
  toolUseCount: number;
  tokens: number | null;
  color?: keyof Theme;
  isLast: boolean;
  isResolved: boolean;
  isError: boolean;
  isAsync?: boolean;
  shouldAnimate: boolean;
  /**
   * What the parent sent this agent to do. Shown instead of the live tool
   * activity while the agent runs — with several agents in the list, "who owns
   * what" is the thing the user needs, not what each one is touching right now.
   */
  objective?: string | null;
  lastToolInfo?: string | null;
  hideType?: boolean;
};

/** Left indent shared by both rows of an agent entry, in terminal columns. */
const TREE_PADDING_LEFT = 3;

export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  toolUseCount,
  tokens,
  color,
  isLast,
  isResolved,
  isError: _isError,
  isAsync = false,
  shouldAnimate: _shouldAnimate,
  objective,
  lastToolInfo,
  hideType = false,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const treeChar = isLast ? '└─' : '├─';
  const isBackgrounded = isAsync && isResolved;
  const statusPrefix = isLast ? '   ⎿  ' : '│  ⎿  ';

  // Determine the status text
  const getStatusText = (): string => {
    if (!isResolved) {
      if (objective) {
        // The objective is already capped in characters; clamp it again to the
        // columns actually left after the indent so the row can't wrap.
        const available = columns - TREE_PADDING_LEFT - stringWidth(statusPrefix);
        return wrapText(objective, Math.max(1, available), 'truncate-end');
      }
      return lastToolInfo || 'Initializing…';
    }
    if (isBackgrounded) {
      return taskDescription ?? 'Running in the background';
    }
    return 'Done';
  };

  return (
    <Box flexDirection="column">
      <Box paddingLeft={TREE_PADDING_LEFT}>
        <Text dimColor>{treeChar} </Text>
        <Text dimColor={!isResolved}>
          {hideType ? (
            <>
              <Text bold>{name ?? description ?? agentType}</Text>
              {name && description && <Text dimColor>: {description}</Text>}
            </>
          ) : (
            <>
              <Text bold backgroundColor={color} color={color ? 'inverseText' : undefined}>
                {agentType}
              </Text>
              {description && (
                <>
                  {' ('}
                  <Text backgroundColor={descriptionColor} color={descriptionColor ? 'inverseText' : undefined}>
                    {description}
                  </Text>
                  {')'}
                </>
              )}
            </>
          )}
          {!isBackgrounded && (
            <>
              {' · '}
              {toolUseCount} tool {toolUseCount === 1 ? 'use' : 'uses'}
              {tokens !== null && <> · {formatNumber(tokens)} tokens</>}
            </>
          )}
        </Text>
      </Box>
      {!isBackgrounded && (
        <Box paddingLeft={TREE_PADDING_LEFT} flexDirection="row">
          <Text dimColor>{statusPrefix}</Text>
          <Text dimColor>{getStatusText()}</Text>
        </Box>
      )}
    </Box>
  );
}
