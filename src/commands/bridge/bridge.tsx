import { feature } from 'bun:bundle';
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { getBridgeAccessToken, getBridgeBaseUrl, isSelfHostedBridge } from '../../bridge/bridgeConfig.js';
import { checkBridgeMinVersion, getBridgeDisabledReason, isEnvLessBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { checkEnvLessBridgeMinVersion } from '../../bridge/envLessBridgeConfig.js';
import { BRIDGE_LOGIN_INSTRUCTION, REMOTE_CONTROL_DISCONNECTED_MSG } from '../../bridge/types.js';
import { Dialog, ListItem } from '@anthropic/ink';
import { shouldShowRemoteCallout } from '../../components/RemoteCallout.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import {
  getRemoteControlAuthMode,
  getRemoteControlUser,
  logoutRemoteControl,
  prepareRemoteControlAuthentication,
} from '../../services/remoteControlAuth/index.js';
import { logForDebugging } from '../../utils/telemetry/debug.js';
import { parseRemoteControlArgs, type RemoteControlAuthAction } from './parseArgs.js';
import { checkRemoteControlPolicy } from './policyGate.js';
import { RemoteControlAuthDialog } from './RemoteControlAuthDialog.js';

type AuthAction = RemoteControlAuthAction;

type Props = {
  onDone: LocalJSXCommandOnDone;
  name?: string;
  authAction?: AuthAction;
};

/**
 * /remote-control command — manages the bidirectional bridge connection.
 *
 * When enabled, sets replBridgeEnabled in AppState, which triggers
 * useReplBridge in REPL.tsx to initialize the bridge connection.
 * The bridge registers an environment, creates a session with the current
 * conversation, polls for work, and connects an ingress WebSocket for
 * bidirectional messaging between the CLI and claude.ai.
 *
 * Running /remote-control when already connected shows a dialog with the session
 * URL and options to disconnect or continue.
 */
function BridgeToggle({ onDone, name, authAction }: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const replBridgeConnected = useAppState(s => s.replBridgeConnected);
  const replBridgeEnabled = useAppState(s => s.replBridgeEnabled);
  const replBridgeOutboundOnly = useAppState(s => s.replBridgeOutboundOnly);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [authPrompt, setAuthPrompt] = useState<{
    baseUrl: string;
    registrationEnabled: boolean;
  } | null>(null);

  function enableBridge(): void {
    if (shouldShowRemoteCallout()) {
      setAppState(prev => {
        if (prev.showRemoteCallout) return prev;
        return {
          ...prev,
          showRemoteCallout: true,
          replBridgeInitialName: name,
        };
      });
      onDone('', { display: 'system' });
      return;
    }

    logEvent('tengu_bridge_command', {
      action: 'connect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    setAppState(prev => {
      if (prev.replBridgeEnabled && !prev.replBridgeOutboundOnly) return prev;
      return {
        ...prev,
        replBridgeEnabled: true,
        replBridgeExplicit: true,
        replBridgeOutboundOnly: false,
        replBridgeInitialName: name,
      };
    });
    onDone('Remote Control connecting\u2026', { display: 'system' });
  }

  useEffect(() => {
    // An explicit `login` / `register` always means the account dialog, even
    // while a bridge is up — the startup auth path dispatches this command
    // with the bridge still flagged enabled, and answering it with the
    // disconnect dialog would leave the user with no way in.
    if (authAction === undefined && (replBridgeConnected || replBridgeEnabled) && !replBridgeOutboundOnly) {
      setShowDisconnectDialog(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const error = await checkBridgePrerequisites();
      if (cancelled) return;
      if (error) {
        logEvent('tengu_bridge_command', {
          action: 'preflight_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        onDone(error, { display: 'system' });
        return;
      }

      if (isSelfHostedBridge()) {
        try {
          const baseUrl = getBridgeBaseUrl();
          const prepared = await prepareRemoteControlAuthentication(baseUrl);
          if (cancelled) return;
          if (prepared.status === 'login_required' || authAction !== undefined) {
            // Always the server's answer: a forced `register` against a server
            // with registration disabled must not be offered the option.
            setAuthPrompt({ baseUrl, registrationEnabled: prepared.registrationEnabled });
            return;
          }
          if (prepared.status === 'legacy' && !getBridgeAccessToken()) {
            onDone(BRIDGE_LOGIN_INSTRUCTION, { display: 'system' });
            return;
          }
        } catch (authError) {
          if (cancelled) return;
          const message =
            authError instanceof Error ? authError.message : 'Unable to contact the Remote Control server.';
          onDone(message, { display: 'system' });
          return;
        }
      } else if (!getBridgeAccessToken()) {
        onDone(BRIDGE_LOGIN_INSTRUCTION, { display: 'system' });
        return;
      }

      enableBridge();
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount

  if (showDisconnectDialog) {
    return <BridgeDisconnectDialog onDone={onDone} />;
  }

  if (authPrompt) {
    return (
      <RemoteControlAuthDialog
        baseUrl={authPrompt.baseUrl}
        registrationEnabled={authPrompt.registrationEnabled}
        initialAction={authAction}
        onAuthenticated={() => {
          setAuthPrompt(null);
          enableBridge();
        }}
        onCancel={() => onDone(undefined, { display: 'skip' })}
      />
    );
  }

  return null;
}

/**
 * Dialog shown when /remote-control is used while the bridge is already connected.
 * Shows the session URL and lets the user disconnect or continue.
 */
function BridgeDisconnectDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('bridge-disconnect-dialog');
  const setAppState = useSetAppState();
  const sessionUrl = useAppState(s => s.replBridgeSessionUrl);
  const connectUrl = useAppState(s => s.replBridgeConnectUrl);
  const sessionId = useAppState(s => s.replBridgeSessionId);
  const [focusIndex, setFocusIndex] = useState(2);
  const [showQR, setShowQR] = useState(false);
  const [qrText, setQrText] = useState('');
  const [qrRefreshing, setQrRefreshing] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);

  const displayUrl = sessionUrl ?? connectUrl;

  // Generate QR code when URL changes or QR is toggled on
  useEffect(() => {
    if (!showQR || !displayUrl) {
      setQrText('');
      return;
    }
    qrToString(displayUrl, {
      type: 'utf8',
      errorCorrectionLevel: 'L',
      small: true,
    } as Parameters<typeof qrToString>[1])
      .then(setQrText)
      .catch(() => setQrText(''));
  }, [showQR, displayUrl]);

  function handleDisconnect(): void {
    setAppState(prev => {
      if (!prev.replBridgeEnabled) return prev;
      return {
        ...prev,
        replBridgeEnabled: false,
        replBridgeExplicit: false,
        replBridgeOutboundOnly: false,
      };
    });
    logEvent('tengu_bridge_command', {
      action: 'disconnect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(REMOTE_CONTROL_DISCONNECTED_MSG, { display: 'system' });
  }

  async function handleShowQR(): Promise<void> {
    if (qrRefreshing) return;
    if (showQR) {
      setShowQR(false);
      setQrError(null);
      return;
    }

    if (sessionId && isSelfHostedBridge() && getRemoteControlAuthMode(getBridgeBaseUrl()) === 'accounts') {
      setQrRefreshing(true);
      setQrError(null);
      try {
        const baseUrl = getBridgeBaseUrl();
        const prepared = await prepareRemoteControlAuthentication(baseUrl);
        if (prepared.status !== 'authenticated') {
          throw new Error('account login required');
        }
        const { refreshBridgeSessionPairing } = await import('../../bridge/createSession.js');
        const refreshedUrl = await refreshBridgeSessionPairing(sessionId, {
          baseUrl,
          getAccessToken: getBridgeAccessToken,
        });
        if (!refreshedUrl) {
          throw new Error('pairing refresh failed');
        }
        setAppState(prev => ({
          ...prev,
          replBridgeSessionUrl: refreshedUrl,
        }));
      } catch {
        setQrError('Unable to create a new pairing code. Try again when the server is available.');
        return;
      } finally {
        setQrRefreshing(false);
      }
    }

    setShowQR(true);
  }

  function handleContinue(): void {
    onDone(undefined, { display: 'skip' });
  }

  const ITEM_COUNT = 3;

  useKeybindings(
    {
      'select:next': () => setFocusIndex(i => (i + 1) % ITEM_COUNT),
      'select:previous': () => setFocusIndex(i => (i - 1 + ITEM_COUNT) % ITEM_COUNT),
      'select:accept': () => {
        if (focusIndex === 0) {
          handleDisconnect();
        } else if (focusIndex === 1) {
          void handleShowQR();
        } else {
          handleContinue();
        }
      },
    },
    { context: 'Select' },
  );

  const qrLines = qrText ? qrText.split('\n').filter(l => l.length > 0) : [];

  return (
    <Dialog title="Remote Control" onCancel={handleContinue} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Text>
          This session is available via Remote Control
          {displayUrl ? ` at ${displayUrl}` : ''}.
        </Text>
        {qrError && <Text color="error">{qrError}</Text>}
        {showQR && qrLines.length > 0 && (
          <Box flexDirection="column">
            {qrLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <ListItem isFocused={focusIndex === 0}>
            <Text>Disconnect this session</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 1}>
            <Text>{qrRefreshing ? 'Creating pairing code…' : showQR ? 'Hide QR code' : 'Show QR code'}</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 2}>
            <Text>Continue</Text>
          </ListItem>
        </Box>
        <Text dimColor>Enter to select · Esc to continue</Text>
      </Box>
    </Dialog>
  );
}

/**
 * Check bridge prerequisites. Returns an error message if a precondition
 * fails, or null if all checks pass. Awaits GrowthBook init if the disk
 * cache is stale, so a user who just became entitled (e.g. upgraded to Max,
 * or the flag just launched) gets an accurate result on the first try.
 */
async function checkBridgePrerequisites(): Promise<string | null> {
  // Check organization policy — remote control may be disabled
  const policyError = await checkRemoteControlPolicy();
  if (policyError) {
    return policyError;
  }

  const disabledReason = await getBridgeDisabledReason();
  if (disabledReason) {
    return disabledReason;
  }

  // Mirror the v1/v2 branching logic in initReplBridge: env-less (v2) is used
  // only when the flag is on AND the session is not perpetual.  In assistant
  // mode (KAIROS) useReplBridge sets perpetual=true, which forces
  // initReplBridge onto the v1 path — so the prerequisite check must match.
  let useV2 = isEnvLessBridgeEnabled();
  if (feature('KAIROS') && useV2) {
    const { isAssistantMode } = await import('../../assistant/index.js');
    if (isAssistantMode()) {
      useV2 = false;
    }
  }
  const versionError = useV2 ? await checkEnvLessBridgeMinVersion() : checkBridgeMinVersion();
  if (versionError) {
    return versionError;
  }

  logForDebugging('[bridge] Prerequisites passed, enabling bridge');
  return null;
}

function BridgeStatus({ onDone }: Props): React.ReactNode {
  const connected = useAppState(s => s.replBridgeConnected);
  const enabled = useAppState(s => s.replBridgeEnabled);
  const reconnecting = useAppState(s => s.replBridgeReconnecting);
  const sessionUrl = useAppState(s => s.replBridgeSessionUrl);
  const error = useAppState(s => s.replBridgeError);

  useEffect(() => {
    void (async () => {
      // `status` reaches the configured server, so it is gated like every
      // other subcommand that talks to it.
      const policyError = await checkRemoteControlPolicy();
      if (policyError) {
        onDone(policyError, { display: 'system' });
        return;
      }
      if (connected) {
        onDone(`Remote Control connected${sessionUrl ? ` at ${sessionUrl}` : '.'}`, { display: 'system' });
        return;
      }
      if (enabled) {
        onDone(
          reconnecting
            ? 'Remote Control reconnecting…'
            : error
              ? `Remote Control connection failed: ${error}`
              : 'Remote Control connecting…',
          { display: 'system' },
        );
        return;
      }
      if (!isSelfHostedBridge()) {
        onDone('Remote Control is disconnected.', { display: 'system' });
        return;
      }

      try {
        const baseUrl = getBridgeBaseUrl();
        const prepared = await prepareRemoteControlAuthentication(baseUrl);
        const user = getRemoteControlUser(baseUrl);
        if (prepared.status === 'authenticated' && user) {
          onDone(`Remote Control is disconnected. Logged in as ${user.username}.`, {
            display: 'system',
          });
        } else if (prepared.status === 'legacy' && getBridgeAccessToken()) {
          onDone('Remote Control is disconnected. A legacy server credential is configured.', {
            display: 'system',
          });
        } else {
          onDone('Remote Control is disconnected and requires account login.', {
            display: 'system',
          });
        }
      } catch {
        onDone('Remote Control is disconnected. The configured server is unavailable.', {
          display: 'system',
        });
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- report one status snapshot

  return null;
}

function BridgeLogout({ onDone }: Props): React.ReactNode {
  const setAppState = useSetAppState();

  useEffect(() => {
    if (!isSelfHostedBridge()) {
      onDone(
        'Remote Control account logout applies to account-based servers. This session targets the claude.ai bridge, which uses your claude.ai login.',
        {
          display: 'system',
        },
      );
      return;
    }

    let cancelled = false;
    void (async () => {
      // Revocation is a network call to the configured server, so it sits
      // behind the same policy gate as connecting to it.
      const policyError = await checkRemoteControlPolicy();
      if (cancelled) return;
      if (policyError) {
        onDone(policyError, { display: 'system' });
        return;
      }

      setAppState(prev => ({
        ...prev,
        replBridgeEnabled: false,
        replBridgeExplicit: false,
        replBridgeOutboundOnly: false,
      }));
      try {
        await logoutRemoteControl(getBridgeBaseUrl());
        onDone('Remote Control account logged out.', { display: 'system' });
      } catch {
        onDone('Remote Control disconnected, but the server could not revoke the login. Try again when online.', {
          display: 'system',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount

  return null;
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const invocation = parseRemoteControlArgs(args);
  switch (invocation.kind) {
    case 'logout':
      return <BridgeLogout onDone={onDone} />;
    case 'status':
      return <BridgeStatus onDone={onDone} />;
    case 'auth':
      return <BridgeToggle onDone={onDone} authAction={invocation.action} />;
    case 'connect':
      return <BridgeToggle onDone={onDone} name={invocation.name} />;
  }
}
