import { feature } from 'bun:bundle';
import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Text } from '@anthropic/ink';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import {
  calculateTokenWarningState,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js';
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js';
import { getUpgradeMessage } from '../utils/model/contextWindowUpgradeCheck.js';
import type { ModelSettingsSlot, SessionModelSettingsOverrides } from '../utils/model/modelTier.js';

type Props = {
  tokenUsage: number;
  model: string;
  settingsSlot?: ModelSettingsSlot;
  sessionOverrides?: SessionModelSettingsOverrides;
};

export function TokenWarning({ tokenUsage, model, settingsSlot, sessionOverrides }: Props): React.ReactNode {
  const { percentLeft, isAboveWarningThreshold, isAboveErrorThreshold } = calculateTokenWarningState(
    tokenUsage,
    model,
    settingsSlot,
    sessionOverrides,
  );

  // Use reactive hook to check if warning should be suppressed
  const suppressWarning = useCompactWarningSuppression();

  if (!isAboveWarningThreshold || suppressWarning) {
    return null;
  }

  const showAutoCompactWarning = isAutoCompactEnabled();
  const upgradeMessage = getUpgradeMessage('warning');

  // Reactive-only or context-collapse mode: proactive autocompact never
  // fires, so percentLeft's normal calculation (against the autocompact
  // threshold) counts down to an event that won't happen. Recompute
  // against the effective window so the percentage is honest.
  //
  // Each feature() block stands alone so the flag strings DCE from
  // external builds independently.
  let displayPercentLeft = percentLeft;
  let reactiveOnlyMode = false;
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      reactiveOnlyMode = true;
    }
  }
  if (reactiveOnlyMode) {
    const effectiveWindow = getEffectiveContextWindowSize(model, settingsSlot, sessionOverrides);
    displayPercentLeft = Math.max(0, Math.round(((effectiveWindow - tokenUsage) / effectiveWindow) * 100));
  }

  const autocompactLabel = reactiveOnlyMode
    ? `${100 - displayPercentLeft}% context used`
    : `${displayPercentLeft}% until auto-compact`;

  return (
    <Box flexDirection="row">
      {showAutoCompactWarning ? (
        <Text dimColor wrap="truncate">
          {upgradeMessage ? `${autocompactLabel} \u00b7 ${upgradeMessage}` : autocompactLabel}
        </Text>
      ) : (
        <Text color={isAboveErrorThreshold ? 'error' : 'warning'} wrap="truncate">
          {upgradeMessage
            ? `Context low (${percentLeft}% remaining) \u00b7 ${upgradeMessage}`
            : `Context low (${percentLeft}% remaining) \u00b7 Run /compact to compact & continue`}
        </Text>
      )}
    </Box>
  );
}
