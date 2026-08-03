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
import { antigravityAuthFilePath } from 'src/services/auth/antigravity/store.js'

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
 * Sync credential probe — "is there a stored Google login". Used by the
 * synchronous search-source resolver, where an async read is not an option;
 * anything wrong with the token's contents surfaces when the search runs.
 */
export function hasGeminiOAuthCredentialsSync(): boolean {
  return existsSync(antigravityAuthFilePath())
}

/**
 * Run the interactive Google login. Imported lazily: the login flow pulls in a
 * local callback server and the browser launcher, which no search path needs.
 */
export async function startGeminiOAuthLogin(): Promise<void> {
  const { startAntigravityOAuthLogin } = await import(
    'src/services/auth/antigravity/login.js'
  )
  await startAntigravityOAuthLogin()
}
