import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { installOAuthTokens } from '../cli/handlers/auth.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { setClipboard, useTerminalNotification, Box, Link, Text, KeyboardShortcutHint } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getSSLErrorHint } from '@ant/model-provider';
import { sendNotification } from '../services/notifier.js';
import {
  completeChatGPTDeviceLogin,
  requestChatGPTDeviceCode,
  type ChatGPTDeviceCode,
} from '../services/api/openai/chatgptAuth.js';
import { clearOpenAIClientCache } from '../services/api/openai/client.js';
import { startAntigravityOAuthLogin } from '../services/auth/antigravity/index.js';
import type { DeviceCodeGrant } from '../services/auth/opencode/index.js';
import { OpencodeDeviceLogin, type OpencodeDevicePhase } from './opencodeLogin/OpencodeDeviceLogin.js';
import {
  isFreeZenModel,
  OPENCODE_PRODUCTS,
  type OpencodeProduct,
  ZEN_PUBLIC_KEY,
} from './opencodeLogin/opencodeCatalog.js';
import { backFromScreen } from './providerSetup/backNavigation.js';
import { ProviderSetupWizard } from './providerSetup/ProviderSetupWizard.js';
import { parseMaxContextInput } from './providerSetup/maxContext.js';
import { PROVIDER_SETUP_SPECS, type ProviderSetupKind } from './providerSetup/specs.js';
import type { ProviderSaveOutcome } from './providerSetup/savePlan.js';
import type {
  ProviderEndpointSetupStatus,
  ProviderModelSetupStatus,
  ProviderSetupStatus,
} from './providerSetup/state.js';

// Re-exported: the max-context field parser moved into the wizard package (a
// component cannot import from the file that renders it), but this module has
// been its public entry point since it was introduced.
export { parseMaxContextInput };
import { buildAntigravityAutoConfigEnv } from '../utils/model/antigravityModels.js';
import { applyDeepSeekAnthropicWire } from '../utils/model/deepseekWire.js';
import { OAuthService } from '../services/oauth/index.js';
import { getOauthAccountInfo, validateForceLoginOrg } from '../utils/auth/auth.js';
import { openBrowser } from '../utils/network/browser.js';
import { logError } from '../utils/telemetry/log.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import {
  CHINA_LLM_PROVIDERS,
  findChinaProviderByBaseURL,
  type ProviderPreset,
  resolveChinaProviderBaseURL,
} from 'src/utils/model/chinaLlmProviders.js';
import { Select } from './CustomSelect/select.js';
import { Spinner } from './Spinner.js';
import TextInput from './TextInput.js';

type Props = {
  onDone(): void;
  /**
   * The session's provider configuration was rewritten — reload settings and,
   * when the outcome says so, drop the in-session model selection.
   *
   * Every path that writes provider settings must call this, not just the
   * shared wizard: the three OAuth flows below (Claude/Console, ChatGPT,
   * Antigravity) used to finish with `onDone()` alone, which left AppState
   * holding the settings and the resolved model from before the login. The
   * user's only fix was to restart occ.
   */
  onProviderChanged?: (outcome: ProviderSaveOutcome) => void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
};

const PASTE_HERE_MSG = 'Paste code here if prompted > ';

type OAuthStatusSetter = React.Dispatch<React.SetStateAction<OAuthStatus>>;

/**
 * Back-navigation guarded on the live screen. See backNavigation.ts for why the
 * guard exists; returning `false` lets a stale handler decline the keypress
 * rather than swallow it.
 */
function backFrom(
  statusRef: React.RefObject<OAuthStatus>,
  setOAuthStatus: OAuthStatusSetter,
  from: OAuthStatus['state'],
  to: OAuthStatus,
): void | false {
  return backFromScreen(statusRef, setOAuthStatus, from, to);
}

type OAuthStatus =
  | { state: 'idle' } // Initial state, waiting to select login method
  | { state: 'platform_setup' } // Show platform setup info (Bedrock/Vertex/Foundry)
  // Every API-key provider — OpenAI, Anthropic-compatible, Gemini, Grok — runs
  // through the same two-step wizard: connection details, then a model chosen
  // from the endpoint's own /models answer. See components/providerSetup/.
  | ProviderEndpointSetupStatus
  | ProviderModelSetupStatus
  | {
      state: 'chatgpt_subscription';
      phase: 'requesting' | 'waiting';
      deviceCode?: ChatGPTDeviceCode;
    } // ChatGPT account subscription via Codex OAuth device flow
  | {
      state: 'antigravity_oauth';
      phase: 'starting' | 'waiting';
      authUrl?: string;
    } // Google Antigravity subscription via Google OAuth loopback flow
  // OpenCode registers two credential kinds and the free tier needs neither, so
  // each product's menu entry opens a picker rather than adding top-level rows.
  // Same shape as the China presets: one row in the login menu, the branching
  // one screen in.
  //
  // `product` travels with the state because it is not recoverable later: Zen
  // and Go are one path segment apart on the same host, nothing in the device
  // flow itself differs, and the wrong one is only reported as a CreditsError
  // from the other product's balance.
  | { state: 'opencode_method_select'; product: OpencodeProduct }
  | {
      state: 'opencode_device';
      product: OpencodeProduct;
      phase: OpencodeDevicePhase;
      grant?: DeviceCodeGrant;
    } // OpenCode Console subscription via RFC 8628 device code
  | { state: 'china_provider_select'; activeIndex: number } // China LLM: pick provider
  | { state: 'china_mode_select'; provider: ProviderPreset; activeIndex: number } // China LLM: pick access mode
  // No model step: one API key configures the provider as a whole, and every
  // model it ships is then reachable from /model.
  | { state: 'china_apikey'; provider: ProviderPreset; mode: 'api' | 'coding-plan'; apiKey: string }
  | { state: 'ready_to_start' } // Flow started, waiting for browser to open
  | { state: 'waiting_for_login'; url: string } // Browser opened, waiting for user to login
  | { state: 'creating_api_key' } // Got access token, creating API key
  | { state: 'about_to_retry'; nextState: OAuthStatus }
  | { state: 'success'; token?: string }
  | {
      state: 'error';
      message: string;
      toRetry?: OAuthStatus;
    };

/**
 * Recover which China preset (and billing mode) a model step belongs to.
 *
 * Derived from the base URL the step already carries rather than stored
 * alongside it — one fewer field that can disagree with the endpoint actually
 * being configured.
 */
function chinaPresetForStatus(status: { baseUrl: string }): ProviderPreset | undefined {
  return findChinaProviderByBaseURL(status.baseUrl);
}

function chinaModeForStatus(status: { baseUrl: string }): 'api' | 'coding-plan' {
  const preset = chinaPresetForStatus(status);
  return preset?.codingPlan?.baseURL === status.baseUrl ? 'coding-plan' : 'api';
}

export function ConsoleOAuthFlow({
  onDone,
  onProviderChanged,
  startingMessage,
  mode = 'login',
  forceLoginMethod: forceLoginMethodProp,
}: Props): React.ReactNode {
  const settings = getSettings_DEPRECATED() || {};
  const forceLoginMethod = forceLoginMethodProp ?? settings.forceLoginMethod;
  const orgUUID = settings.forceLoginOrgUUID;
  const forcedMethodMessage =
    forceLoginMethod === 'claudeai'
      ? 'Login method pre-selected: Subscription Plan (Claude Pro/Max)'
      : forceLoginMethod === 'console'
        ? 'Login method pre-selected: API Usage Billing (Anthropic Console)'
        : null;

  const terminal = useTerminalNotification();

  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>(() => {
    if (mode === 'setup-token') {
      return { state: 'ready_to_start' };
    }
    if (forceLoginMethod === 'claudeai' || forceLoginMethod === 'console') {
      return { state: 'ready_to_start' };
    }
    return { state: 'idle' };
  });

  // Read by backFrom() so a stale key handler can tell it is stale.
  const statusRef = React.useRef<OAuthStatus>(oauthStatus);
  statusRef.current = oauthStatus;

  // Through a ref so startOAuth can notify without listing the callback in its
  // dependency array — a new identity there would rebuild startOAuth and, with
  // the flow still in 'ready_to_start', kick off a second browser round trip.
  const onProviderChangedRef = React.useRef(onProviderChanged);
  onProviderChangedRef.current = onProviderChanged;

  const [pastedCode, setPastedCode] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [oauthService] = useState(() => new OAuthService());
  const [loginWithClaudeAi, setLoginWithClaudeAi] = useState(() => {
    // Use Claude AI auth for setup-token mode to support user:inference scope
    return mode === 'setup-token' || forceLoginMethod === 'claudeai';
  });
  // After a few seconds we suggest the user to copy/paste url if the
  // browser did not open automatically. In this flow we expect the user to
  // copy the code from the browser and paste it in the terminal
  const [showPastePrompt, setShowPastePrompt] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);

  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1;

  // Log forced login method on mount
  useEffect(() => {
    if (forceLoginMethod === 'claudeai') {
      logEvent('tengu_oauth_claudeai_forced', {});
    } else if (forceLoginMethod === 'console') {
      logEvent('tengu_oauth_console_forced', {});
    }
  }, [forceLoginMethod]);

  // Retry logic
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(setOAuthStatus, 1000, oauthStatus.nextState);
      return () => clearTimeout(timer);
    }
  }, [oauthStatus]);

  // Handle Enter to continue on success state
  useKeybinding(
    'confirm:yes',
    () => {
      logEvent('tengu_oauth_success', { loginWithClaudeAi });
      onDone();
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'success' && mode !== 'setup-token',
    },
  );

  // Handle Enter to continue from platform setup
  useKeybinding(
    'confirm:yes',
    () => {
      setOAuthStatus({ state: 'idle' });
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'platform_setup',
    },
  );

  // Handle Enter to retry on error state
  useKeybinding(
    'confirm:yes',
    () => {
      if (oauthStatus.state === 'error' && oauthStatus.toRetry) {
        setPastedCode('');
        setOAuthStatus({
          state: 'about_to_retry',
          nextState: oauthStatus.toRetry,
        });
      }
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'error' && !!oauthStatus.toRetry,
    },
  );

  useEffect(() => {
    if (pastedCode === 'c' && oauthStatus.state === 'waiting_for_login' && showPastePrompt && !urlCopied) {
      void setClipboard(oauthStatus.url).then(raw => {
        if (raw) process.stdout.write(raw);
        setUrlCopied(true);
        setTimeout(setUrlCopied, 2000, false);
      });
      setPastedCode('');
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied]);

  async function handleSubmitCode(value: string, url: string) {
    try {
      // Expecting format "authorizationCode#state" from the authorization callback URL
      const [authorizationCode, state] = value.split('#');

      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: 'Invalid code. Please make sure the full code was copied',
          toRetry: { state: 'waiting_for_login', url },
        });
        return;
      }

      // Track which path the user is taking (manual code entry)
      logEvent('tengu_oauth_manual_entry', {});
      oauthService.handleManualAuthCodeInput({
        authorizationCode,
        state,
      });
    } catch (err: unknown) {
      logError(err);
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: { state: 'waiting_for_login', url },
      });
    }
  }

  const startOAuth = useCallback(async () => {
    try {
      logEvent('tengu_oauth_flow_start', { loginWithClaudeAi });

      const result = await oauthService
        .startOAuthFlow(
          async url => {
            setOAuthStatus({ state: 'waiting_for_login', url });
            setTimeout(setShowPastePrompt, 3000, true);
          },
          {
            loginWithClaudeAi,
            inferenceOnly: mode === 'setup-token',
            expiresIn: mode === 'setup-token' ? 365 * 24 * 60 * 60 : undefined, // 1 year for setup-token
            orgUUID,
          },
        )
        .catch(err => {
          const isTokenExchangeError = err.message.includes('Token exchange failed');
          // Enterprise TLS proxies (Zscaler et al.) intercept the token
          // exchange POST and cause cryptic SSL errors. Surface an
          // actionable hint so the user isn't stuck in a login loop.
          const sslHint = getSSLErrorHint(err);
          setOAuthStatus({
            state: 'error',
            message:
              sslHint ??
              (isTokenExchangeError
                ? 'Failed to exchange authorization code for access token. Please try again.'
                : err.message),
            toRetry: mode === 'setup-token' ? { state: 'ready_to_start' } : { state: 'idle' },
          });
          logEvent('tengu_oauth_token_exchange_error', {
            error: err.message,
            ssl_error: sslHint !== null,
          });
          throw err;
        });

      if (mode === 'setup-token') {
        // For setup-token mode, return the OAuth access token directly (it can be used as an API key)
        // Don't save to keychain - the token is displayed for manual use with CLAUDE_CODE_OAUTH_TOKEN
        setOAuthStatus({ state: 'success', token: result.accessToken });
      } else {
        await installOAuthTokens(result);

        const orgResult = await validateForceLoginOrg();
        if (!orgResult.valid) {
          throw new Error((orgResult as { valid: false; message: string }).message);
        }
        // Reset modelType to anthropic when using OAuth login
        updateSettingsForSource('userSettings', { modelType: 'anthropic' } as unknown as Parameters<
          typeof updateSettingsForSource
        >[1]);
        // The provider just changed under the session. Without this the caller
        // keeps the settings snapshot and the resolved model from whatever was
        // configured before the login, and only a restart fixes it.
        onProviderChangedRef.current?.({ modelType: 'anthropic', providerChanged: true });

        setOAuthStatus({ state: 'success' });
        void sendNotification(
          {
            message: 'Claude Code login successful',
            notificationType: 'auth_success',
          },
          terminal,
        );
      }
    } catch (err) {
      const errorMessage = (err as Error).message;
      const sslHint = getSSLErrorHint(err);
      setOAuthStatus({
        state: 'error',
        message: sslHint ?? errorMessage,
        toRetry: {
          state: mode === 'setup-token' ? 'ready_to_start' : 'idle',
        },
      });
      logEvent('tengu_oauth_error', {
        error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ssl_error: sslHint !== null,
      });
    }
  }, [oauthService, setShowPastePrompt, loginWithClaudeAi, mode, orgUUID]);

  const pendingOAuthStartRef = useRef(false);

  useEffect(() => {
    if (oauthStatus.state === 'ready_to_start' && !pendingOAuthStartRef.current) {
      pendingOAuthStartRef.current = true;
      // Start OAuth flow and reset the pending flag when complete
      void startOAuth().finally(() => {
        pendingOAuthStartRef.current = false;
      });
    }
  }, [oauthStatus.state, startOAuth]);

  // Auto-exit for setup-token mode
  useEffect(() => {
    if (mode === 'setup-token' && oauthStatus.state === 'success') {
      // Delay to ensure static content is fully rendered before exiting
      const timer = setTimeout(
        (loginWithClaudeAi, onDone) => {
          logEvent('tengu_oauth_success', { loginWithClaudeAi });
          // Don't clear terminal so the token remains visible
          onDone();
        },
        500,
        loginWithClaudeAi,
        onDone,
      );
      return () => clearTimeout(timer);
    }
  }, [mode, oauthStatus, loginWithClaudeAi, onDone]);

  // Cleanup OAuth service when component unmounts
  useEffect(() => {
    return () => {
      oauthService.cleanup();
    };
  }, [oauthService]);

  return (
    <Box flexDirection="column" gap={1}>
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt && (
        <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>Browser didn&apos;t open? Use the url below to sign in </Text>
            {urlCopied ? (
              <Text color="success">(Copied!)</Text>
            ) : (
              <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>
            )}
          </Box>
          <Link url={oauthStatus.url}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Link>
        </Box>
      )}
      {mode === 'setup-token' && oauthStatus.state === 'success' && oauthStatus.token && (
        <Box key="tokenOutput" flexDirection="column" gap={1} paddingTop={1}>
          <Text color="success">✓ Long-lived authentication token created successfully!</Text>
          <Box flexDirection="column" gap={1}>
            <Text>Your OAuth token (valid for 1 year):</Text>
            <Text color="warning">{oauthStatus.token}</Text>
            <Text dimColor>Store this token securely. You won&apos;t be able to see it again.</Text>
            <Text dimColor>Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=&lt;token&gt;</Text>
          </Box>
        </Box>
      )}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        <OAuthStatusMessage
          oauthStatus={oauthStatus}
          mode={mode}
          startingMessage={startingMessage}
          forcedMethodMessage={forcedMethodMessage}
          showPastePrompt={showPastePrompt}
          pastedCode={pastedCode}
          setPastedCode={setPastedCode}
          cursorOffset={cursorOffset}
          setCursorOffset={setCursorOffset}
          textInputColumns={textInputColumns}
          handleSubmitCode={handleSubmitCode}
          setOAuthStatus={setOAuthStatus}
          statusRef={statusRef}
          setLoginWithClaudeAi={setLoginWithClaudeAi}
          onDone={onDone}
          onProviderChanged={onProviderChanged}
        />
      </Box>
    </Box>
  );
}

type OAuthStatusMessageProps = {
  oauthStatus: OAuthStatus;
  mode: 'login' | 'setup-token';
  startingMessage: string | undefined;
  forcedMethodMessage: string | null;
  showPastePrompt: boolean;
  pastedCode: string;
  setPastedCode: (value: string) => void;
  cursorOffset: number;
  onDone: () => void;
  onProviderChanged?: (outcome: ProviderSaveOutcome) => void;
  setCursorOffset: (offset: number) => void;
  textInputColumns: number;
  handleSubmitCode: (value: string, url: string) => void;
  setOAuthStatus: OAuthStatusSetter;
  /** Live status, so stale handlers can tell they are stale. See backFrom. */
  statusRef: React.RefObject<OAuthStatus>;
  setLoginWithClaudeAi: (value: boolean) => void;
};

/**
 * The two OpenAI wire protocols are separate entries in the login menu, not a
 * field inside one "OpenAI Compatible" form: they hit different endpoints
 * (/chat/completions vs /responses) and suit different servers, so the choice
 * belongs where the user picks what they are connecting to. The setup form
 * only carries the protocol the menu already settled.
 */
type ChatGPTSubscriptionSetupProps = {
  status: Extract<OAuthStatus, { state: 'chatgpt_subscription' }>;
  setOAuthStatus: OAuthStatusSetter;
  onDone: () => void;
  onProviderChanged?: (outcome: ProviderSaveOutcome) => void;
};

function ChatGPTSubscriptionSetup({
  status,
  setOAuthStatus,
  onDone,
  onProviderChanged,
}: ChatGPTSubscriptionSetupProps): React.ReactNode {
  const startedRef = useRef(false);

  useKeybinding(
    'confirm:no',
    () => {
      setOAuthStatus({ state: 'idle' });
    },
    { context: 'Confirmation' },
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    const controller = new AbortController();
    async function runLogin() {
      try {
        const deviceCode = await requestChatGPTDeviceCode();
        if (cancelled) return;
        setOAuthStatus({
          state: 'chatgpt_subscription',
          phase: 'waiting',
          deviceCode,
        });
        void openBrowser(deviceCode.verificationUrl);
        await completeChatGPTDeviceLogin(deviceCode, controller.signal);
        if (cancelled) return;
        const env: Record<string, string> = {
          OPENAI_AUTH_MODE: 'chatgpt',
        };
        const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
          modelType: 'openai',
          env,
        };
        const { error } = updateSettingsForSource('userSettings', settingsUpdate);
        if (error) {
          throw new Error('Failed to save settings. Please try again.');
        }
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        // Switching provider mid-session must also tear down a DeepSeek mirror
        // left by a previous configuration; the apply releases its own claim
        // before deciding again, so this is the teardown too.
        applyDeepSeekAnthropicWire();
        // Drop any cached OpenAI client built from prior OpenAI Compatible
        // env vars; the ChatGPT Subscription path bypasses the SDK client
        // entirely (uses createChatGPTResponsesStream) but a stale cached
        // client would still be picked up by sideQuery.
        clearOpenAIClientCache();
        // Same session refresh the shared wizard does on save. Without it the
        // session keeps the pre-login settings snapshot and its already
        // resolved main-loop model, so the new provider only takes effect
        // after a restart.
        onProviderChanged?.({ modelType: 'openai', providerChanged: true });
        setOAuthStatus({ state: 'success' });
        void onDone();
      } catch (err) {
        if (cancelled) return;
        setOAuthStatus({
          state: 'error',
          message: (err as Error).message,
          toRetry: {
            state: 'chatgpt_subscription',
            phase: 'requesting',
          },
        });
      }
    }
    void runLogin();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [setOAuthStatus, onDone, onProviderChanged]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>ChatGPT Account Setup</Text>
      {status.phase === 'requesting' && (
        <Box>
          <Spinner />
          <Text>Requesting sign-in code…</Text>
        </Box>
      )}
      {status.phase === 'waiting' && status.deviceCode && (
        <Box flexDirection="column" gap={1}>
          <Text>Open this link and sign in with your ChatGPT account:</Text>
          <Link url={status.deviceCode.verificationUrl}>
            <Text dimColor>{status.deviceCode.verificationUrl}</Text>
          </Link>
          <Text>
            Enter code: <Text bold>{status.deviceCode.userCode}</Text>
          </Text>
          <Box>
            <Spinner />
            <Text>Waiting for ChatGPT authorization…</Text>
          </Box>
        </Box>
      )}
      <Text dimColor>Esc to go back. Device codes expire after 15 minutes.</Text>
    </Box>
  );
}

type AntigravityOAuthSetupProps = {
  status: Extract<OAuthStatus, { state: 'antigravity_oauth' }>;
  setOAuthStatus: OAuthStatusSetter;
  onDone: () => void;
  onProviderChanged?: (outcome: ProviderSaveOutcome) => void;
};

function AntigravityOAuthSetup({
  status,
  setOAuthStatus,
  onDone,
  onProviderChanged,
}: AntigravityOAuthSetupProps): React.ReactNode {
  const startedRef = useRef(false);

  useKeybinding(
    'confirm:no',
    () => {
      setOAuthStatus({ state: 'idle' });
    },
    { context: 'Confirmation' },
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    const controller = new AbortController();
    async function runLogin() {
      try {
        await startAntigravityOAuthLogin({
          signal: controller.signal,
          onAuthUrl: url => {
            if (cancelled) return;
            setOAuthStatus({ state: 'antigravity_oauth', phase: 'waiting', authUrl: url });
          },
        });
        if (cancelled) return;
        // Auto-configuration: the login only proves identity, so write the
        // full provider shape here — otherwise the user lands back at the
        // prompt with a Gemini token and no model routing.
        const env = buildAntigravityAutoConfigEnv();
        const { error } = updateSettingsForSource('userSettings', {
          modelType: 'gemini',
          env,
        } as unknown as Parameters<typeof updateSettingsForSource>[1]);
        if (error) {
          throw new Error('Failed to save settings. Please try again.');
        }
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        // Switching provider mid-session must also tear down a DeepSeek mirror
        // left by a previous configuration; the apply releases its own claim
        // before deciding again, so this is the teardown too.
        applyDeepSeekAnthropicWire();
        // Same session refresh the shared wizard does on save; see the note in
        // ChatGPTSubscriptionSetup.
        onProviderChanged?.({ modelType: 'gemini', providerChanged: true });
        setOAuthStatus({ state: 'success' });
        void onDone();
      } catch (err) {
        if (cancelled) return;
        setOAuthStatus({
          state: 'error',
          message: (err as Error).message,
          toRetry: { state: 'antigravity_oauth', phase: 'starting' },
        });
      }
    }
    void runLogin();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [setOAuthStatus, onDone, onProviderChanged]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Antigravity Setup</Text>
      <Text dimColor>
        Sign in with the Google account that has Antigravity access. occ then uses Gemini 3 through Antigravity&apos;s
        backend — no API key, no per-token billing.
      </Text>
      {status.phase === 'starting' && (
        <Box>
          <Spinner />
          <Text>Starting local callback server…</Text>
        </Box>
      )}
      {status.phase === 'waiting' && status.authUrl && (
        <Box flexDirection="column" gap={1}>
          <Text>A browser window should have opened. If not, open this link:</Text>
          <Link url={status.authUrl}>
            <Text dimColor>{status.authUrl}</Text>
          </Link>
          <Box>
            <Spinner />
            <Text>Waiting for Google authorization…</Text>
          </Box>
        </Box>
      )}
      <Text dimColor>Esc to go back. First-time accounts may take a few seconds to provision.</Text>
    </Box>
  );
}

function OAuthStatusMessage({
  oauthStatus,
  mode,
  startingMessage,
  forcedMethodMessage,
  showPastePrompt,
  pastedCode,
  setPastedCode,
  cursorOffset,
  setCursorOffset,
  textInputColumns,
  handleSubmitCode,
  setOAuthStatus,
  statusRef,
  setLoginWithClaudeAi,
  onDone,
  onProviderChanged,
}: OAuthStatusMessageProps): React.ReactNode {
  /**
   * Enter the shared two-step wizard. Only the connection details are seeded
   * here — the model fields are filled in after the endpoint answers, since
   * which of them are pickers depends on whether it served a model list.
   */
  const startProviderSetup = (
    kind: ProviderSetupKind,
    wireApi?: 'chat' | 'responses',
    // A choice the user just made on the previous screen, which therefore
    // outranks whatever the environment happens to hold. OpenCode's two
    // products differ only by base URL, so picking Go while OPENCODE_BASE_URL
    // still names Zen has to land on Go — otherwise the selection is silently
    // discarded and the session bills the wrong balance.
    chosenBaseUrl?: string,
  ): void => {
    const spec = PROVIDER_SETUP_SPECS[kind];
    setOAuthStatus({
      state: 'provider_endpoint_setup',
      kind,
      phase: 'editing',
      // Left blank the field means "use the provider's own default", which is
      // only harmless when the client re-derives that default at request time.
      // OpenCode's does not: applyOpencodeWire() returns early without
      // OPENCODE_BASE_URL, so the session would claim a routing it never
      // applied — requests to the previous provider's host, unauthenticated.
      baseUrl: chosenBaseUrl ?? process.env[spec.env.baseUrl] ?? (kind === 'opencode' ? spec.defaultBaseUrl : ''),
      // Grok accepts either name for its key; XAI_API_KEY is the xAI-native one.
      apiKey: process.env[spec.env.apiKey] ?? (kind === 'grok' ? (process.env.XAI_API_KEY ?? '') : ''),
      ...(wireApi ? { wireApi } : {}),
      activeField: 'base_url',
    });
  };

  switch (oauthStatus.state) {
    case 'idle':
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>
            {startingMessage
              ? startingMessage
              : `Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.`}
          </Text>

          <Text>Select login method:</Text>

          <Box>
            <Select
              options={[
                {
                  label: (
                    <Text>
                      Anthropic Compatible · <Text dimColor>Configure your own API endpoint</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'custom_platform',
                },
                {
                  label: (
                    <Text>
                      OpenAI Chat Completions ·{' '}
                      <Text dimColor>/chat/completions — Ollama, DeepSeek, vLLM, One API</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'openai_chat_api',
                },
                {
                  label: (
                    <Text>
                      OpenAI Responses API · <Text dimColor>/responses — Codex-style servers, GPT-5 generation</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'openai_responses_api',
                },
                {
                  label: (
                    <Text>
                      China LLM Providers · <Text dimColor>DeepSeek, Zhipu GLM, Qwen, MiMo</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'china_providers',
                },
                {
                  label: (
                    <Text>
                      OpenCode Zen ·{' '}
                      <Text dimColor>
                        Pay-as-you-go gateway — {OPENCODE_PRODUCTS.zen.models.length} models incl. Claude, billed
                        against a credit balance
                      </Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'opencode_zen',
                },
                {
                  /* A separate row rather than a sub-choice: Zen and Go are one
                     path segment apart on the same host, and a Go subscriber
                     who lands on Zen is billed against a credit balance they
                     have not funded — the only symptom is "Insufficient
                     balance", which names neither product. */
                  label: (
                    <Text>
                      OpenCode Go ·{' '}
                      <Text dimColor>
                        Flat monthly subscription — {OPENCODE_PRODUCTS.go.models.length} open-coding models, no Claude
                      </Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'opencode_go',
                },
                {
                  label: (
                    <Text>
                      ChatGPT account with subscription · <Text dimColor>Plus, Pro, Business, Edu, or Enterprise</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'chatgpt_subscription',
                },
                {
                  label: (
                    <Text>
                      Gemini API · <Text dimColor>Google Gemini native REST/SSE</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'gemini_api',
                },
                {
                  label: (
                    <Text>
                      Antigravity (Google OAuth) · <Text dimColor>Gemini 3 with a Google account, no API key</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'antigravity_oauth',
                },
                {
                  label: (
                    <Text>
                      Grok API · <Text dimColor>xAI Grok (api.x.ai)</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'grok_api',
                },
                {
                  label: (
                    <Text>
                      Claude account with subscription · <Text dimColor>Pro, Max, Team, or Enterprise</Text>
                      {process.env.USER_TYPE === 'ant' && (
                        <Text>
                          {'\n'}
                          <Text color="warning">[ANT-ONLY]</Text>{' '}
                          <Text dimColor>
                            Please use this option unless you need to login to a special org for accessing sensitive
                            data (e.g. customer data, HIPI data) with the Console option
                          </Text>
                        </Text>
                      )}
                      {'\n'}
                    </Text>
                  ),
                  value: 'claudeai',
                },
                {
                  label: (
                    <Text>
                      Anthropic Console account · <Text dimColor>API usage billing</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'console',
                },
                {
                  label: (
                    <Text>
                      3rd-party platform · <Text dimColor>Amazon Bedrock, Microsoft Foundry, or Vertex AI</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'platform',
                },
              ]}
              onChange={value => {
                if (value === 'custom_platform') {
                  logEvent('tengu_custom_platform_selected', {});
                  startProviderSetup('anthropic');
                } else if (value === 'openai_chat_api' || value === 'openai_responses_api') {
                  const wireApi = value === 'openai_responses_api' ? 'responses' : 'chat';
                  logEvent(
                    wireApi === 'responses' ? 'tengu_openai_responses_api_selected' : 'tengu_openai_chat_api_selected',
                    {},
                  );
                  startProviderSetup('openai', wireApi);
                } else if (value === 'china_providers') {
                  logEvent('tengu_china_providers_selected', {});
                  setOAuthStatus({ state: 'china_provider_select', activeIndex: 0 });
                } else if (value === 'opencode_zen' || value === 'opencode_go') {
                  logEvent('tengu_opencode_selected', {});
                  setOAuthStatus({
                    state: 'opencode_method_select',
                    product: value === 'opencode_go' ? 'go' : 'zen',
                  });
                } else if (value === 'chatgpt_subscription') {
                  logEvent('tengu_chatgpt_subscription_selected', {});
                  setOAuthStatus({
                    state: 'chatgpt_subscription',
                    phase: 'requesting',
                  });
                } else if (value === 'gemini_api') {
                  logEvent('tengu_gemini_api_selected', {});
                  startProviderSetup('gemini');
                } else if (value === 'antigravity_oauth') {
                  logEvent('tengu_antigravity_oauth_selected', {});
                  setOAuthStatus({ state: 'antigravity_oauth', phase: 'starting' });
                } else if (value === 'grok_api') {
                  logEvent('tengu_grok_api_selected', {});
                  startProviderSetup('grok');
                } else if (value === 'platform') {
                  logEvent('tengu_oauth_platform_selected', {});
                  setOAuthStatus({ state: 'platform_setup' });
                } else {
                  setOAuthStatus({ state: 'ready_to_start' });
                  if (value === 'claudeai') {
                    logEvent('tengu_oauth_claudeai_selected', {});
                    setLoginWithClaudeAi(true);
                  } else {
                    logEvent('tengu_oauth_console_selected', {});
                    setLoginWithClaudeAi(false);
                  }
                }
              }}
            />
          </Box>
        </Box>
      );

    case 'provider_endpoint_setup':
    case 'provider_model_setup':
      return (
        <ProviderSetupWizard
          status={oauthStatus}
          setStatus={setOAuthStatus}
          onError={(message, retry) => setOAuthStatus({ state: 'error', message, toRetry: retry })}
          onCancel={() => {
            // The China presets enter at the model step, so "back" there means
            // the key screen they came from — not the login menu.
            const preset = oauthStatus.kind === 'china' ? chinaPresetForStatus(oauthStatus) : undefined;
            return backFrom(
              statusRef,
              setOAuthStatus,
              oauthStatus.state,
              preset
                ? {
                    state: 'china_apikey',
                    provider: preset,
                    mode: chinaModeForStatus(oauthStatus),
                    apiKey: '',
                  }
                : { state: 'idle' },
            );
          }}
          onSaved={outcome => {
            setOAuthStatus({ state: 'success' });
            onProviderChanged?.(outcome);
            void onDone();
          }}
        />
      );

    case 'chatgpt_subscription':
      return (
        <ChatGPTSubscriptionSetup
          status={oauthStatus}
          setOAuthStatus={setOAuthStatus}
          onDone={onDone}
          onProviderChanged={onProviderChanged}
        />
      );

    case 'antigravity_oauth':
      return (
        <AntigravityOAuthSetup
          status={oauthStatus}
          setOAuthStatus={setOAuthStatus}
          onDone={onDone}
          onProviderChanged={onProviderChanged}
        />
      );

    case 'opencode_method_select': {
      // Both credential kinds resolve to the same bearer value downstream, so
      // this screen is about where the credential comes from, not about what
      // the session can then reach.
      const { product } = oauthStatus;
      const { baseUrl, billing, label, models } = OPENCODE_PRODUCTS[product];
      // Zen only. Go ships no `-free` ids at all, and offering "free models"
      // there would open a picker with nothing in it.
      const freeCount = product === 'zen' ? models.filter(isFreeZenModel).length : 0;
      // Precedence is key-over-OAuth (services/auth/opencode/oauth.ts). occ
      // clears the key it wrote itself when a Console login succeeds, but a key
      // exported in the user's shell is theirs and stays — silently outranking
      // the login they are about to perform, which is worth saying out loud.
      const shellKey = process.env.OPENCODE_API_KEY?.trim();
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>{label} — Select Credential</Text>
          <Text dimColor>
            {product === 'go'
              ? `A ${billing} over ${models.length} open-coding models — Kimi, MiniMax, GLM, Qwen, DeepSeek, MiMo and more, plus one GPT and one Grok. No Claude: Go does not serve it at any tier.`
              : `One gateway, ${models.length} models across Anthropic, OpenAI, Google, DeepSeek, xAI and more, ${billing}.`}{' '}
            Which wire protocol a session speaks follows from the model you pick next.
          </Text>
          <Box>
            <Select
              options={[
                {
                  label: (
                    <Text>
                      Console subscription · <Text dimColor>Sign in with your OpenCode account (device code)</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'subscription',
                },
                {
                  label: (
                    <Text>
                      API key · <Text dimColor>An OpenCode or service-account key you already have</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'apikey',
                },
                ...(freeCount > 0
                  ? [
                      {
                        label: (
                          <Text>
                            Free models only ·{' '}
                            <Text dimColor>
                              No account — {freeCount} free models answer, the rest need a credential
                            </Text>
                            {'\n'}
                          </Text>
                        ),
                        value: 'free',
                      },
                    ]
                  : []),
              ]}
              onChange={value => {
                logEvent('tengu_opencode_method_selected', {});
                if (value === 'subscription') {
                  setOAuthStatus({ state: 'opencode_device', product, phase: 'requesting' });
                  return;
                }
                if (value === 'free') {
                  // Straight into the catalog request: the public bearer needs
                  // no form, and the endpoint answers /models for it, so the
                  // user lands on a real model list rather than occ's fallback.
                  setOAuthStatus({
                    state: 'provider_endpoint_setup',
                    kind: 'opencode',
                    phase: 'fetching',
                    baseUrl,
                    apiKey: ZEN_PUBLIC_KEY,
                    activeField: 'api_key',
                  });
                  return;
                }
                startProviderSetup('opencode', undefined, baseUrl);
              }}
              onCancel={() => setOAuthStatus({ state: 'idle' })}
            />
          </Box>
          {product === 'zen' ? (
            <Text dimColor>
              Free models are the ids ending in <Text bold>-free</Text>, plus <Text bold>big-pickle</Text>. Everything
              else is billed to whichever credential you configure.
            </Text>
          ) : null}
          {/* The two products share a host and an account, so nothing later in
              the flow can catch a wrong pick: a Go key sent to Zen is charged
              to the Zen credit balance and answers "Insufficient balance". */}
          <Text dimColor>
            Requests go to {baseUrl} — {billing}.
          </Text>
          {shellKey ? (
            <Text color="warning">
              OPENCODE_API_KEY is already set in this environment. An API key takes precedence over a Console login, so
              unset it in your shell if you want the subscription to be used.
            </Text>
          ) : null}
          <Text dimColor>Esc to go back</Text>
        </Box>
      );
    }

    case 'opencode_device':
      return (
        <OpencodeDeviceLogin
          product={oauthStatus.product}
          phase={oauthStatus.phase}
          {...(oauthStatus.grant ? { grant: oauthStatus.grant } : {})}
          onPhase={(phase, grant) =>
            setOAuthStatus({
              state: 'opencode_device',
              product: oauthStatus.product,
              phase,
              ...(grant ? { grant } : {}),
            })
          }
          onReady={setOAuthStatus}
          onError={message =>
            setOAuthStatus({
              state: 'error',
              message,
              // Retrying has to land on the same product; dropping it here
              // would restart the device flow against Zen no matter which one
              // the user chose.
              toRetry: { state: 'opencode_device', product: oauthStatus.product, phase: 'requesting' },
            })
          }
          onCancel={() => setOAuthStatus({ state: 'opencode_method_select', product: oauthStatus.product })}
        />
      );

    case 'china_provider_select': {
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>Select China LLM Provider</Text>
          <Text dimColor>Direct connection, no proxy needed. All providers are OpenAI-compatible.</Text>
          <Box>
            <Select
              options={CHINA_LLM_PROVIDERS.map(p => ({
                label: (
                  <Text>
                    {p.icon} {p.label} · <Text dimColor>{p.description}</Text>
                    {'\n'}
                  </Text>
                ),
                value: p.id,
              }))}
              onChange={value => {
                const provider = CHINA_LLM_PROVIDERS.find(p => p.id === value);
                if (!provider) return;
                logEvent('tengu_china_provider_selected', {});
                if (provider.codingPlan) {
                  setOAuthStatus({ state: 'china_mode_select', provider, activeIndex: 0 });
                } else {
                  setOAuthStatus({ state: 'china_apikey', provider, mode: 'api', apiKey: '' });
                }
              }}
            />
          </Box>
        </Box>
      );
    }

    case 'china_mode_select': {
      const { provider } = oauthStatus;
      const modeOptions = [
        { id: 'api' as const, label: 'Pay-as-you-go (API)', desc: 'Top up freely, pay per use' },
        { id: 'coding-plan' as const, label: 'Coding Plan', desc: 'Fixed monthly fee, high usage' },
      ];
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>
            {provider.icon} {provider.label} — Select Access Mode
          </Text>
          <Box>
            <Select
              options={modeOptions.map(m => ({
                label: (
                  <Text>
                    {m.label} · <Text dimColor>{m.desc}</Text>
                    {'\n'}
                  </Text>
                ),
                value: m.id,
              }))}
              onChange={value => {
                logEvent('tengu_china_mode_selected', {});
                setOAuthStatus({
                  state: 'china_apikey',
                  provider,
                  mode: value as 'api' | 'coding-plan',
                  apiKey: '',
                });
              }}
            />
          </Box>
          <Text dimColor>
            No plan? Select "Pay-as-you-go"
            {provider.id === 'zhipu' ? ' · GLM-4.7-Flash is free forever' : ''}
          </Text>
        </Box>
      );
    }

    case 'china_apikey': {
      const { provider, mode: accessMode } = oauthStatus;

      const [chinaKeyValue, setChinaKeyValue] = useState('');
      const [chinaKeyCursor, setChinaKeyCursor] = useState(0);
      const [chinaKeyError, setChinaKeyError] = useState<string | null>(null);
      const chinaKeyColumns = useTerminalSize().columns - 12;

      // Hands off to the shared model step instead of saving here. The key is
      // still unwritten at this point — nothing is persisted until that step is
      // submitted, same contract as every other provider.
      const doChinaContinue = useCallback(() => {
        if (!chinaKeyValue.trim()) {
          setChinaKeyError('Please enter an API key');
          return;
        }
        logEvent('tengu_china_login_success', {});
        setOAuthStatus({
          state: 'provider_model_setup',
          kind: 'china',
          baseUrl: resolveChinaProviderBaseURL(provider.id, accessMode),
          apiKey: chinaKeyValue.trim(),
          providerLabel: provider.label,
          // The preset table, not the endpoint's /models answer: it is here
          // immediately and the tier defaults below are expressed in its ids.
          entryMode: 'catalog',
          models: provider.models.map(m => ({ id: m.id, displayName: m.label })),
          model: provider.defaultModel,
          // Both empty: the model step turns that into each tier's own family
          // default and persists it per tier, which is the right answer here —
          // one preset can mix windows across its catalog, so a single value
          // typed once would be wrong for at least one tier.
          maxContext: '',
          effort: '',
          haikuModel: provider.tiers.haiku,
          sonnetModel: provider.tiers.sonnet,
          opusModel: provider.tiers.opus,
          fableModel: provider.tiers.fable,
          activeField: 'model',
        });
      }, [chinaKeyValue, provider, accessMode, setOAuthStatus]);

      useKeybinding(
        'confirm:no',
        () => {
          return backFrom(
            statusRef,
            setOAuthStatus,
            'china_apikey',
            provider.codingPlan
              ? { state: 'china_mode_select', provider, activeIndex: 0 }
              : { state: 'china_provider_select', activeIndex: 0 },
          );
        },
        { context: 'Confirmation' },
      );

      const isCodingPlan = accessMode === 'coding-plan' && provider.codingPlan !== undefined;
      const keyPage = isCodingPlan && provider.codingPlan ? provider.codingPlan.purchasePage : provider.apiKeyPage;
      const keyFormat = isCodingPlan && provider.codingPlan ? provider.codingPlan.keyFormat : provider.keyFormat;

      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>
            {provider.icon} {provider.label} API Key
          </Text>
          <Box flexDirection="column" gap={0}>
            <Text dimColor> Get your key: {keyPage}</Text>
            <Text dimColor> {isCodingPlan ? 'Use your Coding Plan credential here' : provider.freeTier}</Text>
            <Text dimColor> Key format: {keyFormat}</Text>
          </Box>
          <Box>
            <Text>API Key: </Text>
            <TextInput
              value={chinaKeyValue}
              onChange={v => {
                setChinaKeyValue(v);
                setChinaKeyError(null);
              }}
              onSubmit={doChinaContinue}
              cursorOffset={chinaKeyCursor}
              onChangeCursorOffset={setChinaKeyCursor}
              columns={chinaKeyColumns}
              mask="*"
              focus={true}
            />
          </Box>
          {chinaKeyError ? <Text color="error">{chinaKeyError}</Text> : null}
          <Text dimColor>
            This key enables every {provider.label} model. Next you can pick which one each tier resolves to — the
            defaults are already filled in.
          </Text>
          <Text dimColor>Enter to continue · Esc to go back</Text>
        </Box>
      );
    }

    case 'platform_setup':
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>Using 3rd-party platforms</Text>

          <Box flexDirection="column" gap={1}>
            <Text>
              Claude Code supports Amazon Bedrock, Microsoft Foundry, and Vertex AI. Set the required environment
              variables, then restart Claude Code.
            </Text>

            <Text>
              If you are part of an enterprise organization, contact your administrator for setup instructions.
            </Text>

            <Box flexDirection="column" marginTop={1}>
              <Text bold>Documentation:</Text>
              <Text>
                · Amazon Bedrock:{' '}
                <Link url="https://code.claude.com/docs/en/amazon-bedrock">
                  https://code.claude.com/docs/en/amazon-bedrock
                </Link>
              </Text>
              <Text>
                · Microsoft Foundry:{' '}
                <Link url="https://code.claude.com/docs/en/microsoft-foundry">
                  https://code.claude.com/docs/en/microsoft-foundry
                </Link>
              </Text>
              <Text>
                · Vertex AI:{' '}
                <Link url="https://code.claude.com/docs/en/google-vertex-ai">
                  https://code.claude.com/docs/en/google-vertex-ai
                </Link>
              </Text>
            </Box>

            <Box marginTop={1}>
              <Text dimColor>
                Press <Text bold>Enter</Text> to go back to login options.
              </Text>
            </Box>
          </Box>
        </Box>
      );

    case 'waiting_for_login':
      return (
        <Box flexDirection="column" gap={1}>
          {forcedMethodMessage && (
            <Box>
              <Text dimColor>{forcedMethodMessage}</Text>
            </Box>
          )}

          {!showPastePrompt && (
            <Box>
              <Spinner />
              <Text>Opening browser to sign in…</Text>
            </Box>
          )}

          {showPastePrompt && (
            <Box>
              <Text>{PASTE_HERE_MSG}</Text>
              <TextInput
                value={pastedCode}
                onChange={setPastedCode}
                onSubmit={(value: string) => handleSubmitCode(value, oauthStatus.url)}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                columns={textInputColumns}
                mask="*"
              />
            </Box>
          )}
        </Box>
      );

    case 'creating_api_key':
      return (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Spinner />
            <Text>Creating API key for Claude Code…</Text>
          </Box>
        </Box>
      );

    case 'about_to_retry':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="permission">Retrying…</Text>
        </Box>
      );

    case 'success':
      return (
        <Box flexDirection="column">
          {mode === 'setup-token' && oauthStatus.token ? null : (
            <>
              {getOauthAccountInfo()?.emailAddress ? (
                <Text dimColor>
                  Logged in as <Text>{getOauthAccountInfo()?.emailAddress}</Text>
                </Text>
              ) : null}
              <Text color="success">
                Login successful. Press <Text bold>Enter</Text> to continue…
              </Text>
            </>
          )}
        </Box>
      );

    case 'error':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error">OAuth error: {oauthStatus.message}</Text>

          {oauthStatus.toRetry && (
            <Box marginTop={1}>
              <Text color="permission">
                Press <Text bold>Enter</Text> to retry.
              </Text>
            </Box>
          )}
        </Box>
      );

    default:
      return null;
  }
}
