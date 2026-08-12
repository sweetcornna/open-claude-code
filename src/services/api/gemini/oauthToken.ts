/**
 * Gemini OAuth credentials for the WebSearch "Gemini (Google OAuth)" source.
 *
 * One seam between the Antigravity OAuth flow (src/services/auth/antigravity/,
 * owned elsewhere — the two functions used here are its pinned contract) and
 * the search stack, so neither the leaf-package adapter nor the
 * /search-setting panel reaches into auth internals.
 *
 * `./oauth.js` rather than the barrel on the token path: the barrel re-exports
 * the login flow, which drags the callback server and browser launcher into
 * every search.
 */

import { existsSync } from 'fs'
import { getAntigravityAccessToken } from 'src/services/auth/antigravity/oauth.js'
import {
  antigravityAuthFilePath,
  removeAntigravityTokens,
} from 'src/services/auth/antigravity/store.js'
import { hasSearchOAuthCopy } from 'src/services/search/oauthCopies.js'

/** Access token for the connected Google account, or null when not connected. */
export async function getGeminiOAuthAccessToken(): Promise<string | null> {
  try {
    return (await getAntigravityAccessToken()) ?? null
  } catch {
    // A refresh failure reads as "not connected": the source drops out of the
    // aggregation instead of breaking the search.
    return null
  }
}

export async function isGeminiOAuthConnected(): Promise<boolean> {
  return (await getGeminiOAuthAccessToken()) !== null
}

/**
 * Sync credential probe — "is there a stored Google login this search can use".
 * Used by the synchronous search-source resolver, where an async read is not an
 * option; anything wrong with the token's contents surfaces when the search
 * runs.
 *
 * Counts WebSearch's own copy of the login as well as the login itself, and
 * that is a statement about who asks rather than a loosening: both callers are
 * on the search plane (`sourceCredentials.ts` and the `useAntigravity
 * WhenAvailable` branch of `usesAntigravityRoute`, which only non-main-loop
 * callers set). The main loop asks `isAntigravityAuthMode()` and
 * `getValidAntigravityAuth()`, neither of which knows the copy exists — so
 * `/logout` still logs the account out.
 */
export function hasGeminiOAuthCredentialsSync(): boolean {
  return existsSync(antigravityAuthFilePath()) || hasSearchOAuthCopy('gemini')
}

/**
 * Run the interactive Google login. Imported lazily: the login flow pulls in a
 * local callback server and the browser launcher, which no search path needs.
 *
 * The signal is the panel's cancel key: the flow parks on a local callback
 * listener until the browser comes back, and without a way out that wait is
 * unbounded — the user closes the consent tab and the row stays "logging in…"
 * for the rest of the session.
 */
export async function startGeminiOAuthLogin(
  signal?: AbortSignal,
): Promise<void> {
  const { startAntigravityOAuthLogin } = await import(
    'src/services/auth/antigravity/login.js'
  )
  await startAntigravityOAuthLogin(signal ? { signal } : {})
}

/**
 * Disconnect the Google account from the search stack.
 *
 * Only the stored OAuth tokens: `GEMINI_API_KEY` is the user's environment and
 * not ours to unset, so a source that stays connected after this is being held
 * up by that key — which is what /search-setting then says.
 */
export async function removeGeminiOAuthCredentials(): Promise<void> {
  await removeAntigravityTokens()
}
