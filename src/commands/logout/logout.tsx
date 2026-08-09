import * as React from 'react';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry is loaded lazily to avoid pulling in ~1.1MB of OpenTelemetry at startup
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { getClaudeAIOAuthTokens, removeApiKey, removeClaudeAIOAuthTokens } from '../../utils/auth/auth.js';
import { clearBetasCaches } from '../../utils/model/betas.js';
import { saveGlobalConfig } from '../../utils/config/config.js';
import { gracefulShutdownSync } from '../../utils/process/gracefulShutdown.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { clearToolSchemaCache } from '../../utils/tools/toolSchemaCache.js';
import { resetUserCache } from '../../utils/auth/user.js';

const ANTHROPIC_CREDENTIAL_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export async function performLogout({ clearOnboarding = false }: { clearOnboarding?: boolean }): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();

  await removeApiKey();
  const oauthRemoval = removeClaudeAIOAuthTokens();
  if (!oauthRemoval.success) {
    throw new Error(oauthRemoval.warning ?? 'Failed to remove Anthropic OAuth credentials');
  }
  clearAnthropicCredentialSettings();

  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = { ...current };
    if (updated.env) {
      updated.env = { ...updated.env };
      for (const key of ANTHROPIC_CREDENTIAL_ENV_KEYS) {
        delete updated.env[key];
      }
    }
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

function clearAnthropicCredentialSettings(): void {
  const env = Object.fromEntries(ANTHROPIC_CREDENTIAL_ENV_KEYS.map(key => [key, undefined]));
  const { error } = updateSettingsForSource('userSettings', {
    env,
  } as unknown as Parameters<typeof updateSettingsForSource>[1]);
  if (error) {
    throw new Error('Failed to remove Anthropic credentials from settings', {
      cause: error,
    });
  }
  for (const key of ANTHROPIC_CREDENTIAL_ENV_KEYS) {
    delete process.env[key];
  }
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
