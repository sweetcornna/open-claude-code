import * as React from 'react';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { clearGrokClientCache } from '../../services/api/grok/client.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { removeChatGPTAuth } from '../../services/api/openai/chatgptAuth.js';
import { clearOpenAIClientCache } from '../../services/api/openai/client.js';
import { removeAntigravityAuth } from '../../services/auth/antigravity/oauth.js';
import { removeOpencodeAuth } from '../../services/auth/opencode/oauth.js';
import { resetOpencodeCredentialCache } from '../../services/api/opencodeCredential.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry is loaded lazily to avoid pulling in ~1.1MB of OpenTelemetry at startup
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { getClaudeAIOAuthTokens, removeApiKey, removeClaudeAIOAuthTokens } from '../../utils/auth/auth.js';
import { clearBetasCaches } from '../../utils/model/betas.js';
import { applyDeepSeekAnthropicWire } from '../../utils/model/deepseekWire.js';
import { saveGlobalConfig } from '../../utils/config/config.js';
import { gracefulShutdownSync } from '../../utils/process/gracefulShutdown.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { clearToolSchemaCache } from '../../utils/tools/toolSchemaCache.js';
import { resetUserCache } from '../../utils/auth/user.js';
import { resetProviderConfiguration } from './resetProviderConfig.js';

const ANTHROPIC_CREDENTIAL_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * Log out of the account, whatever "the account" happens to be.
 *
 * Logout resets the whole account plane, not just Claude OAuth: third-party
 * endpoints and keys were once kept on the theory that they are "configuration,
 * not login state", which made `/logout` a no-op for anyone not on Claude OAuth
 * — the next launch went straight back out to the same endpoint with the same
 * key. Worse, the surviving `OPENAI_*` keys are re-applied into process.env at
 * startup, `isAnthropicAuthEnabled()` then reports a third-party session, and
 * the onboarding wizard drops its login step entirely: logged out, and no way
 * left to log back in.
 *
 * What survives on purpose: MCP OAuth tokens and plugin secrets (separate
 * credential families inside the same secure-storage record — only
 * `claudeAiOauth` is removed), saved `/provider` profiles (only the *active*
 * pointer is dropped), and everything account-independent (MCP servers, hooks,
 * themes, web-search source overrides).
 */
export async function performLogout({ clearOnboarding = false }: { clearOnboarding?: boolean }): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();

  await removeApiKey();
  const oauthRemoval = removeClaudeAIOAuthTokens();
  if (!oauthRemoval.success) {
    throw new Error(oauthRemoval.warning ?? 'Failed to remove Anthropic OAuth credentials');
  }
  await removeChatGPTAuth();
  await removeAntigravityAuth();
  // The OpenCode credential is a file, not an env var, so resetProviderConfiguration()
  // below cannot reach it — clearing OPENCODE_* out of settings would leave a refresh
  // token on disk that mints a working access token for the account just logged out of.
  await removeOpencodeAuth();
  clearAnthropicCredentialSettings();
  resetProviderConfiguration();
  // Cached SDK clients hold the pre-logout auth — drop them so the next
  // request rebuilds from current env.
  clearOpenAIClientCache();
  clearGrokClientCache();
  // Release the DeepSeek mirror's claim on the ANTHROPIC_* keys. The mirror
  // keeps in-memory bookkeeping (`mirroredKeys`), so clearing the env alone
  // leaves it still believing it owns values it no longer wrote — and the
  // mirrored-key predicates would keep vouching for a credential belonging to
  // the session that just logged out. Runs AFTER the resets: with OPENAI_* gone
  // there is nothing left to mirror, so this is a pure release.
  applyDeepSeekAnthropicWire();
  // Same release for the OpenCode mirror, plus the in-memory bearer token it
  // publishes — that one is held outside process.env, so clearing settings and
  // env leaves the logged-out account's token still being mirrored onto
  // ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY on the next apply.
  resetOpencodeCredentialCache();

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
      if (updated.customApiKeyResponses) {
        // `rejected` goes too, not just `approved`. Nothing else in the CLI can
        // clear that list, and a key on it is refused forever: the "Detected a
        // custom API key" dialog only appears for status 'new', so a single
        // rejection (or one cancelled dialog — cancel counts as No) permanently
        // locks the user out of ever approving that key again.
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
          rejected: [],
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
