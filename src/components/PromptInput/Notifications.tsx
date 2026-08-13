import { feature } from 'bun:bundle';
import * as React from 'react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  type Notification,
  shouldDisplayNotification,
  sortPinnedNotifications,
  useNotifications,
} from 'src/context/notifications.js';
import { logEvent } from 'src/services/analytics/index.js';
import { setPluginUpdateNotifier } from 'src/services/autoUpdate/pluginUpdateNotifier.js';
import { setBackgroundUpdateNotifier } from 'src/services/autoUpdate/updateNotifier.js';
import { useAppState } from 'src/state/AppState.js';
import { useVoiceState } from '../../context/voice.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import { useIdeConnectionStatus } from '../../hooks/useIdeConnectionStatus.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useVoiceEnabled } from '../../hooks/useVoiceEnabled.js';
import { Box, Text } from '@anthropic/ink';
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js';
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import type { Message } from '../../types/message.js';
import { getApiKeyHelperElapsedMs, getConfiguredApiKeyHelper, getSubscriptionType } from '../../utils/auth/auth.js';
import { getExternalEditor } from '../../utils/terminal/editor.js';
import { isEnvTruthy } from '../../utils/config/envUtils.js';
import { formatDuration } from '../../utils/text/format.js';
import { setEnvHookNotifier } from '../../utils/hooks/fileChangedWatcher.js';
import { toIDEDisplayName } from '../../utils/terminal/ide.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { getMainLoopModelSettingsSlot } from '../../utils/model/model.js';
import type { ModelSettingsSlot, SessionModelSettingsOverrides } from '../../utils/model/modelTier.js';
import { tokenCountFromLastAPIResponse } from '../../utils/session/tokens.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { IdeStatusIndicator } from '../IdeStatusIndicator.js';
import { MemoryUsageIndicator } from '../MemoryUsageIndicator.js';
import { SentryErrorBoundary } from '../SentryErrorBoundary.js';
import { TokenWarning } from '../TokenWarning.js';
import { SandboxPromptFooterHint } from './SandboxPromptFooterHint.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const VoiceIndicator: typeof import('./VoiceIndicator.js').VoiceIndicator = feature('VOICE_MODE')
  ? require('./VoiceIndicator.js').VoiceIndicator
  : () => null;
/* eslint-enable @typescript-eslint/no-require-imports */

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000;

type Props = {
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  verbose: boolean;
  messages: Message[];
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  isInputWrapped?: boolean;
  isNarrow?: boolean;
};

export function Notifications({
  apiKeyStatus,
  debug,
  verbose,
  messages,
  ideSelection,
  mcpClients,
  isInputWrapped = false,
  isNarrow = false,
}: Props): ReactNode {
  const tokenUsage = useMemo(() => {
    const messagesForTokenCount = getMessagesAfterCompactBoundary(messages);
    return tokenCountFromLastAPIResponse(messagesForTokenCount);
  }, [messages]);

  // AppState-sourced model — same source as API requests. getMainLoopModel()
  // re-reads settings.json on every call, so another session's /model write
  // would leak into this session's display (anthropics/claude-code#37596).
  const mainLoopModel = useMainLoopModel();
  const sessionModelSettingsOverrides = useAppState(s => s.sessionModelSettingsOverrides);
  const autoCompactWindow = useAppState(s => s.autoCompactWindow);
  const autoCompactWindowOverride = useAppState(s => s.autoCompactWindowOverride);
  const modelSettingsSlot = getMainLoopModelSettingsSlot(mainLoopModel);
  const compactContext = {
    settingsSlot: modelSettingsSlot,
    sessionOverrides: sessionModelSettingsOverrides,
    autoCompactWindow,
    autoCompactWindowOverride,
  };
  const isShowingCompactMessage = calculateTokenWarningState(
    tokenUsage,
    mainLoopModel,
    compactContext,
  ).isAboveWarningThreshold;
  const { status: ideStatus } = useIdeConnectionStatus(mcpClients);
  const notifications = useAppState(s => s.notifications);
  const diffPanelVisible = useAppState(s => s.diffPanelVisible);
  const { addNotification, removeNotification } = useNotifications();
  const claudeAiLimits = useClaudeAiLimits();

  // Register env hook notifier for CwdChanged/FileChanged feedback
  useEffect(() => {
    setEnvHookNotifier((text, isError) => {
      addNotification({
        key: 'env-hook',
        text,
        color: isError ? 'error' : undefined,
        priority: isError ? 'medium' : 'low',
        timeoutMs: isError ? 8000 : 5000,
      });
    });
    return () => setEnvHookNotifier(null);
  }, [addNotification]);

  // Register the background self-updater's notifier (services/autoUpdate).
  // The service has no React access, so it hands its one-line success notice
  // through this registry — same pattern as setEnvHookNotifier above. Low
  // priority + no color renders it dim: informational, never interrupting.
  useEffect(() => {
    setBackgroundUpdateNotifier(text => {
      addNotification({
        key: 'background-occ-update',
        text,
        priority: 'low',
        timeoutMs: 15000,
      });
    });
    return () => setBackgroundUpdateNotifier(null);
  }, [addNotification]);

  // Same registry pattern for the background plugin-marketplace updater, but
  // green (color: 'success'): a completed action the user can act on, not an
  // ambient hint. Matches usePluginAutoupdateNotification, the startup
  // autoupdate path's notice, so both read alike.
  useEffect(() => {
    setPluginUpdateNotifier(text => {
      addNotification({
        key: 'background-plugin-update',
        text,
        color: 'success',
        priority: 'low',
        timeoutMs: 15000,
      });
    });
    return () => setPluginUpdateNotifier(null);
  }, [addNotification]);

  // Check if we should show the IDE selection indicator
  const shouldShowIdeSelection =
    ideStatus === 'connected' && (ideSelection?.filePath || (ideSelection?.text && ideSelection.lineCount > 0));

  // Check if we're in overage mode for UI indicators
  const isInOverageMode = claudeAiLimits.isUsingOverage;
  const subscriptionType = getSubscriptionType();
  const isTeamOrEnterprise = subscriptionType === 'team' || subscriptionType === 'enterprise';

  // Check if the external editor hint should be shown
  const editor = getExternalEditor();
  const shouldShowExternalEditorHint =
    isInputWrapped &&
    !isShowingCompactMessage &&
    apiKeyStatus !== 'invalid' &&
    apiKeyStatus !== 'missing' &&
    editor !== undefined;

  // Show external editor hint as notification when input is wrapped
  useEffect(() => {
    if (shouldShowExternalEditorHint && editor) {
      logEvent('tengu_external_editor_hint_shown', {});
      addNotification({
        key: 'external-editor-hint',
        jsx: (
          <Text dimColor>
            <ConfigurableShortcutHint
              action="chat:externalEditor"
              context="Chat"
              fallback="ctrl+g"
              description={`edit in ${toIDEDisplayName(editor)}`}
            />
          </Text>
        ),
        priority: 'immediate',
        timeoutMs: 5000,
      });
    } else {
      removeNotification('external-editor-hint');
    }
  }, [shouldShowExternalEditorHint, editor, addNotification, removeNotification]);

  return (
    <SentryErrorBoundary>
      <Box flexDirection="column" alignItems={isNarrow ? 'flex-start' : 'flex-end'} flexShrink={0} overflowX="hidden">
        <NotificationContent
          ideSelection={ideSelection}
          mcpClients={mcpClients}
          notifications={notifications}
          diffPanelVisible={diffPanelVisible}
          isInOverageMode={isInOverageMode ?? false}
          isTeamOrEnterprise={isTeamOrEnterprise}
          apiKeyStatus={apiKeyStatus}
          debug={debug}
          verbose={verbose}
          tokenUsage={tokenUsage}
          mainLoopModel={mainLoopModel}
          modelSettingsSlot={modelSettingsSlot}
          sessionModelSettingsOverrides={sessionModelSettingsOverrides}
          autoCompactWindow={autoCompactWindow}
          autoCompactWindowOverride={autoCompactWindowOverride}
        />
      </Box>
    </SentryErrorBoundary>
  );
}

function NotificationContent({
  ideSelection,
  mcpClients,
  notifications,
  diffPanelVisible,
  isInOverageMode,
  isTeamOrEnterprise,
  apiKeyStatus,
  debug,
  verbose,
  tokenUsage,
  mainLoopModel,
  modelSettingsSlot,
  sessionModelSettingsOverrides,
  autoCompactWindow,
  autoCompactWindowOverride,
}: {
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  notifications: {
    current: Notification | null;
    queue: Notification[];
    pinned: Notification[];
  };
  diffPanelVisible: boolean;
  isInOverageMode: boolean;
  isTeamOrEnterprise: boolean;
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  verbose: boolean;
  tokenUsage: number;
  mainLoopModel: string;
  modelSettingsSlot?: ModelSettingsSlot;
  sessionModelSettingsOverrides: SessionModelSettingsOverrides;
  autoCompactWindow?: number;
  autoCompactWindowOverride?: boolean;
}): ReactNode {
  // Poll apiKeyHelper inflight state to show slow-helper notice.
  // Gated on configuration — most users never set apiKeyHelper, so the
  // effect is a no-op for them (no interval allocated).
  const [apiKeyHelperSlow, setApiKeyHelperSlow] = useState<string | null>(null);
  useEffect(() => {
    if (!getConfiguredApiKeyHelper()) return;
    const interval = setInterval(
      (setSlow: React.Dispatch<React.SetStateAction<string | null>>) => {
        const ms = getApiKeyHelperElapsedMs();
        const next = ms >= 10_000 ? formatDuration(ms) : null;
        setSlow(prev => (next === prev ? prev : next));
      },
      1000,
      setApiKeyHelperSlow,
    );
    return () => clearInterval(interval);
  }, []);

  // Voice state (VOICE_MODE builds only, runtime-gated by GrowthBook)
  const voiceStateRaw = useVoiceState(s => s.voiceState);
  const voiceState = feature('VOICE_MODE') ? voiceStateRaw : ('idle' as const);
  const voiceEnabledRaw = useVoiceEnabled();
  const voiceEnabled = feature('VOICE_MODE') ? voiceEnabledRaw : false;
  const voiceErrorRaw = useVoiceState(s => s.voiceError);
  const voiceError = feature('VOICE_MODE') ? voiceErrorRaw : null;
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? isBriefOnlyState : false;

  // When voice is actively recording or processing, replace all
  // notifications with just the voice indicator.
  if (feature('VOICE_MODE') && voiceEnabled && (voiceState === 'recording' || voiceState === 'processing')) {
    return <VoiceIndicator voiceState={voiceState} />;
  }

  const current = shouldDisplayNotification(notifications.current, diffPanelVisible) ? notifications.current : null;
  const pinned = sortPinnedNotifications(notifications.pinned);
  const compactContext = {
    settingsSlot: modelSettingsSlot,
    sessionOverrides: sessionModelSettingsOverrides,
    autoCompactWindow,
    autoCompactWindowOverride,
  };

  return (
    <>
      <IdeStatusIndicator ideSelection={ideSelection} mcpClients={mcpClients} />
      {current && <NotificationLine notification={current} />}
      {pinned.map(notification => (
        <NotificationLine notification={notification} key={notification.key} pinned />
      ))}
      {isInOverageMode && !isTeamOrEnterprise && (
        <Box>
          <Text dimColor wrap="truncate">
            Now using extra usage
          </Text>
        </Box>
      )}
      {apiKeyHelperSlow && (
        <Box>
          <Text color="warning" wrap="truncate">
            apiKeyHelper is taking a while{' '}
          </Text>
          <Text dimColor wrap="truncate">
            ({apiKeyHelperSlow})
          </Text>
        </Box>
      )}
      {(apiKeyStatus === 'invalid' || apiKeyStatus === 'missing') && (
        <Box>
          <Text color="error" wrap="truncate">
            {isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
              ? 'Authentication error · Try again'
              : 'Not logged in · Run /login'}
          </Text>
        </Box>
      )}
      {debug && (
        <Box>
          <Text color="warning" wrap="truncate">
            Debug mode
          </Text>
        </Box>
      )}
      {apiKeyStatus !== 'invalid' && apiKeyStatus !== 'missing' && verbose && (
        <Box>
          <Text dimColor wrap="truncate">
            {tokenUsage} tokens
          </Text>
        </Box>
      )}
      {!isBriefOnly && <TokenWarning tokenUsage={tokenUsage} model={mainLoopModel} compactContext={compactContext} />}
      {feature('VOICE_MODE')
        ? voiceEnabled &&
          voiceError && (
            <Box>
              <Text color="error" wrap="truncate">
                {voiceError}
              </Text>
            </Box>
          )
        : null}
      <MemoryUsageIndicator />
      <SandboxPromptFooterHint />
    </>
  );
}

function NotificationLine({
  notification,
  pinned = false,
}: {
  notification: Notification;
  pinned?: boolean;
}): ReactNode {
  if ('jsx' in notification) {
    return (
      <Text color={pinned ? 'warning' : undefined} wrap="truncate" key={notification.key}>
        {pinned ? '! ' : null}
        {notification.jsx}
      </Text>
    );
  }

  return (
    <Text
      color={notification.color ?? (pinned ? 'warning' : undefined)}
      dimColor={!notification.color && !pinned}
      wrap="truncate"
      key={notification.key}
    >
      {pinned ? '! ' : null}
      {notification.text}
    </Text>
  );
}
