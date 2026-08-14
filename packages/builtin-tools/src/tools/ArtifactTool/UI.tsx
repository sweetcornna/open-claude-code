import * as React from 'react';
import { Box, Link, Text } from '@anthropic/ink';
import type { ToolProgressData } from '@open-claude-code/tool-runtime/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import type { ArtifactOutput } from './ArtifactTool.js';
import { isLocalArtifactUrl } from './localStore.js';

export function renderToolResultMessage(
  content: ArtifactOutput,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  _options: { verbose: boolean; theme?: string },
): React.ReactNode {
  if (content.error) {
    return (
      <Box>
        <Text color="error">⚠ Artifact failed: {content.error}</Text>
      </Box>
    );
  }
  if (!content.url) return null;
  const local = isLocalArtifactUrl(content.url);
  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          <Text color="success">{local ? '✓' : '↑'}</Text> {local ? 'Artifact saved' : 'Artifact uploaded'}:{' '}
          <Link url={content.url}>
            <Text color="warning">{content.url}</Text>
          </Link>
        </Text>
      </Box>
      {content.expiresAt ? (
        <Box>
          <Text dimColor>expires: {content.expiresAt}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
