import * as React from 'react';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry is loaded lazily to avoid pulling in ~1.1MB of OpenTelemetry at startup
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { removeChatGPTAuth } from '../../services/api/openai/chatgptAuth.js';
import { removeAntigravityAuth } from '../../services/auth/antigravity/oauth.js';
import { clearOpenAIClientCache } from '../../services/api/openai/client.js';
import { clearGrokClientCache } from '../../services/api/grok/client.js';
import { resetProviderConfiguration } from './resetProviderConfig.js';
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth/auth.js';
import { clearBetasCaches } from '../../utils/model/betas.js';
import { saveGlobalConfig } from '../../utils/config/config.js';
import { gracefulShutdownSync } from '../../utils/process/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { clearToolSchemaCache } from '../../utils/tools/toolSchemaCache.js';
import { resetUserCache } from '../../utils/auth/user.js';

export async function performLogout({
  clearOnboarding = false,
  /**
   * Wipe provider configuration too (default). `installOAuthTokens` passes
   * false: there, logout only clears *stale* state ahead of a fresh login, and
   * dropping the user's endpoint config as a side effect of logging in would be
   * a surprise.
   */
  resetProviderConfig = true,
}: {
  clearOnboarding?: boolean;
  resetProviderConfig?: boolean;
}): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();

  await removeApiKey();
  await removeChatGPTAuth();
  await removeAntigravityAuth();
  if (resetProviderConfig) {
    resetProviderConfiguration();
  } else {
    clearChatGPTSettingsAuthMode();
    clearAntigravitySettingsAuthMode();
  }
  // Cached SDK clients hold the pre-logout auth — drop them so the next
  // request rebuilds from current env.
  clearOpenAIClientCache();
  clearGrokClientCache();

  // Wipe all secure storage data on logout
  const secureStorage = getSecureStorage();
  secureStorage.delete();

  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = { ...current };
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false;
      updated.subscriptionNoticeCount = 0;
      updated.hasAvailableSubscription = false;
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        };
      }
    }
    updated.oauthAccount = undefined;
    return updated;
  });
}

function clearChatGPTSettingsAuthMode(): void {
  delete process.env.OPENAI_AUTH_MODE;
  const userSettings = getSettingsForSource('userSettings') ?? {};
  const env = userSettings.env ?? {};
  const hasOpenAICompatibleConfig =
    Boolean(env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY) &&
    Boolean(env.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL);
  const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
    ...(userSettings.modelType === 'openai' && !hasOpenAICompatibleConfig ? { modelType: undefined } : {}),
    env: {
      OPENAI_AUTH_MODE: undefined,
    } as unknown as Record<string, string>,
  };
  updateSettingsForSource('userSettings', settingsUpdate);
}

/**
 * Mirror of clearChatGPTSettingsAuthMode for Antigravity: drop the auth-mode
 * switch, and only surrender modelType when no API-key Gemini setup remains to
 * fall back on — a user with GEMINI_API_KEY configured stays on Gemini.
 */
function clearAntigravitySettingsAuthMode(): void {
  delete process.env.GEMINI_AUTH_MODE;
  const userSettings = getSettingsForSource('userSettings') ?? {};
  const env = userSettings.env ?? {};
  const hasGeminiApiKeyConfig = Boolean(env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY);
  const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
    ...(userSettings.modelType === 'gemini' && !hasGeminiApiKeyConfig ? { modelType: undefined } : {}),
    env: {
      GEMINI_AUTH_MODE: undefined,
    } as unknown as Record<string, string>,
  };
  updateSettingsForSource('userSettings', settingsUpdate);
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  // Clear the OAuth token cache
  getClaudeAIOAuthTokens.cache?.clear?.();
  clearBetasCaches();
  clearToolSchemaCache();

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache();
  refreshGrowthBookAfterAuthChange();

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache();

  // Clear policy limits cache
  await clearPolicyLimitsCache();
}

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true });

  const message = <Text>Successfully logged out.</Text>;

  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);

  return message;
}
