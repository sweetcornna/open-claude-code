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
  removeChatGPTAuth,
  requestChatGPTDeviceCode,
  type ChatGPTDeviceCode,
} from '../services/api/openai/chatgptAuth.js';
import { clearOpenAIClientCache } from '../services/api/openai/client.js';
import { clearGrokClientCache } from '../services/api/grok/client.js';
import { startAntigravityOAuthLogin } from '../services/auth/antigravity/index.js';
import { fetchOpenAICompatibleModelsWith } from '../services/modelCatalog/fetch.js';
import type { CatalogModel } from '../services/modelCatalog/types.js';
import { buildAntigravityAutoConfigEnv } from '../utils/model/antigravityModels.js';
import { OAuthService } from '../services/oauth/index.js';
import { getOauthAccountInfo, validateForceLoginOrg } from '../utils/auth/auth.js';
import { openBrowser } from '../utils/network/browser.js';
import { logError } from '../utils/telemetry/log.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import {
  CHINA_LLM_PROVIDERS,
  parseContextWindowTokens,
  type ProviderPreset,
  resolveChinaProviderBaseURL,
} from 'src/utils/model/chinaLlmProviders.js';
import { Select } from './CustomSelect/select.js';
import { Spinner } from './Spinner.js';
import TextInput from './TextInput.js';

type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
};

type OpenAIWireApi = 'chat' | 'responses';
type OpenAIEndpointField = 'base_url' | 'api_key' | 'wire_api';
type OpenAIModelField = 'model' | 'haiku_model' | 'sonnet_model' | 'opus_model' | 'max_context';

type OpenAIEndpointSetupStatus = {
  state: 'openai_endpoint_setup';
  phase: 'editing' | 'fetching';
  baseUrl: string;
  apiKey: string;
  wireApi: OpenAIWireApi;
  activeField: OpenAIEndpointField;
};

type OpenAIModelSetupBase = {
  state: 'openai_model_setup';
  baseUrl: string;
  apiKey: string;
  wireApi: OpenAIWireApi;
  model: string;
  maxContext: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
  activeField: OpenAIModelField;
};

type OpenAIModelSetupStatus = OpenAIModelSetupBase &
  ({ entryMode: 'catalog'; models: CatalogModel[] } | { entryMode: 'manual'; fetchError: string });

type OAuthStatus =
  | { state: 'idle' } // Initial state, waiting to select login method
  | { state: 'platform_setup' } // Show platform setup info (Bedrock/Vertex/Foundry)
  | {
      state: 'custom_platform';
      baseUrl: string;
      apiKey: string;
      model: string;
      maxContext: string;
      haikuModel: string;
      sonnetModel: string;
      opusModel: string;
      activeField: 'base_url' | 'api_key' | 'model' | 'max_context' | 'haiku_model' | 'sonnet_model' | 'opus_model';
    } // Custom platform: configure API endpoint and model names
  | OpenAIEndpointSetupStatus
  | OpenAIModelSetupStatus
  | {
      state: 'chatgpt_subscription';
      phase: 'requesting' | 'waiting';
      deviceCode?: ChatGPTDeviceCode;
    } // ChatGPT account subscription via Codex OAuth device flow
  | {
      state: 'gemini_api';
      baseUrl: string;
      apiKey: string;
      model: string;
      maxContext: string;
      haikuModel: string;
      sonnetModel: string;
      opusModel: string;
      activeField: 'base_url' | 'api_key' | 'model' | 'max_context' | 'haiku_model' | 'sonnet_model' | 'opus_model';
    } // Gemini Generate Content API platform
  | {
      state: 'antigravity_oauth';
      phase: 'starting' | 'waiting';
      authUrl?: string;
    } // Google Antigravity subscription via Google OAuth loopback flow
  | {
      state: 'grok_api';
      baseUrl: string;
      apiKey: string;
      model: string;
      maxContext: string;
      activeField: 'base_url' | 'api_key' | 'model' | 'max_context';
    } // xAI Grok API platform
  | { state: 'china_provider_select'; activeIndex: number } // China LLM: pick provider
  | { state: 'china_mode_select'; provider: ProviderPreset; activeIndex: number } // China LLM: pick access mode
  | { state: 'china_model_select'; provider: ProviderPreset; mode: 'api' | 'coding-plan'; activeIndex: number } // China LLM: pick model
  | { state: 'china_apikey'; provider: ProviderPreset; mode: 'api' | 'coding-plan'; modelId: string; apiKey: string } // China LLM: enter API key
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

const PASTE_HERE_MSG = 'Paste code here if prompted > ';

/**
 * Parse the optional "Max ctx" form field into a CLAUDE_CODE_MAX_CONTEXT_TOKENS
 * value. Accepts a plain token count ('128000') or a K/M shorthand ('128k',
 * '1m'). Returns undefined for empty (leave unset), null for invalid input.
 */
export function parseMaxContextInput(raw: string): string | undefined | null {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? String(n) : null;
  }
  const viaSuffix = parseContextWindowTokens(trimmed);
  return viaSuffix ? String(viaSuffix) : null;
}

function normalizeOpenAIWireApi(value: string | undefined): OpenAIWireApi {
  return value === 'responses' ? 'responses' : 'chat';
}

export function ConsoleOAuthFlow({
  onDone,
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
          setLoginWithClaudeAi={setLoginWithClaudeAi}
          onDone={onDone}
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
  setCursorOffset: (offset: number) => void;
  textInputColumns: number;
  handleSubmitCode: (value: string, url: string) => void;
  setOAuthStatus: (status: OAuthStatus) => void;
  setLoginWithClaudeAi: (value: boolean) => void;
};

const OPENAI_WIRE_API_OPTIONS: Array<{ label: string; value: OpenAIWireApi }> = [
  {
    label: 'Chat Completions (default) — the /chat/completions endpoint most servers support',
    value: 'chat',
  },
  {
    label: 'Responses — the /responses endpoint used by Codex-style OpenAI servers',
    value: 'responses',
  },
];

function formatOpenAIWireApi(value: OpenAIWireApi): string {
  return OPENAI_WIRE_API_OPTIONS.find(option => option.value === value)?.label ?? value;
}

type OpenAIEndpointSetupProps = {
  status: Extract<OAuthStatus, { state: 'openai_endpoint_setup' }>;
  setOAuthStatus: (status: OAuthStatus) => void;
};

function OpenAIEndpointSetup({ status, setOAuthStatus }: OpenAIEndpointSetupProps): React.ReactNode {
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [apiKey, setApiKey] = useState(status.apiKey);
  const [wireApi, setWireApi] = useState<OpenAIWireApi>(status.wireApi);
  const [activeField, setActiveField] = useState<OpenAIEndpointField>(status.activeField);
  const [inputCursorOffset, setInputCursorOffset] = useState(() =>
    status.activeField === 'base_url' ? status.baseUrl.length : status.apiKey.length,
  );
  const fetchControllerRef = useRef<AbortController | null>(null);
  const inputColumns = Math.max(20, useTerminalSize().columns - 18);

  const buildEditingStatus = useCallback(
    (field: OpenAIEndpointField): OpenAIEndpointSetupStatus => ({
      state: 'openai_endpoint_setup',
      phase: 'editing',
      baseUrl,
      apiKey,
      wireApi,
      activeField: field,
    }),
    [apiKey, baseUrl, wireApi],
  );

  const beginModelFetch = useCallback(
    (selectedWireApi: OpenAIWireApi) => {
      const trimmedBaseUrl = baseUrl.trim();
      const trimmedApiKey = apiKey.trim();
      const retryState: OpenAIEndpointSetupStatus = {
        state: 'openai_endpoint_setup',
        phase: 'editing',
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedApiKey,
        wireApi: selectedWireApi,
        activeField: 'base_url',
      };

      if (!trimmedBaseUrl) {
        setOAuthStatus({
          state: 'error',
          message: 'Base URL is required. Enter the full server URL, including https:// or http://.',
          toRetry: retryState,
        });
        return;
      }
      try {
        new URL(trimmedBaseUrl);
      } catch {
        setOAuthStatus({
          state: 'error',
          message: 'Invalid Base URL. Enter the full server URL, including https:// or http://.',
          toRetry: retryState,
        });
        return;
      }
      if (!trimmedApiKey) {
        setOAuthStatus({
          state: 'error',
          message: 'API Key is required so the server can authorize the model-list request.',
          toRetry: { ...retryState, activeField: 'api_key' },
        });
        return;
      }

      setOAuthStatus({
        state: 'openai_endpoint_setup',
        phase: 'fetching',
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedApiKey,
        wireApi: selectedWireApi,
        activeField: 'wire_api',
      });
    },
    [apiKey, baseUrl, setOAuthStatus],
  );

  useEffect(() => {
    if (status.phase !== 'fetching') return;

    const controller = new AbortController();
    fetchControllerRef.current = controller;
    let disposed = false;
    let failureReason = 'the request failed';

    void fetchOpenAICompatibleModelsWith({
      baseURL: status.baseUrl,
      apiKey: status.apiKey,
      signal: controller.signal,
      onError: reason => {
        failureReason = reason;
      },
    }).then(models => {
      if (disposed || controller.signal.aborted) return;

      const common = {
        state: 'openai_model_setup' as const,
        baseUrl: status.baseUrl,
        apiKey: status.apiKey,
        wireApi: status.wireApi,
        model: process.env.OPENAI_MODEL ?? '',
        maxContext: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '',
        haikuModel: process.env.OPENAI_DEFAULT_HAIKU_MODEL ?? '',
        sonnetModel: process.env.OPENAI_DEFAULT_SONNET_MODEL ?? '',
        opusModel: process.env.OPENAI_DEFAULT_OPUS_MODEL ?? '',
        activeField: 'model' as const,
      };

      if (models) {
        const modelIds = new Set(models.map(model => model.id));
        setOAuthStatus({
          ...common,
          entryMode: 'catalog',
          models,
          model: modelIds.has(common.model) ? common.model : '',
          haikuModel: modelIds.has(common.haikuModel) ? common.haikuModel : '',
          sonnetModel: modelIds.has(common.sonnetModel) ? common.sonnetModel : '',
          opusModel: modelIds.has(common.opusModel) ? common.opusModel : '',
        });
        return;
      }

      setOAuthStatus({
        ...common,
        entryMode: 'manual',
        fetchError: failureReason,
      });
    });

    return () => {
      disposed = true;
      controller.abort();
      if (fetchControllerRef.current === controller) fetchControllerRef.current = null;
    };
  }, [setOAuthStatus, status]);

  useKeybinding(
    'confirm:no',
    () => {
      if (status.phase === 'fetching') {
        fetchControllerRef.current?.abort();
        setActiveField('wire_api');
        setOAuthStatus(buildEditingStatus('wire_api'));
        return;
      }
      setOAuthStatus({ state: 'idle' });
    },
    { context: 'Confirmation' },
  );

  const handleTextSubmit = () => {
    if (activeField === 'base_url') {
      setActiveField('api_key');
      setInputCursorOffset(apiKey.length);
    } else if (activeField === 'api_key') {
      setActiveField('wire_api');
    }
  };

  const maskedApiKey = apiKey ? apiKey.slice(0, 8) + '\u00b7'.repeat(Math.max(0, apiKey.length - 8)) : '';

  if (status.phase === 'fetching') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>OpenAI Compatible API Setup — Fetch Models</Text>
        <Box>
          <Spinner />
          <Text>Fetching available models from {status.baseUrl}…</Text>
        </Box>
        <Text dimColor>Esc cancels the request and returns to endpoint setup.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>OpenAI Compatible API Setup — Step 1 of 2</Text>
      <Text dimColor>
        Enter the server connection details first. occ will then request GET /models before any settings are saved.
      </Text>
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text
            backgroundColor={activeField === 'base_url' ? 'suggestion' : undefined}
            color={activeField === 'base_url' ? 'inverseText' : undefined}
          >
            {' Base URL '}
          </Text>
          <Text> </Text>
          {activeField === 'base_url' ? (
            <TextInput
              value={baseUrl}
              onChange={setBaseUrl}
              onSubmit={handleTextSubmit}
              cursorOffset={inputCursorOffset}
              onChangeCursorOffset={setInputCursorOffset}
              columns={inputColumns}
              focus={true}
            />
          ) : (
            <Text color="success">{baseUrl}</Text>
          )}
        </Box>
        <Box>
          <Text
            backgroundColor={activeField === 'api_key' ? 'suggestion' : undefined}
            color={activeField === 'api_key' ? 'inverseText' : undefined}
          >
            {' API Key '}
          </Text>
          <Text> </Text>
          {activeField === 'api_key' ? (
            <TextInput
              value={apiKey}
              onChange={setApiKey}
              onSubmit={handleTextSubmit}
              cursorOffset={inputCursorOffset}
              onChangeCursorOffset={setInputCursorOffset}
              columns={inputColumns}
              mask="*"
              focus={true}
            />
          ) : (
            <Text color="success">{maskedApiKey}</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text
            backgroundColor={activeField === 'wire_api' ? 'suggestion' : undefined}
            color={activeField === 'wire_api' ? 'inverseText' : undefined}
          >
            {' Wire API protocol '}
          </Text>
          {activeField === 'wire_api' ? (
            <Select
              options={OPENAI_WIRE_API_OPTIONS}
              defaultValue={wireApi}
              defaultFocusValue={wireApi}
              visibleOptionCount={2}
              onChange={value => {
                setWireApi(value);
                beginModelFetch(value);
              }}
              onCancel={() => setOAuthStatus({ state: 'idle' })}
            />
          ) : (
            <Text color="success">{formatOpenAIWireApi(wireApi)}</Text>
          )}
        </Box>
      </Box>
      <Text dimColor>
        Base URL is the OpenAI-compatible server root, such as https://api.example.com/v1. API Key authorizes the
        model-list request.
      </Text>
      <Text dimColor>
        Enter moves to the next field. Select the Wire API protocol to fetch models. Esc returns to login methods.
      </Text>
    </Box>
  );
}

type OpenAIModelSetupProps = {
  status: Extract<OAuthStatus, { state: 'openai_model_setup' }>;
  setOAuthStatus: (status: OAuthStatus) => void;
  onDone: () => void;
};

const OPENAI_MODEL_FIELDS: OpenAIModelField[] = ['model', 'haiku_model', 'sonnet_model', 'opus_model', 'max_context'];

function OpenAIModelSetup({ status, setOAuthStatus, onDone }: OpenAIModelSetupProps): React.ReactNode {
  const [model, setModel] = useState(status.model);
  const [haikuModel, setHaikuModel] = useState(status.haikuModel);
  const [sonnetModel, setSonnetModel] = useState(status.sonnetModel);
  const [opusModel, setOpusModel] = useState(status.opusModel);
  const [maxContext, setMaxContext] = useState(status.maxContext);
  const [activeField, setActiveField] = useState<OpenAIModelField>(status.activeField);
  const [inputCursorOffset, setInputCursorOffset] = useState(() => {
    const initialValues: Record<OpenAIModelField, string> = {
      model: status.model,
      haiku_model: status.haikuModel,
      sonnet_model: status.sonnetModel,
      opus_model: status.opusModel,
      max_context: status.maxContext,
    };
    return initialValues[status.activeField].length;
  });
  const inputColumns = Math.max(20, useTerminalSize().columns - 24);

  const getValue = (field: OpenAIModelField): string => {
    switch (field) {
      case 'model':
        return model;
      case 'haiku_model':
        return haikuModel;
      case 'sonnet_model':
        return sonnetModel;
      case 'opus_model':
        return opusModel;
      case 'max_context':
        return maxContext;
    }
  };

  const setValue = (field: OpenAIModelField, value: string): void => {
    switch (field) {
      case 'model':
        setModel(value);
        return;
      case 'haiku_model':
        setHaikuModel(value);
        return;
      case 'sonnet_model':
        setSonnetModel(value);
        return;
      case 'opus_model':
        setOpusModel(value);
        return;
      case 'max_context':
        setMaxContext(value);
    }
  };

  const buildRetryStatus = (field: OpenAIModelField): OpenAIModelSetupStatus => {
    const common: OpenAIModelSetupBase = {
      state: 'openai_model_setup',
      baseUrl: status.baseUrl,
      apiKey: status.apiKey,
      wireApi: status.wireApi,
      model,
      maxContext,
      haikuModel,
      sonnetModel,
      opusModel,
      activeField: field,
    };
    return status.entryMode === 'catalog'
      ? { ...common, entryMode: 'catalog', models: status.models }
      : { ...common, entryMode: 'manual', fetchError: status.fetchError };
  };

  const returnToEndpointSetup = () => {
    setOAuthStatus({
      state: 'openai_endpoint_setup',
      phase: 'editing',
      baseUrl: status.baseUrl,
      apiKey: status.apiKey,
      wireApi: status.wireApi,
      activeField: 'base_url',
    });
  };

  useKeybinding('confirm:no', returnToEndpointSetup, { context: 'Confirmation' });

  const advanceFrom = (field: OpenAIModelField): void => {
    const index = OPENAI_MODEL_FIELDS.indexOf(field);
    const next = OPENAI_MODEL_FIELDS[index + 1];
    if (!next) return;
    setActiveField(next);
    setInputCursorOffset(getValue(next).length);
  };

  const doSave = (): void => {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      setOAuthStatus({
        state: 'error',
        message: 'Default model is required. Choose or enter a model name for OPENAI_MODEL.',
        toRetry: buildRetryStatus('model'),
      });
      return;
    }

    const maxContextValue = parseMaxContextInput(maxContext);
    if (maxContextValue === null) {
      setOAuthStatus({
        state: 'error',
        message: 'Invalid maximum context tokens. Enter a token count such as 128000, 128k, or 1m, or leave it empty.',
        toRetry: buildRetryStatus('max_context'),
      });
      return;
    }

    const env: Record<string, string | undefined> = {
      OPENAI_AUTH_MODE: undefined,
      OPENAI_BASE_URL: status.baseUrl,
      OPENAI_API_KEY: status.apiKey,
      OPENAI_MODEL: trimmedModel,
      OPENAI_WIRE_API: status.wireApi,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: maxContextValue,
    };
    if (haikuModel.trim()) env.OPENAI_DEFAULT_HAIKU_MODEL = haikuModel.trim();
    if (sonnetModel.trim()) env.OPENAI_DEFAULT_SONNET_MODEL = sonnetModel.trim();
    if (opusModel.trim()) env.OPENAI_DEFAULT_OPUS_MODEL = opusModel.trim();

    const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
      modelType: 'openai',
      env: env as unknown as Record<string, string>,
    };
    const { error } = updateSettingsForSource('userSettings', settingsUpdate);
    if (error) {
      setOAuthStatus({
        state: 'error',
        message: 'Failed to save settings. Please try again.',
        toRetry: buildRetryStatus(activeField),
      });
      return;
    }

    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearOpenAIClientCache();
    void removeChatGPTAuth().catch(() => {});
    setOAuthStatus({ state: 'success' });
    void onDone();
  };

  const handleTextSubmit = (): void => {
    if (activeField === 'max_context') {
      doSave();
      return;
    }
    advanceFrom(activeField);
  };

  const modelOptions =
    status.entryMode === 'catalog' ? status.models.map(item => ({ label: item.id, value: item.id })) : [];

  const renderField = (field: OpenAIModelField, label: string, optional = false): React.ReactNode => {
    const active = activeField === field;
    const value = getValue(field);
    const usesSelector = status.entryMode === 'catalog' && field !== 'max_context';
    const options = optional ? [{ label: '(not set)', value: '' }, ...modelOptions] : modelOptions;

    return (
      <Box key={field} flexDirection="column">
        <Box>
          <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
            {` ${label} `}
          </Text>
          {!active && <Text color={value ? 'success' : undefined}>{value || (optional ? '(not set)' : '')}</Text>}
        </Box>
        {active && usesSelector && (
          <Select
            key={`${field}:${value}`}
            options={options}
            defaultValue={value}
            defaultFocusValue={value || options[0]?.value}
            visibleOptionCount={9}
            onChange={selected => {
              setValue(field, selected);
              advanceFrom(field);
            }}
            onCancel={returnToEndpointSetup}
          />
        )}
        {active && !usesSelector && (
          <Box marginLeft={2}>
            <TextInput
              value={value}
              onChange={nextValue => setValue(field, nextValue)}
              onSubmit={handleTextSubmit}
              cursorOffset={inputCursorOffset}
              onChangeCursorOffset={setInputCursorOffset}
              columns={inputColumns}
              focus={true}
            />
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>OpenAI Compatible API Setup — Step 2 of 2</Text>
      {status.entryMode === 'manual' && (
        <Text color="warning">
          Could not fetch model list from the server ({status.fetchError}). Enter model names manually.
        </Text>
      )}
      <Box flexDirection="column" gap={1}>
        {renderField('model', 'Default model (required)')}
        {renderField('haiku_model', 'Haiku tier model (optional)', true)}
        {renderField('sonnet_model', 'Sonnet tier model (optional)', true)}
        {renderField('opus_model', 'Opus tier model (optional)', true)}
        {renderField('max_context', 'Max context tokens (context window size, e.g. 128000 or 128k)', true)}
      </Box>
      <Text dimColor>
        The default model handles requests unless a Haiku, Sonnet, or Opus tier override is configured. Maximum context
        tokens controls when automatic context compaction begins.
      </Text>
      <Text dimColor>
        {status.entryMode === 'catalog'
          ? 'Use ↑↓ and Enter to choose each model. Enter maximum context tokens to save. Esc returns to Step 1.'
          : 'Enter moves to the next field. Enter on maximum context tokens saves. Esc returns to Step 1.'}
      </Text>
    </Box>
  );
}

type ChatGPTSubscriptionSetupProps = {
  status: Extract<OAuthStatus, { state: 'chatgpt_subscription' }>;
  setOAuthStatus: (status: OAuthStatus) => void;
  onDone: () => void;
};

function ChatGPTSubscriptionSetup({ status, setOAuthStatus, onDone }: ChatGPTSubscriptionSetupProps): React.ReactNode {
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
        // Drop any cached OpenAI client built from prior OpenAI Compatible
        // env vars; the ChatGPT Subscription path bypasses the SDK client
        // entirely (uses createChatGPTResponsesStream) but a stale cached
        // client would still be picked up by sideQuery.
        clearOpenAIClientCache();
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
  }, [setOAuthStatus, onDone]);

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
  setOAuthStatus: (status: OAuthStatus) => void;
  onDone: () => void;
};

function AntigravityOAuthSetup({ status, setOAuthStatus, onDone }: AntigravityOAuthSetupProps): React.ReactNode {
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
  }, [setOAuthStatus, onDone]);

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
  setLoginWithClaudeAi,
  onDone,
}: OAuthStatusMessageProps): React.ReactNode {
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
                      OpenAI Compatible · <Text dimColor>Ollama, DeepSeek, vLLM, One API, etc.</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: 'openai_chat_api',
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
                  setOAuthStatus({
                    state: 'custom_platform',
                    baseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
                    apiKey: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
                    model: process.env.ANTHROPIC_MODEL ?? '',
                    maxContext: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '',
                    haikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
                    sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
                    opusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
                    activeField: 'base_url',
                  });
                } else if (value === 'openai_chat_api') {
                  logEvent('tengu_openai_chat_api_selected', {});
                  setOAuthStatus({
                    state: 'openai_endpoint_setup',
                    phase: 'editing',
                    baseUrl: process.env.OPENAI_BASE_URL ?? '',
                    apiKey: process.env.OPENAI_API_KEY ?? '',
                    wireApi: normalizeOpenAIWireApi(process.env.OPENAI_WIRE_API),
                    activeField: 'base_url',
                  });
                } else if (value === 'china_providers') {
                  logEvent('tengu_china_providers_selected', {});
                  setOAuthStatus({ state: 'china_provider_select', activeIndex: 0 });
                } else if (value === 'chatgpt_subscription') {
                  logEvent('tengu_chatgpt_subscription_selected', {});
                  setOAuthStatus({
                    state: 'chatgpt_subscription',
                    phase: 'requesting',
                  });
                } else if (value === 'gemini_api') {
                  logEvent('tengu_gemini_api_selected', {});
                  setOAuthStatus({
                    state: 'gemini_api',
                    baseUrl: process.env.GEMINI_BASE_URL ?? '',
                    apiKey: process.env.GEMINI_API_KEY ?? '',
                    model: process.env.GEMINI_MODEL ?? '',
                    maxContext: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '',
                    haikuModel: process.env.GEMINI_DEFAULT_HAIKU_MODEL ?? '',
                    sonnetModel: process.env.GEMINI_DEFAULT_SONNET_MODEL ?? '',
                    opusModel: process.env.GEMINI_DEFAULT_OPUS_MODEL ?? '',
                    activeField: 'base_url',
                  });
                } else if (value === 'antigravity_oauth') {
                  logEvent('tengu_antigravity_oauth_selected', {});
                  setOAuthStatus({ state: 'antigravity_oauth', phase: 'starting' });
                } else if (value === 'grok_api') {
                  logEvent('tengu_grok_api_selected', {});
                  setOAuthStatus({
                    state: 'grok_api',
                    baseUrl: process.env.GROK_BASE_URL ?? '',
                    apiKey: process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? '',
                    model: process.env.GROK_MODEL ?? '',
                    maxContext: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '',
                    activeField: 'base_url',
                  });
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

    case 'custom_platform': {
      type Field = 'base_url' | 'api_key' | 'model' | 'max_context' | 'haiku_model' | 'sonnet_model' | 'opus_model';
      const FIELDS: Field[] = [
        'base_url',
        'api_key',
        'model',
        'max_context',
        'haiku_model',
        'sonnet_model',
        'opus_model',
      ];
      const cp = oauthStatus as {
        state: 'custom_platform';
        activeField: Field;
        baseUrl: string;
        apiKey: string;
        model: string;
        maxContext: string;
        haikuModel: string;
        sonnetModel: string;
        opusModel: string;
      };
      const { activeField, baseUrl, apiKey, model, maxContext, haikuModel, sonnetModel, opusModel } = cp;
      const displayValues: Record<Field, string> = {
        base_url: baseUrl,
        api_key: apiKey,
        model,
        max_context: maxContext,
        haiku_model: haikuModel,
        sonnet_model: sonnetModel,
        opus_model: opusModel,
      };

      const [inputValue, setInputValue] = useState(() => displayValues[activeField]);
      const [inputCursorOffset, setInputCursorOffset] = useState(() => displayValues[activeField].length);

      const buildState = useCallback(
        (field: Field, value: string, newActive?: Field) => {
          const s = {
            state: 'custom_platform' as const,
            activeField: newActive ?? activeField,
            baseUrl,
            apiKey,
            model,
            maxContext,
            haikuModel,
            sonnetModel,
            opusModel,
          };
          switch (field) {
            case 'base_url':
              return { ...s, baseUrl: value };
            case 'api_key':
              return { ...s, apiKey: value };
            case 'model':
              return { ...s, model: value };
            case 'max_context':
              return { ...s, maxContext: value };
            case 'haiku_model':
              return { ...s, haikuModel: value };
            case 'sonnet_model':
              return { ...s, sonnetModel: value };
            case 'opus_model':
              return { ...s, opusModel: value };
          }
        },
        [activeField, baseUrl, apiKey, model, maxContext, haikuModel, sonnetModel, opusModel],
      );

      const _switchTo = useCallback(
        (target: Field) => {
          setOAuthStatus(buildState(activeField, inputValue, target));
          setInputValue(displayValues[target] ?? '');
          setInputCursorOffset((displayValues[target] ?? '').length);
        },
        [activeField, inputValue, displayValues, buildState, setOAuthStatus],
      );

      const doSave = useCallback(() => {
        const finalVals = { ...displayValues, [activeField]: inputValue };
        const toRetryState = {
          state: 'custom_platform' as const,
          baseUrl: finalVals.base_url ?? '',
          apiKey: finalVals.api_key ?? '',
          model: finalVals.model ?? '',
          maxContext: finalVals.max_context ?? '',
          haikuModel: finalVals.haiku_model ?? '',
          sonnetModel: finalVals.sonnet_model ?? '',
          opusModel: finalVals.opus_model ?? '',
          activeField: 'base_url' as const,
        };
        const env: Record<string, string> = {};

        // Validate base_url if provided
        if (finalVals.base_url) {
          try {
            new URL(finalVals.base_url);
          } catch {
            setOAuthStatus({
              state: 'error',
              message: 'Invalid base URL: please enter a full URL including protocol (e.g., https://api.example.com)',
              toRetry: toRetryState,
            });
            return;
          }
          env.ANTHROPIC_BASE_URL = finalVals.base_url;
        }

        const maxContextValue = parseMaxContextInput(finalVals.max_context ?? '');
        if (maxContextValue === null) {
          setOAuthStatus({
            state: 'error',
            message: 'Invalid max context: enter a token count like 128000 (or 128k / 1m), or leave it empty.',
            toRetry: { ...toRetryState, activeField: 'max_context' },
          });
          return;
        }

        if (finalVals.api_key) env.ANTHROPIC_AUTH_TOKEN = finalVals.api_key;
        if (finalVals.model) env.ANTHROPIC_MODEL = finalVals.model;
        if (maxContextValue) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextValue;
        if (finalVals.haiku_model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = finalVals.haiku_model;
        if (finalVals.sonnet_model) env.ANTHROPIC_DEFAULT_SONNET_MODEL = finalVals.sonnet_model;
        if (finalVals.opus_model) env.ANTHROPIC_DEFAULT_OPUS_MODEL = finalVals.opus_model;
        const { error } = updateSettingsForSource('userSettings', {
          modelType: 'anthropic',
          env,
        } as unknown as Parameters<typeof updateSettingsForSource>[1]);
        if (error) {
          setOAuthStatus({
            state: 'error',
            message: 'Failed to save settings. Please try again.',
            toRetry: toRetryState,
          });
        } else {
          for (const [k, v] of Object.entries(env)) process.env[k] = v;
          setOAuthStatus({ state: 'success' });
          void onDone();
        }
      }, [activeField, inputValue, displayValues, setOAuthStatus, onDone]);

      const handleEnter = useCallback(() => {
        const idx = FIELDS.indexOf(activeField);
        if (idx === FIELDS.length - 1) {
          setOAuthStatus(buildState(activeField, inputValue));
          doSave();
        } else {
          const next = FIELDS[idx + 1]!;
          setOAuthStatus(buildState(activeField, inputValue, next));
          setInputValue(displayValues[next] ?? '');
          setInputCursorOffset((displayValues[next] ?? '').length);
        }
      }, [activeField, inputValue, buildState, doSave, displayValues, setOAuthStatus]);

      useKeybinding(
        'tabs:next',
        () => {
          const idx = FIELDS.indexOf(activeField);
          if (idx < FIELDS.length - 1) {
            setOAuthStatus(buildState(activeField, inputValue, FIELDS[idx + 1]));
            setInputValue(displayValues[FIELDS[idx + 1]!] ?? '');
            setInputCursorOffset((displayValues[FIELDS[idx + 1]!] ?? '').length);
          }
        },
        { context: 'FormField' },
      );
      useKeybinding(
        'tabs:previous',
        () => {
          const idx = FIELDS.indexOf(activeField);
          if (idx > 0) {
            setOAuthStatus(buildState(activeField, inputValue, FIELDS[idx - 1]));
            setInputValue(displayValues[FIELDS[idx - 1]!] ?? '');
            setInputCursorOffset((displayValues[FIELDS[idx - 1]!] ?? '').length);
          }
        },
        { context: 'FormField' },
      );
      useKeybinding(
        'confirm:no',
        () => {
          setOAuthStatus({ state: 'idle' });
        },
        { context: 'Confirmation' },
      );

      const columns = useTerminalSize().columns - 20;

      const renderRow = (field: Field, label: string, opts?: { mask?: boolean; placeholder?: string }) => {
        const active = activeField === field;
        const val = displayValues[field];
        return (
          <Box>
            <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
              {` ${label} `}
            </Text>
            <Text> </Text>
            {active ? (
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleEnter}
                cursorOffset={inputCursorOffset}
                onChangeCursorOffset={setInputCursorOffset}
                columns={columns}
                mask={opts?.mask ? '*' : undefined}
                focus={true}
              />
            ) : val ? (
              <Text color="success">
                {opts?.mask ? val.slice(0, 8) + '\u00b7'.repeat(Math.max(0, val.length - 8)) : val}
              </Text>
            ) : null}
          </Box>
        );
      };

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Anthropic Compatible Setup</Text>
          <Box flexDirection="column" gap={1}>
            {renderRow('base_url', 'Base URL    ')}
            {renderRow('api_key', 'API Key     ', { mask: true })}
            {renderRow('model', 'Model       ')}
            {renderRow('max_context', 'Max context ')}
            {renderRow('haiku_model', 'Haiku       ')}
            {renderRow('sonnet_model', 'Sonnet      ')}
            {renderRow('opus_model', 'Opus        ')}
          </Box>
          <Text dimColor>
            Model and Max context are optional · Max context tokens caps the context window (e.g. 128000 or 128k)
          </Text>
          <Text dimColor>↑↓/Tab to switch · Enter on last field to save · Esc to go back</Text>
        </Box>
      );
    }

    case 'openai_endpoint_setup':
      return <OpenAIEndpointSetup status={oauthStatus} setOAuthStatus={setOAuthStatus} />;

    case 'openai_model_setup':
      return <OpenAIModelSetup status={oauthStatus} setOAuthStatus={setOAuthStatus} onDone={onDone} />;

    case 'chatgpt_subscription':
      return <ChatGPTSubscriptionSetup status={oauthStatus} setOAuthStatus={setOAuthStatus} onDone={onDone} />;

    case 'gemini_api': {
      type GeminiField =
        | 'base_url'
        | 'api_key'
        | 'model'
        | 'max_context'
        | 'haiku_model'
        | 'sonnet_model'
        | 'opus_model';
      const GEMINI_FIELDS: GeminiField[] = [
        'base_url',
        'api_key',
        'model',
        'max_context',
        'haiku_model',
        'sonnet_model',
        'opus_model',
      ];
      const gp = oauthStatus as {
        state: 'gemini_api';
        activeField: GeminiField;
        baseUrl: string;
        apiKey: string;
        model: string;
        maxContext: string;
        haikuModel: string;
        sonnetModel: string;
        opusModel: string;
      };
      const { activeField, baseUrl, apiKey, model, maxContext, haikuModel, sonnetModel, opusModel } = gp;
      const geminiDisplayValues: Record<GeminiField, string> = {
        base_url: baseUrl,
        api_key: apiKey,
        model,
        max_context: maxContext,
        haiku_model: haikuModel,
        sonnet_model: sonnetModel,
        opus_model: opusModel,
      };

      const [geminiInputValue, setGeminiInputValue] = useState(() => geminiDisplayValues[activeField]);
      const [geminiInputCursorOffset, setGeminiInputCursorOffset] = useState(
        () => geminiDisplayValues[activeField].length,
      );

      const buildGeminiState = useCallback(
        (field: GeminiField, value: string, newActive?: GeminiField) => {
          const s = {
            state: 'gemini_api' as const,
            activeField: newActive ?? activeField,
            baseUrl,
            apiKey,
            model,
            maxContext,
            haikuModel,
            sonnetModel,
            opusModel,
          };
          switch (field) {
            case 'base_url':
              return { ...s, baseUrl: value };
            case 'api_key':
              return { ...s, apiKey: value };
            case 'model':
              return { ...s, model: value };
            case 'max_context':
              return { ...s, maxContext: value };
            case 'haiku_model':
              return { ...s, haikuModel: value };
            case 'sonnet_model':
              return { ...s, sonnetModel: value };
            case 'opus_model':
              return { ...s, opusModel: value };
          }
        },
        [activeField, baseUrl, apiKey, model, maxContext, haikuModel, sonnetModel, opusModel],
      );

      const doGeminiSave = useCallback(() => {
        const finalVals = { ...geminiDisplayValues, [activeField]: geminiInputValue };
        const toRetryState = {
          state: 'gemini_api' as const,
          baseUrl: finalVals.base_url,
          apiKey: finalVals.api_key,
          model: finalVals.model,
          maxContext: finalVals.max_context,
          haikuModel: finalVals.haiku_model,
          sonnetModel: finalVals.sonnet_model,
          opusModel: finalVals.opus_model,
          activeField,
        };
        // Gemini has no built-in family defaults (the mapping throws on a miss),
        // so either a single Model or all three tier slots must be provided.
        if (!finalVals.model && (!finalVals.haiku_model || !finalVals.sonnet_model || !finalVals.opus_model)) {
          setOAuthStatus({
            state: 'error',
            message: 'Gemini setup requires a Model, or all of Haiku, Sonnet, and Opus model names.',
            toRetry: toRetryState,
          });
          return;
        }

        const maxContextValue = parseMaxContextInput(finalVals.max_context ?? '');
        if (maxContextValue === null) {
          setOAuthStatus({
            state: 'error',
            message: 'Invalid max context: enter a token count like 128000 (or 128k / 1m), or leave it empty.',
            toRetry: { ...toRetryState, activeField: 'max_context' },
          });
          return;
        }

        const env: Record<string, string> = {};
        if (finalVals.base_url) env.GEMINI_BASE_URL = finalVals.base_url;
        if (finalVals.api_key) env.GEMINI_API_KEY = finalVals.api_key;
        if (finalVals.model) env.GEMINI_MODEL = finalVals.model;
        if (maxContextValue) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextValue;
        if (finalVals.haiku_model) env.GEMINI_DEFAULT_HAIKU_MODEL = finalVals.haiku_model;
        if (finalVals.sonnet_model) env.GEMINI_DEFAULT_SONNET_MODEL = finalVals.sonnet_model;
        if (finalVals.opus_model) env.GEMINI_DEFAULT_OPUS_MODEL = finalVals.opus_model;
        const { error } = updateSettingsForSource('userSettings', {
          modelType: 'gemini',
          env,
        } as unknown as Parameters<typeof updateSettingsForSource>[1]);
        if (error) {
          setOAuthStatus({
            state: 'error',
            message: `Failed to save: ${error.message}`,
            toRetry: toRetryState,
          });
        } else {
          for (const [k, v] of Object.entries(env)) process.env[k] = v;
          setOAuthStatus({ state: 'success' });
          void onDone();
        }
      }, [activeField, geminiInputValue, geminiDisplayValues, onDone, setOAuthStatus]);

      const handleGeminiEnter = useCallback(() => {
        const idx = GEMINI_FIELDS.indexOf(activeField);
        if (idx === GEMINI_FIELDS.length - 1) {
          setOAuthStatus(buildGeminiState(activeField, geminiInputValue));
          doGeminiSave();
        } else {
          const next = GEMINI_FIELDS[idx + 1]!;
          setOAuthStatus(buildGeminiState(activeField, geminiInputValue, next));
          setGeminiInputValue(geminiDisplayValues[next] ?? '');
          setGeminiInputCursorOffset((geminiDisplayValues[next] ?? '').length);
        }
      }, [activeField, buildGeminiState, doGeminiSave, geminiDisplayValues, geminiInputValue, setOAuthStatus]);

      useKeybinding(
        'tabs:next',
        () => {
          const idx = GEMINI_FIELDS.indexOf(activeField);
          if (idx < GEMINI_FIELDS.length - 1) {
            setOAuthStatus(buildGeminiState(activeField, geminiInputValue, GEMINI_FIELDS[idx + 1]));
            setGeminiInputValue(geminiDisplayValues[GEMINI_FIELDS[idx + 1]!] ?? '');
            setGeminiInputCursorOffset((geminiDisplayValues[GEMINI_FIELDS[idx + 1]!] ?? '').length);
          }
        },
        { context: 'FormField' },
      );
      useKeybinding(
        'tabs:previous',
        () => {
          const idx = GEMINI_FIELDS.indexOf(activeField);
          if (idx > 0) {
            setOAuthStatus(buildGeminiState(activeField, geminiInputValue, GEMINI_FIELDS[idx - 1]));
            setGeminiInputValue(geminiDisplayValues[GEMINI_FIELDS[idx - 1]!] ?? '');
            setGeminiInputCursorOffset((geminiDisplayValues[GEMINI_FIELDS[idx - 1]!] ?? '').length);
          }
        },
        { context: 'FormField' },
      );
      useKeybinding(
        'confirm:no',
        () => {
          setOAuthStatus({ state: 'idle' });
        },
        { context: 'Confirmation' },
      );

      const geminiColumns = useTerminalSize().columns - 20;

      const renderGeminiRow = (field: GeminiField, label: string, opts?: { mask?: boolean }) => {
        const active = activeField === field;
        const val = geminiDisplayValues[field];
        return (
          <Box>
            <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
              {` ${label} `}
            </Text>
            <Text> </Text>
            {active ? (
              <TextInput
                value={geminiInputValue}
                onChange={setGeminiInputValue}
                onSubmit={handleGeminiEnter}
                cursorOffset={geminiInputCursorOffset}
                onChangeCursorOffset={setGeminiInputCursorOffset}
                columns={geminiColumns}
                mask={opts?.mask ? '*' : undefined}
                focus={true}
              />
            ) : val ? (
              <Text color="success">
                {opts?.mask ? val.slice(0, 8) + '\u00b7'.repeat(Math.max(0, val.length - 8)) : val}
              </Text>
            ) : null}
          </Box>
        );
      };

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Gemini API Setup</Text>
          <Text dimColor>
            Configure a Gemini Generate Content compatible endpoint. Base URL is optional and defaults to Google&apos;s
            v1beta API.
          </Text>
          <Box flexDirection="column" gap={1}>
            {renderGeminiRow('base_url', 'Base URL    ')}
            {renderGeminiRow('api_key', 'API Key     ', { mask: true })}
            {renderGeminiRow('model', 'Model       ')}
            {renderGeminiRow('max_context', 'Max context ')}
            {renderGeminiRow('haiku_model', 'Haiku       ')}
            {renderGeminiRow('sonnet_model', 'Sonnet      ')}
            {renderGeminiRow('opus_model', 'Opus        ')}
          </Box>
          <Text dimColor>
            Model (e.g. gemini-3-pro) overrides all tiers · Max context tokens sets the context window (e.g. 1m)
          </Text>
          <Text dimColor>↑↓/Tab to switch · Enter on last field to save · Esc to go back</Text>
        </Box>
      );
    }

    case 'antigravity_oauth':
      return <AntigravityOAuthSetup status={oauthStatus} setOAuthStatus={setOAuthStatus} onDone={onDone} />;

    case 'grok_api': {
      type GrokField = 'base_url' | 'api_key' | 'model' | 'max_context';
      const GROK_FIELDS: GrokField[] = ['base_url', 'api_key', 'model', 'max_context'];
      const gk = oauthStatus as {
        state: 'grok_api';
        activeField: GrokField;
        baseUrl: string;
        apiKey: string;
        model: string;
        maxContext: string;
      };
      const { activeField, baseUrl, apiKey, model, maxContext } = gk;
      const grokDisplayValues: Record<GrokField, string> = {
        base_url: baseUrl,
        api_key: apiKey,
        model,
        max_context: maxContext,
      };

      const [grokInputValue, setGrokInputValue] = useState(() => grokDisplayValues[activeField]);
      const [grokInputCursorOffset, setGrokInputCursorOffset] = useState(() => grokDisplayValues[activeField].length);

      const buildGrokState = useCallback(
        (field: GrokField, value: string, newActive?: GrokField) => {
          const s = {
            state: 'grok_api' as const,
            activeField: newActive ?? activeField,
            baseUrl,
            apiKey,
            model,
            maxContext,
          };
          switch (field) {
            case 'base_url':
              return { ...s, baseUrl: value };
            case 'api_key':
              return { ...s, apiKey: value };
            case 'model':
              return { ...s, model: value };
            case 'max_context':
              return { ...s, maxContext: value };
          }
        },
        [activeField, baseUrl, apiKey, model, maxContext],
      );

      const doGrokSave = useCallback(() => {
        const finalVals = { ...grokDisplayValues, [activeField]: grokInputValue };
        const toRetryState = {
          state: 'grok_api' as const,
          baseUrl: finalVals.base_url,
          apiKey: finalVals.api_key,
          model: finalVals.model,
          maxContext: finalVals.max_context,
          activeField: 'base_url' as const,
        };

        if (finalVals.base_url) {
          try {
            new URL(finalVals.base_url);
          } catch {
            setOAuthStatus({
              state: 'error',
              message: 'Invalid base URL: please enter a full URL including protocol (default: https://api.x.ai/v1)',
              toRetry: toRetryState,
            });
            return;
          }
        }

        const maxContextValue = parseMaxContextInput(finalVals.max_context ?? '');
        if (maxContextValue === null) {
          setOAuthStatus({
            state: 'error',
            message: 'Invalid max context: enter a token count like 128000 (or 128k / 1m), or leave it empty.',
            toRetry: { ...toRetryState, activeField: 'max_context' },
          });
          return;
        }

        const env: Record<string, string | undefined> = {};
        if (finalVals.base_url) env.GROK_BASE_URL = finalVals.base_url;
        if (finalVals.api_key) env.GROK_API_KEY = finalVals.api_key;
        env.GROK_MODEL = finalVals.model || undefined;
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextValue;
        const { error } = updateSettingsForSource('userSettings', {
          modelType: 'grok',
          env: env as unknown as Record<string, string>,
        } as unknown as Parameters<typeof updateSettingsForSource>[1]);
        if (error) {
          setOAuthStatus({
            state: 'error',
            message: 'Failed to save settings. Please try again.',
            toRetry: toRetryState,
          });
        } else {
          for (const [k, v] of Object.entries(env)) {
            if (v === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = v;
            }
          }
          clearGrokClientCache();
          setOAuthStatus({ state: 'success' });
          void onDone();
        }
      }, [activeField, grokInputValue, grokDisplayValues, setOAuthStatus, onDone]);

      const handleGrokEnter = useCallback(() => {
        const idx = GROK_FIELDS.indexOf(activeField);
        if (idx === GROK_FIELDS.length - 1) {
          setOAuthStatus(buildGrokState(activeField, grokInputValue));
          doGrokSave();
        } else {
          const next = GROK_FIELDS[idx + 1]!;
          setOAuthStatus(buildGrokState(activeField, grokInputValue, next));
          setGrokInputValue(grokDisplayValues[next] ?? '');
          setGrokInputCursorOffset((grokDisplayValues[next] ?? '').length);
        }
      }, [activeField, grokInputValue, buildGrokState, doGrokSave, grokDisplayValues, setOAuthStatus]);

      useKeybinding(
        'tabs:next',
        () => {
          const idx = GROK_FIELDS.indexOf(activeField);
          if (idx < GROK_FIELDS.length - 1) {
            setOAuthStatus(buildGrokState(activeField, grokInputValue, GROK_FIELDS[idx + 1]));
            setGrokInputValue(grokDisplayValues[GROK_FIELDS[idx + 1]!] ?? '');
            setGrokInputCursorOffset((grokDisplayValues[GROK_FIELDS[idx + 1]!] ?? '').length);
          }
        },
        { context: 'FormField' },
      );
      useKeybinding(
        'tabs:previous',
        () => {
          const idx = GROK_FIELDS.indexOf(activeField);
          if (idx > 0) {
            setOAuthStatus(buildGrokState(activeField, grokInputValue, GROK_FIELDS[idx - 1]));
            setGrokInputValue(grokDisplayValues[GROK_FIELDS[idx - 1]!] ?? '');
            setGrokInputCursorOffset((grokDisplayValues[GROK_FIELDS[idx - 1]!] ?? '').length);
          }
        },
        { context: 'FormField' },
      );
      useKeybinding(
        'confirm:no',
        () => {
          setOAuthStatus({ state: 'idle' });
        },
        { context: 'Confirmation' },
      );

      const grokColumns = useTerminalSize().columns - 20;

      const renderGrokRow = (field: GrokField, label: string, opts?: { mask?: boolean }) => {
        const active = activeField === field;
        const val = grokDisplayValues[field];
        return (
          <Box>
            <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
              {` ${label} `}
            </Text>
            <Text> </Text>
            {active ? (
              <TextInput
                value={grokInputValue}
                onChange={setGrokInputValue}
                onSubmit={handleGrokEnter}
                cursorOffset={grokInputCursorOffset}
                onChangeCursorOffset={setGrokInputCursorOffset}
                columns={grokColumns}
                mask={opts?.mask ? '*' : undefined}
                focus={true}
              />
            ) : val ? (
              <Text color="success">
                {opts?.mask ? val.slice(0, 8) + '·'.repeat(Math.max(0, val.length - 8)) : val}
              </Text>
            ) : null}
          </Box>
        );
      };

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Grok API Setup</Text>
          <Text dimColor>Configure xAI Grok. Base URL defaults to https://api.x.ai/v1 when left empty.</Text>
          <Box flexDirection="column" gap={1}>
            {renderGrokRow('base_url', 'Base URL    ')}
            {renderGrokRow('api_key', 'API Key     ', { mask: true })}
            {renderGrokRow('model', 'Model       ')}
            {renderGrokRow('max_context', 'Max context ')}
          </Box>
          <Text dimColor>
            Model optional (family mapping applies when empty) · Max context tokens sets the context window (e.g. 256k)
          </Text>
          <Text dimColor>↑↓/Tab to switch · Enter on last field to save · Esc to go back</Text>
        </Box>
      );
    }

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
                  setOAuthStatus({ state: 'china_model_select', provider, mode: 'api', activeIndex: 0 });
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
                  state: 'china_model_select',
                  provider,
                  mode: value as 'api' | 'coding-plan',
                  activeIndex: 0,
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

    case 'china_model_select': {
      const { provider, mode: accessMode } = oauthStatus;
      const models = provider.models;
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>
            {provider.icon} {provider.label} — Select Model
          </Text>
          <Box>
            <Select
              options={[
                ...models.map(m => {
                  const priceLabel =
                    m.inputPricePerMTok === 0 && m.outputPricePerMTok === 0
                      ? 'Free'
                      : `¥${m.inputPricePerMTok}/¥${m.outputPricePerMTok}`;
                  const tagLabel = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
                  return {
                    label: (
                      <Text>
                        {m.label} ·{' '}
                        <Text dimColor>
                          {priceLabel} · {m.contextWindow}
                          {tagLabel}
                        </Text>
                        {'\n'}
                      </Text>
                    ),
                    value: m.id,
                  };
                }),
                {
                  label: (
                    <Text>
                      ✏️ Custom model
                      <Text dimColor> · enter model name manually</Text>
                      {'\n'}
                    </Text>
                  ),
                  value: '__custom__',
                },
              ]}
              onChange={value => {
                logEvent('tengu_china_model_selected', {});
                setOAuthStatus({ state: 'china_apikey', provider, mode: accessMode, modelId: value, apiKey: '' });
              }}
            />
          </Box>
        </Box>
      );
    }

    case 'china_apikey': {
      const { provider, mode: accessMode, modelId } = oauthStatus;

      const [chinaKeyValue, setChinaKeyValue] = useState('');
      const [chinaKeyCursor, setChinaKeyCursor] = useState(0);
      const [chinaKeyError, setChinaKeyError] = useState<string | null>(null);

      const doChinaSave = useCallback(() => {
        const effectiveModelId = modelId === '__custom__' ? chinaKeyValue.trim() : modelId;
        if (!effectiveModelId) {
          setChinaKeyError(modelId === '__custom__' ? 'Please enter a model name' : 'Please enter an API key');
          return;
        }
        if (modelId === '__custom__') {
          logEvent('tengu_china_custom_model_entered', {});
          setOAuthStatus({ state: 'china_apikey', provider, mode: accessMode, modelId: effectiveModelId, apiKey: '' });
          setChinaKeyValue('');
          setChinaKeyError(null);
          return;
        }
        if (!chinaKeyValue.trim()) {
          setChinaKeyError('Please enter an API key');
          return;
        }
        const baseUrl = resolveChinaProviderBaseURL(provider.id, accessMode);
        // Auto-derive the context window from the preset table so auto-compact
        // triggers at the model's real window instead of the 200k fallback.
        // Custom/unknown models clear the key (undefined deletes on merge) so a
        // stale limit from a previously selected model cannot linger.
        const presetModel = provider.models.find(m => m.id === modelId);
        const presetContextTokens = presetModel ? parseContextWindowTokens(presetModel.contextWindow) : undefined;
        const env: Record<string, string | undefined> = {
          OPENAI_AUTH_MODE: undefined,
          OPENAI_BASE_URL: baseUrl,
          OPENAI_API_KEY: chinaKeyValue.trim(),
          OPENAI_DEFAULT_SONNET_MODEL: modelId,
          OPENAI_DEFAULT_HAIKU_MODEL: modelId,
          OPENAI_DEFAULT_OPUS_MODEL: modelId,
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: presetContextTokens ? String(presetContextTokens) : undefined,
        };
        const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
          modelType: 'openai',
          env: env as unknown as Record<string, string>,
        };
        const { error } = updateSettingsForSource('userSettings', settingsUpdate);
        if (error) {
          setOAuthStatus({
            state: 'error',
            message: 'Failed to save settings. Please try again.',
            toRetry: { state: 'china_apikey', provider, mode: accessMode, modelId, apiKey: chinaKeyValue },
          });
        } else {
          for (const [k, v] of Object.entries(env)) {
            if (v === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = v;
            }
          }
          // Drop any cached OpenAI client and ChatGPT auth so the new
          // provider/credentials take effect on the next request.
          clearOpenAIClientCache();
          void removeChatGPTAuth().catch(() => {});
          logEvent('tengu_china_login_success', {});
          setOAuthStatus({ state: 'success' });
          void onDone();
        }
      }, [chinaKeyValue, provider, accessMode, modelId, onDone, setOAuthStatus]);

      useKeybinding(
        'confirm:no',
        () => {
          setOAuthStatus({ state: 'china_model_select', provider, mode: accessMode, activeIndex: 0 });
        },
        { context: 'Confirmation' },
      );

      const isCustomModelEntry = modelId === '__custom__';
      const allModels = CHINA_LLM_PROVIDERS.flatMap(p =>
        p.models.map(m => ({ id: m.id, label: m.label, provider: p.label })),
      );
      const modelSuggestions = isCustomModelEntry
        ? chinaKeyValue.trim()
          ? allModels.filter(m => m.id.toLowerCase().includes(chinaKeyValue.trim().toLowerCase()))
          : allModels
        : [];
      const keyPage = isCustomModelEntry
        ? provider.apiKeyPage
        : accessMode === 'coding-plan' && provider.codingPlan
          ? provider.codingPlan.purchasePage
          : provider.apiKeyPage;
      const keyFormat = isCustomModelEntry
        ? provider.keyFormat
        : accessMode === 'coding-plan' && provider.codingPlan
          ? provider.codingPlan.keyFormat
          : provider.keyFormat;

      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>
            {provider.icon} {provider.label} {isCustomModelEntry ? '— Custom Model' : 'API Key'}
          </Text>
          <Box flexDirection="column" gap={0}>
            {isCustomModelEntry ? (
              <Text dimColor> Enter any model ID supported by this provider. Browse models: {provider.modelsPage}</Text>
            ) : (
              <>
                <Text dimColor> Get your key: {keyPage}</Text>
                <Text dimColor>
                  {' '}
                  {accessMode === 'coding-plan' ? 'Use your Coding Plan credential here' : provider.freeTier}
                </Text>
                <Text dimColor> Key format: {keyFormat}</Text>
              </>
            )}
          </Box>
          <Box>
            <Text>{isCustomModelEntry ? 'Model name: ' : 'API Key: '}</Text>
            <TextInput
              value={chinaKeyValue}
              onChange={v => {
                setChinaKeyValue(v);
                setChinaKeyError(null);
              }}
              onSubmit={doChinaSave}
              cursorOffset={chinaKeyCursor}
              onChangeCursorOffset={setChinaKeyCursor}
              columns={useTerminalSize().columns - 12}
              mask={isCustomModelEntry ? undefined : '*'}
              focus={true}
            />
          </Box>
          {chinaKeyError ? <Text color="error">{chinaKeyError}</Text> : null}
          {isCustomModelEntry && modelSuggestions.length > 0 && (
            <Box flexDirection="column" gap={0}>
              <Text dimColor>{chinaKeyValue.trim() ? 'Matching models:' : 'Known models:'}</Text>
              {modelSuggestions.map(m => (
                <Text key={m.id} dimColor>
                  {' '}
                  {m.id}{' '}
                  <Text>
                    ({m.label} — {m.provider})
                  </Text>
                </Text>
              ))}
            </Box>
          )}
          <Text dimColor>
            {isCustomModelEntry ? 'Enter to continue · Esc to go back' : 'Enter to confirm · Esc to go back'}
          </Text>
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
