/**
 * Google Antigravity OAuth constants.
 *
 * Every value here was read off a working implementation rather than guessed —
 * router-for-me/CLIProxyAPI, `internal/auth/antigravity/constants.go` (client
 * id/secret, scopes, endpoints, callback port) and
 * `internal/misc/antigravity_version.go` (the User-Agent trio). The Antigravity
 * backend fingerprints its callers, so the UA strings are part of the wire
 * contract, not cosmetics: `loadCodeAssist` and the generate endpoints want the
 * short IDE UA while `onboardUser` wants the long control-plane UA with the
 * Node client suffix.
 *
 * The OAuth client is a Google *installed application* client, so the secret is
 * not a secret in the confidential-client sense — it ships inside the
 * Antigravity IDE, and the token exchange requires it all the same.
 *
 * It is nonetheless supplied by the user rather than hardcoded here: GitHub's
 * secret scanner blocks any push containing a `GOCSPX-` string regardless of
 * the client type, and encoding it to slip past that check would be worse than
 * asking for it. Point OCC_ANTIGRAVITY_CLIENT_ID / OCC_ANTIGRAVITY_CLIENT_SECRET
 * at the Antigravity IDE's own installed-app client to enable this login.
 */

export function getAntigravityClientId(): string {
  return process.env.OCC_ANTIGRAVITY_CLIENT_ID ?? ''
}

export function getAntigravityClientSecret(): string {
  return process.env.OCC_ANTIGRAVITY_CLIENT_SECRET ?? ''
}

/** Whether an Antigravity OAuth login can even be attempted. */
export function hasAntigravityClientCredentials(): boolean {
  return getAntigravityClientId() !== '' && getAntigravityClientSecret() !== ''
}

export const ANTIGRAVITY_MISSING_CREDENTIALS_MESSAGE =
  'Antigravity login needs the IDE OAuth client: set OCC_ANTIGRAVITY_CLIENT_ID and OCC_ANTIGRAVITY_CLIENT_SECRET, then run /login again.'

/**
 * Port the Antigravity IDE registers for its loopback redirect. Google's
 * installed-app flow ignores the loopback port when matching, but the path
 * must match exactly, so keep '/oauth-callback' even if the port moves.
 */
export const ANTIGRAVITY_CALLBACK_PORT = 51121
export const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'

export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

export const ANTIGRAVITY_AUTH_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_USERINFO_ENDPOINT =
  'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'

/**
 * Cloud Code backends. Antigravity talks to the `daily-` host first and falls
 * back to prod; project discovery (`loadCodeAssist`) is served by prod while
 * `onboardUser` is served by daily. Preserved as-is from the reference client.
 */
export const ANTIGRAVITY_API_BASE_PROD = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_API_BASE_DAILY =
  'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_API_VERSION = 'v1internal'

/**
 * IDE version baked into the UA. The reference client refreshes this from
 * Antigravity's electron-builder manifest every six hours; occ pins the
 * fallback instead — a stale-but-valid version is accepted, and a background
 * version poll would mean a network call on every cold start.
 */
export const ANTIGRAVITY_IDE_VERSION = '2.2.1'
export const ANTIGRAVITY_IDE_PLATFORM = 'darwin/arm64'

/** Short UA: userinfo, loadCodeAssist, generate/stream, model listing. */
export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_IDE_VERSION} ${ANTIGRAVITY_IDE_PLATFORM}`
/** Long UA: onboardUser only (control plane). */
export const ANTIGRAVITY_ONBOARD_USER_AGENT = `${ANTIGRAVITY_USER_AGENT} google-api-nodejs-client/10.3.0`
/** X-Goog-Api-Client sent alongside the long UA on onboardUser. */
export const ANTIGRAVITY_GOOG_API_CLIENT = 'gl-node/22.21.1'

/** Metadata identifying occ as an Antigravity-class IDE to the backend. */
export const ANTIGRAVITY_IDE_TYPE = 'ANTIGRAVITY'
export const ANTIGRAVITY_IDE_NAME = 'antigravity'

/** Credential file inside occ's own config dir — never the Claude Code one. */
export const ANTIGRAVITY_AUTH_FILE = 'gemini-antigravity-auth.json'

/** Refresh this far ahead of expiry rather than waiting for a 401. */
export const ANTIGRAVITY_REFRESH_SKEW_MS = 5 * 60 * 1000
