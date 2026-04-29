/**
 * Shared mock for `src/utils/auth.js`. Use it via:
 *
 *   import { authMock } from '../../tests/mocks/auth'
 *   mock.module('src/utils/auth.js', authMock)
 *
 * Tests that need different return values can override the helper used by
 * the suite (e.g. by extending this object and re-registering with mock.module).
 * Always extend here rather than inlining a different shape per test, so the
 * surface stays consistent when `auth.ts` exports change.
 */
export const authMock = () => ({
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getClaudeAIOAuthTokens: () => ({ accessToken: 'token' }),
  isClaudeAISubscriber: () => true,
  isProSubscriber: () => false,
  isMaxSubscriber: () => false,
  isTeamSubscriber: () => false,
})
