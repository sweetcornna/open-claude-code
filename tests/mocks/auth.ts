/**
 * Shared COMPLETE mock for `src/utils/auth/auth.js`.
 *
 * The real module is side-effectful when CALLED (macOS keychain reads, apiKey
 * helper subprocesses, AWS/GCP credential refresh), so unlike the pure-module
 * wrappers (tests/mocks/cron.ts) it must NOT delegate to the real
 * implementation — a test that forgot an override would silently hit the
 * user's keychain. Instead it follows tests/mocks/state.ts: hand-tuned safe
 * defaults below, every remaining real export auto-filled, per-file overrides
 * on top. Completeness matters because mock.module is process-global
 * last-write-wins: a hand-rolled PARTIAL auth mock in one file (e.g. only
 * `getClaudeAIOAuthTokens`) used to break every file that ran after it and
 * imported any other auth export ("Export named 'isClaudeAISubscriber' not
 * found" at load) — order-dependent, direction depends on Bun's file order.
 *
 * Usage:
 *   import { authMockWith } from '../../tests/mocks/auth.js'
 *   mock.module('src/utils/auth/auth.js', authMockWith({
 *     getClaudeAIOAuthTokens: () => ({ accessToken: 'my-token' }),
 *   }))
 *
 * Always register under the 'src/utils/auth/auth.js' specifier (never '.ts')
 * so all writers hit the same registry entry deliberately.
 * `authMock` (no overrides) is kept for existing consumers.
 */

import * as realAuth from 'src/utils/auth/auth.js'

function baseAuthMock() {
  return {
    // Mirrors the production contract: src/utils/auth.ts returns
    // Promise<boolean> ("did the access token change") and a token object that
    // carries scopes, subscriptionType, expiresAt, etc. Tests that branch on
    // these values must see the full shape so they can not silently drift away
    // from production.
    checkAndRefreshOAuthTokenIfNeeded: async () => false,
    getClaudeAIOAuthTokens: () => ({
      accessToken: 'token',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }),
    isClaudeAISubscriber: () => true,
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
    // Null-typed getters: the real signatures are `T | null`, and consumers
    // check `=== null` / pass the value onward — an auto-filled
    // `() => undefined` would be out of contract.
    getAnthropicApiKey: () => null,
    getSubscriptionType: () => null,
    getRateLimitTier: () => null,
    // Boolean gates default to "no API-key auth configured".
    hasAnthropicApiKeyAuth: () => false,
    isAnthropicAuthEnabled: () => false,
    removeClaudeAIOAuthTokens: () => ({ success: true }),
  }
}

/**
 * Complete-surface factory with per-file overrides. Real exports missing from
 * the hand-tuned base are auto-filled (functions -> () => undefined, values
 * copied), so a caller can never install a partial surface by accident.
 */
export function authMockWith(
  overrides: Record<string, unknown> = {},
): () => Record<string, unknown> {
  return () => {
    const base = baseAuthMock() as Record<string, unknown>
    const full: Record<string, unknown> = { ...base }
    for (const key of Object.keys(realAuth)) {
      if (key in full) continue
      const realValue = (realAuth as Record<string, unknown>)[key]
      full[key] = typeof realValue === 'function' ? () => undefined : realValue
    }
    return { ...full, ...overrides }
  }
}

export const authMock = authMockWith()
