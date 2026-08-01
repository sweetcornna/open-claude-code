/**
 * Which storage slot an MCP server's OAuth credentials live in.
 *
 * Historically the slot was `${serverName}|${sha256(type,url,headers)}` — a
 * function of the *client's* view of the server and nothing else. That is one
 * slot per configured server, so whichever authorization server most recently
 * issued tokens owns it. With a multi-tenant IdP that is a collision: the same
 * MCP URL can be fronted by different issuers over time (tenant migration, a
 * `WWW-Authenticate` challenge pointing somewhere new, an attacker-induced
 * mix-up), and tokens minted by one issuer would silently be presented to
 * another. MCP revision 2026-07-28 requires credentials to be keyed by issuer
 * so that cannot happen.
 *
 * The slot is therefore `${baseKey}|iss:${sha256(issuer)}` once the issuer is
 * known. The base key stays a prefix on purpose: it makes every slot belonging
 * to one configured server enumerable (for "clear auth", and for the migration
 * below) without keeping a separate index.
 *
 * The issuer is hashed rather than stored verbatim in the key because slots on
 * macOS live inside a single keychain blob written through `security -i`, which
 * caps a line at 4096 bytes — roughly 2KB of JSON for *all* servers (#30337).
 * A fixed 16 hex chars keeps the growth bounded.
 *
 * Pure by design (no storage, network, or logging imports) so the keying and
 * migration rules can be unit-tested directly. Same split as `oauthPort.ts`.
 */

import { createHash } from 'crypto'

/**
 * SEP-2352 issuer identity, mirroring the v2 SDK's own `issuersMatch`: exactly
 * one trailing `/` of difference names the same authorization server.
 *
 * The tolerance is not cosmetic. The SDK derives an issuer from
 * `metadata.issuer` when it has metadata and from `String(new URL(...))` — which
 * is always slash-suffixed — when it does not. Hashing the raw string would put
 * those two spellings in different slots and strand the credentials in
 * whichever one was written first.
 */
function normalizeIssuer(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer
}

/** Whether two issuer identifiers name the same authorization server. */
export function issuersEquivalent(a: string, b: string): boolean {
  return normalizeIssuer(a) === normalizeIssuer(b)
}

/**
 * Marks the issuer component of a slot key. Chosen so a base key can never
 * accidentally look issuer-scoped: a server name would have to contain this
 * literal string followed by 16 hex characters.
 */
const ISSUER_KEY_MARKER = '|iss:'

/**
 * The shape of a stored credential entry, as far as keying cares.
 *
 * `SecureStorageData` is `any` in this codebase, so this is the local, narrow
 * contract rather than a re-export.
 */
export type McpOAuthEntry = {
  serverName?: string
  serverUrl?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  clientId?: string
  clientSecret?: string
  stepUpScope?: string
  /**
   * The `issuer` from the authorization server's metadata that minted these
   * credentials. Written alongside the issuer-scoped key so a later session can
   * tell *which* issuer a legacy entry belongs to without re-deriving a hash,
   * and so the migration below has evidence to act on.
   */
  issuer?: string
  discoveryState?: {
    authorizationServerUrl?: string
    resourceMetadataUrl?: string
    resourceMetadata?: unknown
    authorizationServerMetadata?: unknown
  }
}

export type McpOAuthStore = Record<string, McpOAuthEntry>

/** The issuer-scoped slot for `baseKey` under `issuer`. */
export function issuerScopedKey(baseKey: string, issuer: string): string {
  const hash = createHash('sha256')
    .update(normalizeIssuer(issuer))
    .digest('hex')
    .substring(0, 16)
  return `${baseKey}${ISSUER_KEY_MARKER}${hash}`
}

/** Every slot belonging to one configured server, base key included. */
export function mcpOAuthKeysForServer(
  store: McpOAuthStore | undefined,
  baseKey: string,
): string[] {
  if (!store) {
    return []
  }
  const prefix = `${baseKey}${ISSUER_KEY_MARKER}`
  return Object.keys(store).filter(
    key => key === baseKey || key.startsWith(prefix),
  )
}

/**
 * Picks the slot to read from and write to.
 *
 * With a known issuer the answer is exact. Without one — the state at the top
 * of a session, before any metadata has been fetched — an existing
 * issuer-scoped slot is adopted so a restart does not look like "no
 * credentials" and force a needless re-auth.
 *
 * More than one issuer-scoped slot means the authorization server for this
 * exact server config changed at some point (different tenants would differ in
 * URL or headers and so land on different base keys). The most recently valid
 * one — greatest `expiresAt` — is the best available guess; if it turns out to
 * be the wrong one the request 401s, discovery names the real issuer, and the
 * next resolution is exact.
 */
export function resolveMcpOAuthKey(
  store: McpOAuthStore | undefined,
  baseKey: string,
  issuer: string | undefined,
): string {
  if (issuer) {
    return issuerScopedKey(baseKey, issuer)
  }

  const scoped = mcpOAuthKeysForServer(store, baseKey).filter(
    key => key !== baseKey,
  )
  if (scoped.length === 0) {
    return baseKey
  }
  if (scoped.length === 1) {
    return scoped[0] as string
  }

  return scoped.reduce((best, key) => {
    const bestExpiry = store?.[best]?.expiresAt ?? 0
    const keyExpiry = store?.[key]?.expiresAt ?? 0
    if (keyExpiry !== bestExpiry) {
      return keyExpiry > bestExpiry ? key : best
    }
    // Deterministic tie-break so two processes agree on the same slot.
    return key < best ? key : best
  })
}

/**
 * Folds a legacy base-keyed entry into the issuer-scoped slot, in place.
 *
 * This runs the moment an issuer becomes known, which is the only point where
 * the client can attribute existing credentials to anyone. Rules, in order:
 *
 * 1. The entry records a *different* issuer → it is not ours to claim. It is
 *    re-homed under its own issuer's slot (if that slot is free) so the user
 *    does not lose those tokens, and the newly-discovered issuer's slot is left
 *    untouched. This is the multi-tenant collision the spec is about.
 * 2. An issuer-scoped slot already exists for this issuer → the base entry is
 *    superseded legacy state. It is dropped rather than merged: keeping it
 *    would grow the credential blob forever against a hard 4096-byte ceiling
 *    (#30337).
 * 3. Otherwise (the entry names this issuer, or names none at all) → move it,
 *    stamping the issuer.
 *
 * Case 3's "names none at all" branch is the upgrade path: every entry written
 * before this change is unattributed, and there is no evidence to attribute it
 * with. Claiming it for the first issuer discovered is what preserves the
 * user's existing tokens, and it is safe in the only way that matters — if the
 * guess is wrong the token simply 401s, exactly as it would have before this
 * change, whereas refusing to migrate would sign every existing user out.
 *
 * @returns whether anything was mutated (i.e. whether a write is needed).
 */
export function migrateMcpOAuthKeying(
  store: McpOAuthStore,
  baseKey: string,
  issuer: string,
): boolean {
  const legacy = store[baseKey]
  if (!legacy) {
    return false
  }

  const targetKey = issuerScopedKey(baseKey, issuer)
  const recordedIssuer = legacy.issuer

  if (
    recordedIssuer !== undefined &&
    !issuersEquivalent(recordedIssuer, issuer)
  ) {
    const ownKey = issuerScopedKey(baseKey, recordedIssuer)
    delete store[baseKey]
    if (!store[ownKey]) {
      store[ownKey] = legacy
    }
    return true
  }

  if (store[targetKey]) {
    delete store[baseKey]
    return true
  }

  delete store[baseKey]
  store[targetKey] = { ...legacy, issuer }
  return true
}
