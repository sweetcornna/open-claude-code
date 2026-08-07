import * as React from 'react';
import { useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { formatAPIError } from '@ant/model-provider';
import type { SystemAPIErrorMessage } from 'src/types/message.js';
import { useInterval } from 'usehooks-ts';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { MessageResponse } from '../MessageResponse.js';
import { getTimeoutHintEnvVar } from 'src/utils/network/timeoutHint.js';

const MAX_API_ERROR_CHARS = 1000;

type Props = {
  message: SystemAPIErrorMessage;
  verbose: boolean;
};

export function SystemAPIErrorMessage({
  message: { retryAttempt, error, retryInMs, maxRetries },
  verbose,
}: Props): React.ReactNode {
  const _retryAttempt = retryAttempt as number;
  const _retryInMs = retryInMs as number;
  const _maxRetries = maxRetries as number;
  const _error = error as Parameters<typeof formatAPIError>[0];
  // Hidden for early retries on external builds to avoid noise. Compute before
  // useInterval so we never register a timer that just drives a null render.
  const hidden = process.env.USER_TYPE === 'external' && _retryAttempt < 4;

  const [countdownMs, setCountdownMs] = useState(0);
  const done = countdownMs >= _retryInMs;
  useInterval(() => setCountdownMs(ms => ms + 1000), hidden || done ? null : 1000);

  if (hidden) {
    return null;
  }

  const retryInSecondsLive = Math.max(0, Math.round((_retryInMs - countdownMs) / 1000));

  const formatted = formatAPIError(_error);
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS;

  // The hint used to be unconditional whenever API_TIMEOUT_MS was set, so the
  // commonest error of all — `terminated`, a socket the transport tore down —
  // came with "try increasing it". Raising a deadline cannot keep a socket
  // alive; it only delays the identical failure. Now the error picks its own
  // knob, and errors no knob governs get no advice.
  const hintEnvVar = getTimeoutHintEnvVar(formatted);
  const hintValue = hintEnvVar ? process.env[hintEnvVar] : undefined;

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{truncated ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…' : formatted}</Text>
        {truncated && <CtrlOToExpand />}
        <Text dimColor>
          {/* Once the backoff has elapsed the line used to sit at "Retrying in
              0 seconds…" for however long the next attempt takes — up to the
              full request deadline — which reads as frozen. */}
          {retryInSecondsLive > 0
            ? `Retrying in ${retryInSecondsLive} ${retryInSecondsLive === 1 ? 'second' : 'seconds'}… `
            : 'Retrying now… '}
          (attempt {_retryAttempt}/{_maxRetries})
          {hintEnvVar && hintValue ? ` · ${hintEnvVar}=${hintValue}ms, try increasing it` : ''}
        </Text>
      </Box>
    </MessageResponse>
  );
}
