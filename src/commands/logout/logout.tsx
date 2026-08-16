import { feature } from 'bun:bundle';
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
import { listSearchOAuthCopies } from '../../services/search/oauthCopies.js';
import { listPinnedSearchSources } from '../../services/search/searchCredentialStore.js';
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
 *
 * Credentials PINNED for web search survive too — both kinds: the API keys in
 * services/search/searchCredentialStore.ts, and the COPIES of the ChatGPT and
 * Google login files in services/search/oauthCopies.ts. That is a deliberate
 * answer rather than an oversight. A pinned credential is the user having said
 * "this one is for search"; it is not the session's login, and this account
 * plane never wrote it. Removing it here is also unnecessary: pinning is per
 * source and can be switched off, whereas a logout that silently revoked it
 * would recreate the exact failure the store was built to end (search quietly
 * degrading to the keyless lane with nothing said).
 *
 * The copies are not a hole in the logout above. `removeChatGPTAuth()` and
 * `removeAntigravityAuth()` still delete the login files, so nothing the
 * provider plane authenticates with is left: the search planes are separate
 * read paths (`getValidChatGPTAuthForSearch`, the Antigravity `'search'`
 * plane) that the main loop cannot reach, and a token refreshed through one
 * of them is written back to the copy, never to the file just deleted.
 *
 * What logout must not do is stay quiet about it, so `call()` below names every
 * source that kept a credential and says how to remove it.
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
    // `cachedGrowthBookFeatures` goes with the account that fetched it.
    // clearAuthRelatedCaches() above resets only the in-memory map, which is
    // how a signed-out install kept answering feature gates from the previous
    // account's Anthropic experiment assignment — across restarts, with no way
    // for the user to see it or clear it. Statsig's cache is the same payload
    // by an older name and is read by the same gate helpers.
    // `undefined` rather than a destructuring delete: saveGlobalConfig's test
    // path Object.assign()s the result onto the existing object, where a
    // removed key is simply not seen. Serialising drops it either way.
    const updated = {
      ...current,
      cachedGrowthBookFeatures: undefined,
      cachedStatsigGates: {},
    };
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
  if (feature('BRIDGE_MODE')) {
    const { clearTrustedDeviceTokenCache } = await import('../../bridge/trustedDevice.js');
    clearTrustedDeviceTokenCache();
  }
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

  // Read AFTER the logout: what is listed here is what genuinely survived it,
  // not what happened to be there beforehand. Both stores, because both kinds
  // of pinned credential outlive this — a source whose copied OAuth login is
  // still serving searches has to be named for the same reason a pinned key
  // does, and it is the one a user would least expect to have survived.
  const keptForSearch = [...new Set([...listPinnedSearchSources(), ...listSearchOAuthCopies()])].sort();
  const message =
    keptForSearch.length > 0 ? (
      <Text>
        Successfully logged out.
        {'\n'}Web-search credentials pinned for {keptForSearch.join(', ')} were kept — remove them with /search-setting
        (D).
      </Text>
    ) : (
      <Text>Successfully logged out.</Text>
    );

  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);

  return message;
}
