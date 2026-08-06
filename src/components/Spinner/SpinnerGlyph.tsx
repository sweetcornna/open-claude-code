import * as React from 'react';
import { Box, Text, useTheme } from '@anthropic/ink';
import { getTheme, type Theme } from '../../utils/terminal/theme.js';
import { getDefaultCharacters, getStalledColor } from './utils.js';

const DEFAULT_CHARACTERS = getDefaultCharacters();

const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];

const REDUCED_MOTION_DOT = '●';
const REDUCED_MOTION_CYCLE_MS = 2000; // 2-second cycle: 1s visible, 1s dim

type Props = {
  frame: number;
  messageColor: keyof Theme;
  stalledIntensity?: number;
  /** See getStalledColor — picks the warning vs. error stall colour. */
  hasReceivedData?: boolean;
  reducedMotion?: boolean;
  time?: number;
};

export function SpinnerGlyph({
  frame,
  messageColor,
  stalledIntensity = 0,
  hasReceivedData = true,
  reducedMotion = false,
  time = 0,
}: Props): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // Reduced motion: slowly flashing orange dot
  if (reducedMotion) {
    const isDim = Math.floor(time / (REDUCED_MOTION_CYCLE_MS / 2)) % 2 === 1;
    return (
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={messageColor} dimColor={isDim}>
          {REDUCED_MOTION_DOT}
        </Text>
      </Box>
    );
  }

  const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];

  // Smoothly drain the current color toward warning (slow) or error (silent)
  if (stalledIntensity > 0) {
    const targetKey: keyof Theme = hasReceivedData ? 'warning' : 'error';
    const color =
      getStalledColor(theme[messageColor], theme[targetKey], stalledIntensity) ??
      (stalledIntensity > 0.5 ? targetKey : messageColor);
    return (
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={color}>{spinnerChar}</Text>
      </Box>
    );
  }

  return (
    <Box flexWrap="wrap" height={1} width={2}>
      <Text color={messageColor}>{spinnerChar}</Text>
    </Box>
  );
}
